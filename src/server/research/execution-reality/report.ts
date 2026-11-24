import {
  actionPrice,
  createPortfolioPreparation,
  runPortfolio,
  type PortfolioFill,
  type PortfolioQuoteProvider,
  type PortfolioRequest,
} from "quant-backtest";
import { resolveInstrumentRule } from "quant-execution";
import { dailyPerformance } from "~/lib/backtest/daily-performance";
import { equityDailyReturns } from "~/lib/backtest/multiple-testing";
import { researchExecutionCosts } from "trading-strategy-core/costs";
import { validateLocalDate } from "tstdx/local";
import { usageConfigHash } from "../research-config-hash";
import {
  executionWindows,
  type ExecutionRealityLc5,
  type ExecutionRealityMinuteFailure,
  type ExecutionRealitySliceEnd,
  type ExecutionRealityWindow,
} from "./lc5";

const capitals = [100_000, 300_000, 1_000_000] as const;
const matrixWindows = ["open", "09:35-09:40", "09:45-09:50"] as const;
const additionalWindows = ["10:00-10:05", "09:35-10:05"] as const;
const advLookback = 20;
const minimumCommission = 5;
const minimumCrisisDays = 5;

/** Explicit research event boundaries, inclusive in Shanghai trading dates. */
export const executionRealityCrises = [
  { id: "2015", start: "2015-06-12", end: "2015-09-15" },
  { id: "2018", start: "2018-01-29", end: "2018-12-28" },
  { id: "2022-24", start: "2022-01-04", end: "2024-02-05" },
  { id: "2024-09", start: "2024-09-24", end: "2024-10-18" },
] as const;

type FrozenTargets = NonNullable<PortfolioRequest["scheduledTargets"]>;
export type ExecutionRealityInput = {
  /** Hash of the caller's frozen daily input and template, including execution facts. */
  portfolioSourceHash: string;
  portfolio: Omit<
    PortfolioRequest,
    "initial" | "executionQuote" | "executionSlices" | "scheduledTargets"
  > & {
    scheduledTargets: FrozenTargets;
  };
  lc5?: readonly ExecutionRealityLc5[];
  /** Percentage points. 3 caps buy opens and executions at 3% above the prior
   * comparable close. Null disables the guard. */
  maxOpenGapPct?: number | null;
  impact?: {
    model: "sqrt" | "linear";
    /** Impact bps at 100% of prior ADV20; the template supplies fixed base bps. */
    coefficientBps: number;
  };
  /** Include the later single interval and six-interval VWAP, for each capital. */
  includeExtendedWindows?: boolean;
};

type QuoteRequest = Parameters<PortfolioQuoteProvider>[0];
type Impact = NonNullable<ExecutionRealityInput["impact"]>;
type Adv = { amount: number | null; dates: string[]; missingDates: string[] };
type AttemptReason =
  | ExecutionRealityMinuteFailure
  | "missing-daily-open"
  | "certified-suspension"
  | "missing-opening-reference"
  | "missing-execution-slice"
  | "missing-auction-planning-input"
  | "ambiguous-protection-chronology"
  | "max-open-gap-exceeded"
  | "missing-adv20";
