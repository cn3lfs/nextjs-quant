import {
  runPortfolio,
  type PortfolioInstrument,
  type PortfolioRequest,
} from "quant-backtest";
import { validateLocalDate } from "tstdx/local";
import { completedBarFilter } from "trading-strategy-core/completed-bars";
import {
  executionCostsSchema,
  researchExecutionCosts,
} from "trading-strategy-core/costs";
import {
  etfRotationUniverseFor,
  generateEtfRotationTargets,
  type EtfRotationConfig,
  type EtfRotationInstrument,
  type EtfRotationSchedule,
  type StrategyObjectInput,
} from "trading-strategies";
import { causalResearchPrices } from "../causal-price-basis";
import { researchCorporateActions } from "../corporate-actions";
import {
  buildExecutionRealityReport,
  type ExecutionRealityInput,
  type ExecutionRealityReport,
} from "../execution-reality";
import { usageConfigHash } from "../research-config-hash";
import {
  loadEtfRotationMarketData,
  type EtfRotationDataSource,
} from "./market-data";

export type {
  EtfRotationDailySource,
  EtfRotationDataSource,
  EtfRotationMarketData,
} from "./market-data";

export type EtfRotationBacktestRequest = Readonly<{
  config: EtfRotationConfig;
  initial: number;
  start: string;
  /** Inclusive completed Shanghai session. */
  end: string;
  /** Epoch milliseconds for the Shanghai close cutoff. Defaults to Date.now(). */
  now?: number;
  source?: EtfRotationDataSource;
  universe?: readonly EtfRotationInstrument[];
  costs?: PortfolioRequest["costs"];
  /** Supplying a policy enables the account risk overlay. */
  riskPolicy?: PortfolioRequest["riskPolicy"];
  /** Supplying options runs the matrix; the reusable input is returned either way. */
  executionReality?: Omit<
    ExecutionRealityInput,
    "portfolio" | "portfolioSourceHash"
  >;
}>;

export type EtfRotationBacktestResult = Readonly<{
  schedule: EtfRotationSchedule;
  portfolio: Readonly<PortfolioRequest>;
  portfolioSourceHash: string;
  backtest: ReturnType<typeof runPortfolio>;
  executionRealityInput: ExecutionRealityInput | null;
  executionReality: ExecutionRealityReport | null;
  data: Readonly<{
    source: EtfRotationDataSource["kind"];
    calendarBasis: string;
    actionsSource: string;
    universeBasis: "fixed-research-selection";
    executionPrice: "unadjusted-domestic-cny";
    exchangeLimits: "provided-facts-only";
    coverage: readonly {
      symbol: string;
      firstBar: string | null;
      lastBar: string | null;
      missingAmountDays: number;
    }[];
  }>;
}>;

function freezeTree<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