type Attempt = {
  sequence: number;
  orderId: number;
  date: string;
  symbol: string;
  side: "buy" | "sell";
  phase: QuoteRequest["phase"];
  window: ExecutionRealityWindow;
  sliceEnd: string | null;
  parentOrderId: number | null;
  plannedQuantity: number | null;
  targetSourceHash: string | null;
  open: number | null;
  openingReference: { date: string; price: number } | null;
  openGapPct: number | null;
  buyPriceCeiling: number | null;
  gapTrigger: "opening-price" | "window-vwap" | "impacted-price" | null;
  rejectedPrice: number | null;
  rejectedQuantity: number | null;
  referencePrice: number | null;
  intervalEnd: string | null;
  intervalEnds: readonly string[];
  windowAmount: number | null;
  windowQuantity: number | null;
  windowVolumeUnit: "shares" | "fund-units" | null;
  adv20: Adv | null;
  status: "available" | "missing" | "rejected";
  reason: AttemptReason | null;
};
type ReportFill = PortfolioFill & {
  quote: Attempt;
  instrumentRule: ReturnType<typeof resolveInstrumentRule>;
  referenceNotional: number;
  advParticipation: number;
  modeledSlippageBps: number;
  realizedSlippageBps: number;
  minimumCommissionDrag: number;
  conditionalOnUncertainExecution: boolean;
};
type DailyPoint = {
  date: string;
  equity: number | null;
  cash: number | null;
  nav: number | null;
  dailyReturn: number | null;
  reason:
    | "unknown-execution"
    | "unknown-held-mark"
    | "missing-equity"
    | "outside-replay"
    | null;
};
type Result = ReturnType<typeof runPortfolio>;

const isPositive = (number: number | undefined): number is number =>
  number !== undefined && Number.isFinite(number) && number > 0;
const key = (orderId: number, date: string, phase: QuoteRequest["phase"]) =>
  `${orderId}\0${date}\0${phase}`;

function createDailySources(request: ExecutionRealityInput["portfolio"]) {
  const sessions = new Map(request.calendar.map((date, i) => [date, i]));
  const sources = new Map(
    request.instruments.map((instrument) => {
      const bars = new Map(instrument.bars.map((bar) => [bar.date, bar]));
      const suspensions = new Set(
        (instrument.certifiedSuspensions ?? [])
          .filter(
            ({ symbol, date, resumptionDate }) =>
              symbol === instrument.symbol &&
              Boolean(instrument.bars[0] && instrument.bars[0].date < date) &&
              date < resumptionDate &&
              resumptionDate <= request.end &&
              sessions.has(date) &&
              sessions.has(resumptionDate) &&
              isPositive(bars.get(resumptionDate)?.volume),
          )
          .map(({ date }) => date),
      );
      return [
        instrument.symbol,
        { instrument, bars, suspensions, advByDate: new Map<string, Adv>() },
      ] as const;
    }),
  );
  function priorAdv(symbol: string, date: string): Adv {
    const source = sources.get(symbol)!;
    const cached = source.advByDate.get(date);
    if (cached) return cached;
    const index = sessions.get(date)!;
    const dates = request.calendar.slice(
      Math.max(0, index - advLookback),
      index,
    );
    const missingDates: string[] = [];
    let amount = 0;
    for (const prior of dates) {
      const value = source.bars.get(prior)?.amount;
      if (isPositive(value)) amount += value / advLookback;
      else missingDates.push(prior);
    }
    const result = {
      amount:
        dates.length === advLookback &&
        missingDates.length === 0 &&
        isPositive(amount)
          ? amount
          : null,
      dates,
      missingDates,
    };
    source.advByDate.set(date, result);
    return result;
  }
  return { sources, priorAdv, sessions, calendar: request.calendar };
}

function openingReference(
  previous: QuoteRequest["previous"],
  date: string,
  instrument: PortfolioRequest["instruments"][number],
  suspensions: ReadonlySet<string>,
  calendar: readonly string[],
  sessionIndex: number,
) {
  if (!previous || previous.date >= date || !isPositive(previous.close))
    return null;
  let priorIndex = sessionIndex - 1;
  while (priorIndex >= 0 && suspensions.has(calendar[priorIndex]!))
    priorIndex--;
  if (previous.date !== calendar[priorIndex]) return null;
  const actions = instrument.actions
    ?.filter((action) => previous.date < action.date && action.date <= date)
    .sort((a, b) => a.date.localeCompare(b.date));
  const price = (actions ?? []).reduce(
    (close, action) => actionPrice(close, action),
    previous.close,
  );
  return isPositive(price) ? { date: previous.date, price } : null;
}

function priceImpact(participation: number, impact: Impact) {
  return (
    impact.coefficientBps *
    (impact.model === "sqrt" ? Math.sqrt(participation) : participation)
  );
}

function newAttempt(input: {
  order: QuoteRequest["order"];
  date: string;
  phase: QuoteRequest["phase"];
  window: ExecutionRealityWindow;
  sliceEnd?: string;
  open: number | null;
  prior?: Attempt["openingReference"];
  sequence: number;
}): Attempt {
  const { order, date, phase, window, sliceEnd, open, prior, sequence } = input;
  return {
    sequence,
    orderId: order.id,
    date,
    symbol: order.symbol,
    side: order.side,
    phase,
    window: phase === "opening" ? window : "open",
    sliceEnd: sliceEnd ?? null,
    parentOrderId: order.parentOrderId ?? null,
    plannedQuantity: order.plannedQuantity ?? null,
    targetSourceHash: order.targetSourceHash ?? null,
    open,
    openingReference: prior ?? null,
    openGapPct: open !== null && prior ? (open / prior.price - 1) * 100 : null,
    buyPriceCeiling: null,
    gapTrigger: null,
    rejectedPrice: null,
    rejectedQuantity: null,
    referencePrice: null,
    intervalEnd: null,
    intervalEnds: [],
    windowAmount: null,
    windowQuantity: null,
    windowVolumeUnit: null,
    adv20: null,
    status: "available",
    reason: null,
  };
}