export async function runEtfRotationBacktest(
  request: EtfRotationBacktestRequest,
  signal?: AbortSignal,
): Promise<EtfRotationBacktestResult> {
  const { start, end, initial, now = Date.now() } = request;
  validateLocalDate(start);
  validateLocalDate(end);
  if (start > end || !Number.isFinite(initial) || initial <= 0)
    throw new Error("Invalid ETF rotation backtest range or capital");

  const universe = etfRotationUniverseFor(request.config, request.universe);
  const source = request.source ?? { kind: "tdx" };
  const market = await loadEtfRotationMarketData(source, universe, end, signal);
  const completed = completedBarFilter("day", now);
  const completedCalendar = market.calendar.filter(completed);
  const latestCompleted = completedCalendar.at(-1);
  if (!latestCompleted)
    throw new Error("ETF rotation requires at least one completed session");
  if (end > latestCompleted)
    throw new Error(
      `ETF rotation end ${end} is later than the latest completed session ${latestCompleted}`,
    );
  const calendar = Object.freeze(
    completedCalendar.filter((date) => date <= end),
  );
  // The next session date identifies month-end even while that session is open.
  const next = market.calendar.find((date) => date > end);
  if (calendar.at(-1) !== end || !market.actionsSource.trim())
    throw new Error(
      "ETF rotation requires a completed end session and GBBQ evidence",
    );

  const instruments: readonly PortfolioInstrument[] = Object.freeze(
    universe.map((etf) => {
      const { symbol } = etf;
      const series = market.series[symbol];
      if (!series) throw new Error("Missing ETF source: " + symbol);
      const bars = series.bars
        .filter(
          (bar) => completed(bar.date) && bar.date <= end && bar.volume !== 0,
        )
        .map((bar) => Object.freeze({ ...bar }));
      const adjusted = bars.length
        ? causalResearchPrices(bars, series.events, market.actionsSource, [])
        : null;
      const actions = bars.length
        ? researchCorporateActions(
            series.events,
            market.actionsSource,
            bars[0]!.date,
            end,
          )
        : [];
      const signalBars = Object.freeze(
        (adjusted?.bars ?? []).map((bar) => Object.freeze(bar)),
      );
      const execution = Object.freeze(
        Object.fromEntries(
          bars.map(({ date, volume }) => [
            date,
            Object.freeze({
              evidence:
                "Raw ETF daily replay; no verified historical exchange limits or queue",
              limitUp: null,
              limitDown: null,
              ...series.execution?.[date],
              tradable:
                volume > 0 && (series.execution?.[date]?.tradable ?? true),
            }),
          ]),
        ),
      );
      return Object.freeze({
        symbol,
        market: "cn-equity",
        industry: etf.indexGroup,
        bars: Object.freeze(bars),
        signalBars,
        actions: Object.freeze(actions.map((action) => Object.freeze(action))),
        execution,
      } satisfies PortfolioInstrument);
    }),
  );

  const schedule = await generateEtfRotationTargets(request.config, {
    start,
    end,
    calendar: next ? [...calendar, next] : calendar,
    universe,
    priceBasis: "gbbq-first-raw-anchor-1",
    closes: Object.fromEntries(
      instruments.map(({ symbol, signalBars }) => [symbol, signalBars]),
    ),
  });
  signal?.throwIfAborted();
  const sleeve = "etf-rotation";
  const strategy = {
    id: schedule.config.strategyId,
    version: 1,
    market: "cn-equity",
    period: "day",
    universe: {
      kind: "symbols",
      symbols: universe.map(({ symbol }) => symbol),
    },
    entry: { kind: "constant", value: false },
    exit: { rule: { kind: "constant", value: false } },
    sizing: { kind: "weight", weight: 1 },
    sleeve,
  } satisfies StrategyObjectInput;
  const accountMaxSymbolWeight =
    schedule.config.strategyId === "etf-risk-budget"
      ? schedule.config.maxEtfWeight
      : undefined;
  const riskPolicy = request.riskPolicy && {
    maxEtfWeight: accountMaxSymbolWeight ?? 1,
    // ETF index groups are sizing buckets. The stock sector default would
    // otherwise bind even for a single diversified broad or treasury fund.
    maxIndustryWeight: 1,
    ...request.riskPolicy,
  };
  const template = freezeTree({
    market: "cn-equity",
    start,
    end,
    calendar,
    instruments,
    strategies: [strategy],
    sleeves: [
      { id: sleeve, share: 1, riskPerTrade: 1, maxPositions: universe.length },
    ],
    costs: request.costs
      ? executionCostsSchema.parse(request.costs)
      : researchExecutionCosts("cn-equity", "base"),
    riskPolicy,
    accountMaxSymbolWeight,
    scheduledTargets: schedule.scheduledTargets,
  } satisfies ExecutionRealityInput["portfolio"]);
  const data = freezeTree({
    source: source.kind,
    calendarBasis: market.calendarBasis,
    actionsSource: market.actionsSource,
    universeBasis: "fixed-research-selection",
    executionPrice: "unadjusted-domestic-cny",
    exchangeLimits: "provided-facts-only",
    coverage: instruments.map(({ symbol, bars }) => ({
      symbol,
      firstBar: bars[0]?.date ?? null,
      lastBar: bars.at(-1)?.date ?? null,
      missingAmountDays: bars.filter(({ amount }) => amount === 0).length,
    })),
  } as const);
  const portfolioSourceHash = usageConfigHash([template, data]);
  const portfolio = Object.freeze({
    ...template,
    initial,
  } satisfies PortfolioRequest);
  const executionRealityInput = schedule.scheduledTargets.length
    ? {
        includeExtendedWindows: false,
        ...request.executionReality,
        portfolio: template,
        portfolioSourceHash,
      }
    : null;
  return {
    schedule,
    portfolio,
    portfolioSourceHash,
    backtest: runPortfolio(portfolio, undefined, undefined, signal),
    executionRealityInput,
    executionReality:
      request.executionReality && executionRealityInput
        ? buildExecutionRealityReport(executionRealityInput, signal)
        : null,
    data,
  };
}