function buildQuoteProvider(input: {
  window: ExecutionRealityWindow;
  minuteSources: ReadonlyMap<string, ExecutionRealityLc5>;
  dailySources: ReturnType<typeof createDailySources>;
  baseBps: number;
  impact: Impact;
  maxOpenGapPct: number | null;
  attempts: Map<string, Attempt>;
}): PortfolioQuoteProvider {
  return ({
    date,
    order,
    bar,
    previous,
    phase,
    reference,
    sliceEnd,
    standingProtection,
  }) => {
    const { symbol, side } = order;
    const { sources, sessions, calendar } = input.dailySources;
    const { instrument, suspensions } = sources.get(symbol)!;
    const window =
      phase === "opening" && order.drawdownReduction ? "open" : input.window;
    const open = isPositive(bar?.open) ? bar.open : null;
    const prior =
      phase === "opening"
        ? openingReference(
            previous,
            date,
            instrument,
            suspensions,
            calendar,
            sessions.get(date)!,
          )
        : null;
    const attempt = newAttempt({
      sequence: input.attempts.size,
      order,
      date,
      phase,
      window,
      sliceEnd,
      open,
      prior,
    });
    input.attempts.set(key(order.id, date, phase), attempt);
    const unavailable = (
      reason: AttemptReason,
      status: "missing" | "rejected" = "missing",
    ) => {
      attempt.status = status;
      attempt.reason = reason;
      return { reason };
    };
    const highOpen = "max-open-gap-exceeded" as const;
    const ambiguousProtection = () => ({
      ...unavailable("ambiguous-protection-chronology"),
      discard: true,
    });
    // Daily protection can affect close valuation, after the morning attempts.
    if (window !== "open" && phase === "protection")
      return ambiguousProtection();
    if (open === null)
      return suspensions.has(date)
        ? unavailable("certified-suspension", "rejected")
        : unavailable("missing-daily-open");
    if (phase === "opening" && side === "buy" && input.maxOpenGapPct !== null) {
      if (!prior) return unavailable("missing-opening-reference");
      attempt.buyPriceCeiling = prior.price * (1 + input.maxOpenGapPct / 100);
      if (open > attempt.buyPriceCeiling + 1e-10) {
        attempt.gapTrigger = "opening-price";
        attempt.rejectedPrice = open;
        return unavailable(highOpen, "rejected");
      }
    }

    let referencePrice = reference ?? open;
    let bounds =
      phase === "protection" && bar
        ? { low: bar.low, high: bar.high }
        : undefined;
    if (phase === "opening" && window !== "open") {
      const source = input.minuteSources.get(symbol);
      if (window === "09:35-10:05" && sliceEnd === undefined)
        return unavailable("missing-execution-slice");
      const minutes =
        sliceEnd === undefined
          ? source?.window(date, window)
          : source?.interval(date, sliceEnd as ExecutionRealitySliceEnd);
      if (!minutes) return unavailable("missing-minute-source");
      if (minutes.status === "unavailable") {
        attempt.intervalEnd = minutes.intervalEnd;
        return unavailable(minutes.reason);
      }
      if (
        standingProtection &&
        (standingProtection.stop > 0 || standingProtection.target !== null)
      ) {
        const end = sliceEnd as ExecutionRealitySliceEnd | undefined;
        const prefix = source?.prefixRange(
          date,
          end ?? executionWindows[window].at(-1)!,
        );
        // Never fall back to full-day OHLC when the morning prefix is incomplete;
        // afternoon extremes must not alter morning execution outcomes.
        if (!prefix) return ambiguousProtection();
        if (
          (standingProtection.stop > 0 &&
            Math.min(open, prefix.low) <= standingProtection.stop) ||
          (standingProtection.target !== null &&
            Math.max(open, prefix.high) >= standingProtection.target)
        )
          return ambiguousProtection();
      }
      referencePrice = minutes.referencePrice;
      bounds = { low: minutes.low, high: minutes.high };
      attempt.intervalEnds = minutes.intervalEnds;
      attempt.windowAmount = minutes.amount;
      attempt.windowQuantity = minutes.quantity;
      attempt.windowVolumeUnit = minutes.volumeUnit;
    }
    attempt.referencePrice = referencePrice;
    const ceiling = attempt.buyPriceCeiling;
    if (ceiling !== null && referencePrice > ceiling + 1e-10) {
      attempt.gapTrigger = "window-vwap";
      attempt.rejectedPrice = referencePrice;
      return unavailable(highOpen, "rejected");
    }
    const adv20 = input.dailySources.priorAdv(symbol, date);
    attempt.adv20 = adv20;
    if (adv20.amount === null) return unavailable("missing-adv20");
    const advAmount = adv20.amount;
    return {
      referencePrice,
      ...bounds,
      ...(attempt.windowQuantity !== null && {
        availableQuantity: attempt.windowQuantity,
      }),
      ...(ceiling !== null && {
        buyPriceCeiling: {
          price: ceiling,
          reason: highOpen,
          onRejected(price: number, quantity: number) {
            attempt.gapTrigger = "impacted-price";
            attempt.rejectedPrice = price;
            attempt.rejectedQuantity = quantity;
            unavailable(highOpen, "rejected");
          },
        },
      }),
      priceForQuantity: (quantity) => {
        const participation = (quantity * referencePrice) / advAmount;
        const bps = input.baseBps + priceImpact(participation, input.impact);
        return referencePrice * (1 + (side === "buy" ? bps : -bps) / 10_000);
      },
    };
  };
}

function dailyPoints(input: {
  sessions: readonly string[];
  result: Result;
  initial: number;
  firstUncertainExecutionDate: string | null;
  dailySources: ReturnType<typeof createDailySources>;
}): DailyPoint[] {
  const missingHeldMarks = new Set<string>();
  for (const position of input.result.positionSnapshots) {
    const source = input.dailySources.sources.get(position.symbol)!;
    if (
      position.quantity > 0 &&
      !source.suspensions.has(position.date) &&
      !isPositive(source.bars.get(position.date)?.close)
    )
      missingHeldMarks.add(position.date);
  }
  const byDate = new Map(
    input.result.equity.map((point) => [point.date, point]),
  );
  const equity = input.sessions.map((date) => {
    const value = byDate.get(date)?.equity;
    const reason =
      input.firstUncertainExecutionDate !== null &&
      date >= input.firstUncertainExecutionDate
        ? ("unknown-execution" as const)
        : missingHeldMarks.has(date)
          ? ("unknown-held-mark" as const)
          : value === undefined || !Number.isFinite(value) || value < 0
            ? ("missing-equity" as const)
            : null;
    return { reason, value: reason === null ? value! : NaN };
  });
  const returns = equityDailyReturns(equity, input.initial);
  return input.sessions.map((date, index) => {
    const { reason, value } = equity[index]!;
    return {
      date,
      equity: reason === null ? value : null,
      cash: reason === null ? (byDate.get(date)?.cash ?? null) : null,
      nav: reason === null ? value / input.initial : null,
      dailyReturn: returns[index]!,
      reason,
    };
  });
}

function crisisSlices(
  calendar: readonly string[],
  daily: readonly DailyPoint[],
) {
  const byDate = new Map(daily.map((point) => [point.date, point]));
  const missingPoint = (date: string) => ({
    date,
    equity: null,
    cash: null,
    nav: null,
    dailyReturn: null,
    reason: "outside-replay" as const,
  });
  return executionRealityCrises.map((period) => {
    const points = calendar
      .filter((date) => date >= period.start && date <= period.end)
      .map((date) => byDate.get(date) ?? missingPoint(date));
    const performance = dailyPerformance({
      returns: points.map((point) => point.dailyReturn),
    });
    const reason =
      points[0]?.date !== period.start || points.at(-1)?.date !== period.end
        ? "calendar-does-not-cover-window"
        : performance.coverage.nullDays
          ? "incomplete-daily-returns"
          : performance.coverage.availableDays < minimumCrisisDays
            ? "insufficient-observations"
            : null;
    return {
      ...period,
      points,
      coverage: performance.coverage,
      coveredDays: performance.coverage.availableDays,
      insufficientCoverage: reason !== null,
      periodReturn: reason === null ? performance.totalReturn.value : null,
      maxDrawdown: reason === null ? performance.maxDrawdown.value : null,
      performance: reason === null ? performance : null,
      reason,
    };
  });
}

function validateInput(input: ExecutionRealityInput) {
  const { portfolio } = input;
  if (
    portfolio.market !== "cn-equity" ||
    !/^[a-f0-9]{64}$/.test(input.portfolioSourceHash)
  )
    throw new Error("Execution reality requires frozen CNY portfolio evidence");
  if (
    portfolio.maxParticipation !== undefined ||
    portfolio.capacityPolicy !== undefined
  )
    throw new Error(
      "Daily realized capacity would leak today's amount into execution reality",
    );
  if (portfolio.externalCashFlows?.length)
    throw new Error(
      "Execution reality requires a fixed initial capital without external cash flows",
    );
  const scheduledStrategies = new Set(
    portfolio.scheduledTargets.map(({ strategyId }) => strategyId),
  );
  if (
    !scheduledStrategies.size ||
    portfolio.strategies.some(({ id }) => !scheduledStrategies.has(id))
  )
    throw new Error(
      "Execution reality requires an exclusive frozen target stream for each strategy",
    );
  validateLocalDate(portfolio.start);
  validateLocalDate(portfolio.end);
  for (const [i, date] of portfolio.calendar.entries()) {
    validateLocalDate(date);
    if (i > 0 && date <= portfolio.calendar[i - 1]!)
      throw new Error("Execution reality requires an ordered trading calendar");
  }
  for (const instrument of portfolio.instruments) {
    if (instrument.bars.some(({ date }) => date.length !== 10))
      throw new Error("Execution reality requires original daily bars");
  }
}

/** Rerun the exact same frozen targets with actual-size market rules and dated
 * fees, changing only initial capital and the execution window. */
export function buildExecutionRealityReport(
  input: ExecutionRealityInput,
  signal?: AbortSignal,
) {
  validateInput(input);
  const { portfolio } = input;
  const maxOpenGapPct =
    input.maxOpenGapPct === undefined ? 3 : input.maxOpenGapPct;
  if (
    maxOpenGapPct !== null &&
    (!Number.isFinite(maxOpenGapPct) || maxOpenGapPct < 0)
  )
    throw new Error(
      "maxOpenGapPct must be nonnegative percentage points or null",
    );
  const impact = input.impact ?? { model: "sqrt", coefficientBps: 50 };
  if (
    !["sqrt", "linear"].includes(impact.model) ||
    !Number.isFinite(impact.coefficientBps) ||
    impact.coefficientBps < 0
  )
    throw new Error("Invalid price impact model");
  const costs = {
    ...(portfolio.costs ?? researchExecutionCosts("cn-equity", "base")),
    minimumCommission,
  };
  const minuteSources = new Map(
    (input.lc5 ?? []).map((source) => [source.symbol, source]),
  );
  if (minuteSources.size !== (input.lc5?.length ?? 0))
    throw new Error("Duplicate frozen LC5 symbol");
  const dailySources = createDailySources(portfolio);
  const sessions = portfolio.calendar.filter(
    (date) => date >= portfolio.start && date <= portfolio.end,
  );
  const preparation = createPortfolioPreparation();
  function scenario(initial: number, window: ExecutionRealityWindow) {
    const attempts = new Map<string, Attempt>();
    const executionQuote = buildQuoteProvider({
      window,
      minuteSources,
      dailySources,
      baseBps: costs.slippageBps,
      impact,
      maxOpenGapPct,
      attempts,
    });
    const result = runPortfolio(
      {
        ...portfolio,
        initial,
        costs,
        executionQuote,
        executionSlices:
          window === "09:35-10:05" ? executionWindows[window] : undefined,
      },
      undefined,
      preparation,
      signal,
    );
    const orders = new Map(result.orders.map((order) => [order.id, order]));
    const rejections = result.rejections.map((rejection) => {
      const opening = attempts.get(
        key(rejection.orderId, rejection.date, "opening"),
      );
      const protection = attempts.get(
        key(rejection.orderId, rejection.date, "protection"),
      );
      let quote =
        [opening, protection].find(
          (attempt) => attempt?.reason === rejection.reason,
        ) ??
        protection ??
        opening ??
        null;
      // Staged sizing can fail at the auction before any child is defined.
      if (!quote && rejection.reason === "无法按开盘价冻结分笔数量") {
        const order = orders.get(rejection.orderId)!;
        const source = dailySources.sources.get(order.symbol)!;
        const open = source.bars.get(rejection.date)?.open ?? null;
        const suspended =
          open === null && source.suspensions.has(rejection.date);
        quote = newAttempt({
          order,
          date: rejection.date,
          phase: "opening",
          window,
          open,
          sequence: -1,
        });
        quote.status = suspended ? "rejected" : "missing";
        quote.reason = suspended
          ? "certified-suspension"
          : "missing-auction-planning-input";
        attempts.set(key(order.id, rejection.date, "opening"), quote);
      }
      return { ...rejection, quote };
    });
    const uncertainQuote =
      rejections.find(({ quote }) => quote?.status === "missing")?.quote ??
      null;
    const firstUncertainExecutionDate = uncertainQuote?.date ?? null;
    const fills: ReportFill[] = result.fills.map((fill) => {
      const quote = attempts.get(
        key(fill.orderId, fill.date, fill.windowPhase ?? "opening"),
      )!;
      const referencePrice = quote.referencePrice!;
      const referenceNotional = referencePrice * fill.quantity;
      const advParticipation = referenceNotional / quote.adv20!.amount!;
      const realizedSlippageBps =
        (fill.price / referencePrice - 1) *
        (fill.side === "buy" ? 1 : -1) *
        10_000;
      return {
        ...fill,
        quote,
        instrumentRule: resolveInstrumentRule(
          fill.symbol,
          fill.date,
          dailySources.sources.get(fill.symbol)!.instrument,
        ),
        referenceNotional,
        advParticipation,
        modeledSlippageBps:
          costs.slippageBps + priceImpact(advParticipation, impact),
        realizedSlippageBps,
        minimumCommissionDrag: Math.max(
          0,
          minimumCommission -
            (fill.quantity * fill.price * costs.commissionBps) / 10_000,
        ),
        conditionalOnUncertainExecution:
          uncertainQuote !== null &&
          (quote.date > uncertainQuote.date ||
            (quote.date === uncertainQuote.date &&
              quote.sequence > uncertainQuote.sequence)),
      };
    });
    const daily = dailyPoints({
      sessions,
      result,
      initial,
      firstUncertainExecutionDate,
      dailySources,
    });
    const last = daily.at(-1);
    const performance = dailyPerformance({
      returns: daily.map((point) => point.dailyReturn),
    });
    const completeDailyCoverage =
      performance.coverage.observedDays > 0 &&
      performance.coverage.nullDays === 0;
    return {
      initial,
      window,
      performance: completeDailyCoverage ? performance : null,
      dailyCoverage: performance.coverage,
      firstUncertainExecutionDate,
      daily,
      crisisSlices: crisisSlices(portfolio.calendar, daily),
      fills,
      rejections,
      executionCoverage: {
        requestedQuotes: attempts.size,
        availableQuotes: [...attempts.values()].filter(
          ({ status }) => status === "available",
        ).length,
        missingQuotes: [...attempts.values()].filter(
          ({ status }) => status === "missing",
        ).length,
        rejectedForHighOpen: rejections.filter(
          ({ reason }) => reason === "max-open-gap-exceeded",
        ).length,
      },
      finalCash: last?.cash ?? null,
      finalCashRatio:
        last && last.equity !== null && last.equity > 0 && last.cash !== null
          ? last.cash / last.equity
          : null,
      lotOrBudgetRejections: rejections.filter(({ reason }) =>
        /一手|最小数量|最小交易数量/.test(reason),
      ).length,
      totalFees: fills.reduce((sum, { fee }) => sum + fee, 0),
      minimumCommissionDrag: fills.reduce(
        (sum, fill) => sum + fill.minimumCommissionDrag,
        0,
      ),
    };
  }
  return {
    version: "execution-reality-1" as const,
    portfolioSourceHash: input.portfolioSourceHash,
    targetStreamHash: usageConfigHash(portfolio.scheduledTargets),
    targetCount: portfolio.scheduledTargets.length,
    lc5Sources: [...minuteSources.values()]
      .sort((a, b) => a.symbol.localeCompare(b.symbol))
      .map(({ symbol, sourceHash, volumeAuditHash, referenceYear }) => ({
        symbol,
        sourceHash,
        volumeAuditHash,
        referenceYear,
      })),
    assumptions: {
      maxOpenGapPct,
      impact,
      costs,
      costScenario: portfolio.costs
        ? "frozen-template"
        : "cn-equity-historical-research",
      earlyTransferFee: {
        default: "template-proportional-research-rate" as const,
        configuredShanghaiExchangeRuleRequiresFaceValue: true,
      },
      advLookback,
      minimumCrisisDays,
      maxOpenGapUnit: "percentage-points" as const,
      targetQuantityBasis:
        "auction-open-with-actual-window-fill-and-fees" as const,
      stagedAllocation:
        "equal-auction-lots-per-child-without-redistributing-missed-slices" as const,
      windowPrice: "CNY-per-share-or-fund-unit-vwap" as const,
    },
    matrix: capitals.flatMap((capital) =>
      matrixWindows.map((window) => scenario(capital, window)),
    ),
    additionalScenarios:
      input.includeExtendedWindows === false
        ? []
        : capitals.flatMap((capital) =>
            additionalWindows.map((window) => scenario(capital, window)),
          ),
  };
}

export type ExecutionRealityReport = ReturnType<
  typeof buildExecutionRealityReport
>;
