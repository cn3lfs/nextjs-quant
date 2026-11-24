import { computeTradeExcursions } from "quant-performance";
import { readSnapshot, readGbbq } from "tstdx/local";
import { researchExecutionCosts } from "trading-strategy-core/costs";
import type { PortfolioFill, runPortfolio } from "quant-backtest";
import {
  normalizeTradeDate,
  tradeFillsFromDiagnose,
} from "~/lib/chart/chart-trade-marks";
import {
  tradeReviewRefSchema,
  type ChartTradeReview,
  type TradeReviewBox,
  type TradeReviewFill,
  type TradeReviewRef,
} from "~/lib/chart/trade-review-ref";
import type { Bar } from "~/lib/domain";
import { reviewTrades } from "~/lib/portfolio/trade-review";
import type {
  StudioEtfRotationInput,
  StudioResult,
} from "~/lib/research/studio-result";
import { studioEtfRotationInputSchema } from "~/lib/research/studio-result";
import { readJobResultSnapshot } from "../db/job-results";
import { settings } from "../infra/settings";
import { background } from "../jobs/jobs";
import { fullLocalCalendarReference } from "../market/data-health";
import { loadAccountBook } from "../portfolio/account-workspace-service";
import { readDiagnoseArchive } from "../research/diagnose/archive";
import { runEtfRotationBacktest } from "../research/etf-rotation";
import { portfolioView } from "../research/studio/runners";

type Fill = TradeReviewFill & {
  orderId: number;
  strategyId: string;
  fee: number;
  holdingAfter: number;
};
type Action = Pick<
  ReturnType<typeof runPortfolio>["corporateActions"][number],
  "strategyId" | "symbol" | "date" | "cash"
>;
type Cycle = Pick<
  TradeReviewBox,
  | "entryDate"
  | "entryPrice"
  | "exitDate"
  | "exitPrice"
  | "pnlAmount"
  | "pnlPct"
  | "pnlReason"
  | "backHref"
  | "tradeIds"
> & { comparable: boolean };

const day = normalizeTradeDate;
const etfJobType = "etf-rotation-trade-review";
const dailyRangeNote = "原价日线极值含开平仓当日全日波动；无法区分成交前后。";

export function startEtfRotationReview(raw: StudioEtfRotationInput) {
  const draft = studioEtfRotationInputSchema.parse(raw);
  const root = settings().tdxRoot;
  return background(
    "backtest",
    { type: etfJobType, ...draft },
    async (job, signal) => {
      const run = await runEtfRotationBacktest(
        {
          config: draft.config,
          start: draft.start,
          end: draft.end,
          initial: draft.initial,
          costs: researchExecutionCosts("cn-equity", draft.costScenario),
          riskPolicy: draft.riskPolicy,
          source: { kind: "tdx", root },
          executionReality: draft.executionReality
            ? { includeExtendedWindows: false }
            : undefined,
        },
        signal,
      );
      const studio = portfolioView(
        draft.template,
        draft.costScenario,
        run.portfolio,
        run.backtest,
        signal,
      );
      studio.jobId = job.id;
      studio.disclosures.push(
        "固定 ETF 研究池存在选样偏差。跨境 ETF 使用已完成的境内人民币收盘价，溢折价及 IOPV 未观测。",
        run.data.calendarBasis,
        run.data.actionsSource,
      );
      if (run.executionReality) {
        const { matrix, targetStreamHash, portfolioSourceHash } =
          run.executionReality;
        studio.executionReality = {
          targetStreamHash,
          portfolioSourceHash,
          matrix: matrix.map((row) => ({
            initial: row.initial,
            window: row.window,
            totalReturn: row.performance?.totalReturn.value ?? null,
            maxDrawdown: row.performance?.maxDrawdown.value ?? null,
            fills: row.fills.length,
            requestedQuotes: row.executionCoverage.requestedQuotes,
            missingQuotes: row.executionCoverage.missingQuotes,
            firstUncertainExecutionDate: row.firstUncertainExecutionDate,
            totalFees: row.totalFees,
          })),
        };
        studio.disclosures.push("盘中窗口无独立审计的 LC5 量价证据。");
      } else if (draft.executionReality) {
        studio.disclosures.push(
          "研究窗口没有冻结调仓目标，无法计算九格执行现实。",
        );
      }
      const symbols = new Set(run.backtest.fills.map((fill) => fill.symbol));
      return {
        studio,
        fills: run.backtest.fills,
        orders: run.backtest.orders.map(({ id, trigger }) => ({ id, trigger })),
        actions: run.backtest.corporateActions,
        calendar: run.portfolio.calendar.filter(
          (date) => date >= draft.start && date <= draft.end,
        ),
        daily: run.portfolio.instruments
          .filter((instrument) => symbols.has(instrument.symbol))
          .map((instrument) => ({
            symbol: instrument.symbol,
            bars: instrument.bars.filter(
              (bar) => bar.date >= draft.start && bar.date <= draft.end,
            ),
          })),
      };
    },
  );
}

function isEtfReviewJob(job: { status: string; type: string }, type: unknown) {
  return (
    job.status === "completed" && job.type === "backtest" && type === etfJobType
  );
}

export function readEtfRotationReviewResult(id: string): StudioResult | null {
  return readJobResultSnapshot(id, ({ job, json }) =>
    isEtfReviewJob(job, json("$.input.type"))
      ? json<StudioResult>("$.result.studio")
      : null,
  );
}

function withTradeIds(
  ref: TradeReviewRef,
  fills: Iterable<
    Pick<
      Fill,
      | "symbol"
      | "date"
      | "side"
      | "price"
      | "quantity"
      | "fee"
      | "holdingAfter"
      | "strategyId"
      | "orderId"
      | "trigger"
    >
  >,
): Fill[] {
  const selected: Fill[] = [];
  let index = 0;
  for (const fill of fills) {
    if (fill.symbol === ref.symbol) {
      selected.push({
        ...fill,
        tradeId: `${ref.refId}:${ref.unitKey ?? ""}:${index}`,
        backHref: ref.backHref,
      });
    }
    index++;
  }
  return selected;
}

function researchEvidence(ref: TradeReviewRef) {
  return readJobResultSnapshot(ref.refId, ({ job, json, array }) => {
    const etf = ref.source === "etf-rotation";
    if (
      etf
        ? !isEtfReviewJob(job, json("$.input.type"))
        : job.type !== "backtest" ||
          job.status !== "completed" ||
          json("$.input.mode") !== "alpha-backtest"
    )
      return null;
    const prefix = etf ? "$.result" : "$.result.portfolio";
    const fills = withTradeIds(ref, array<PortfolioFill>(`${prefix}.fills`));
    if (fills.length) {
      attachOrderTriggers(
        fills,
        array<{
          id: number;
          trigger?: TradeReviewFill["trigger"];
        }>(`${prefix}.orders`),
      );
    }
    const actions = Array.from(
      array<Action>(etf ? "$.result.actions" : `${prefix}.corporateActions`),
    ).filter((action) => action.symbol === ref.symbol);
    const calendar = etf
      ? Array.from(array<string>("$.result.calendar"))
      : undefined;
    let bars: Bar[] | undefined;
    if (etf) {
      bars = [];
      for (const series of array<{ symbol: string; bars: Bar[] }>(
        "$.result.daily",
      )) {
        if (series.symbol !== ref.symbol) continue;
        bars = series.bars;
        break;
      }
    }
    return { fills, actions, calendar, bars };
  });
}

function attachOrderTriggers(
  fills: Fill[],
  orders: Iterable<{ id: number; trigger?: TradeReviewFill["trigger"] }>,
) {
  const requestedOrders = new Set(fills.map((fill) => fill.orderId));
  const orderById = new Map<number, TradeReviewFill["trigger"]>();
  for (const order of orders) {
    if (requestedOrders.has(order.id)) orderById.set(order.id, order.trigger);
  }
  for (const fill of fills) fill.trigger ??= orderById.get(fill.orderId);
}

/** Engine holdingAfter includes share changes and is scoped to a strategy. */
function engineCycles(
  fills: readonly Fill[],
  actions: readonly Action[],
  warnings: string[],
  hasActionCash = true,
) {
  const active = new Map<string, Fill[]>();
  const incomplete = new Set<string>();
  const cycles: Cycle[] = [];
  const ordered = [...fills].sort((a, b) => a.date.localeCompare(b.date));
  for (const fill of ordered) {
    const key = fill.strategyId;
    const round = active.get(key) ?? [];
    if (incomplete.has(key) || (!round.length && fill.side === "sell")) {
      if (!incomplete.has(key))
        warnings.push(`${day(fill.date)} 缺少开仓成交，跳过不完整回合`);
      if (fill.holdingAfter > 0) incomplete.add(key);
      else incomplete.delete(key);
      continue;
    }
    active.set(key, round);
    round.push(fill);
    if (fill.holdingAfter > 0) continue;
    active.delete(key);
    const entryDate = day(round[0]!.date),
      exitDate = day(fill.date);
    const events = actions.filter(
      (action) =>
        action.symbol === fill.symbol &&
        action.strategyId === key &&
        day(action.date) > entryDate &&
        day(action.date) <= exitDate,
    );
    let bought = 0,
      sold = 0,
      buyAmount = 0,
      sellAmount = 0,
      buyFees = 0,
      sellFees = 0;
    for (const trade of round) {
      if (trade.side === "buy") {
        bought += trade.quantity;
        buyAmount += trade.quantity * trade.price;
        buyFees += trade.fee;
      } else {
        sold += trade.quantity;
        sellAmount += trade.quantity * trade.price;
        sellFees += trade.fee;
      }
    }
    const comparable = !events.length && Math.abs(bought - sold) < 1e-8;
    const hasNetPnl = comparable || (hasActionCash && events.length > 0);
    const pnlAmount = hasNetPnl
      ? sellAmount -
        sellFees -
        buyAmount -
        buyFees +
        events.reduce((sum, event) => sum + event.cash, 0)
      : null;
    cycles.push({
      entryDate,
      exitDate,
      entryPrice: buyAmount / bought,
      exitPrice: sellAmount / sold,
      pnlAmount,
      pnlPct:
        pnlAmount === null ? null : (100 * pnlAmount) / (buyAmount + buyFees),
      pnlReason: hasNetPnl
        ? null
        : "回合份额发生变化，缺少可核对的公司行动现金流",
      comparable,
      backHref: fill.backHref,
      tradeIds: round.map((trade) => trade.tradeId),
    });
  }
  return cycles;
}

function accountTradeHref(
  ref: TradeReviewRef,
  tradeId: string,
  batchId: string,
) {
  return `/accounts?${new URLSearchParams({ tab: "trades", symbol: ref.symbol, trade: tradeId, batch: batchId })}`;
}

async function accountEvidence(ref: TradeReviewRef, warnings: string[]) {
  const book = await loadAccountBook(undefined, undefined, undefined, {
    localOnly: true,
  });
  const events = book.context
    .evidence(ref.symbol)
    .events.filter((event) => [1, 11, 12].includes(event.category));
  if (ref.source === "paper-account") {
    const id = ref.accountId ?? ref.refId;
    const paper = book.facts.paper.find(
      ({ account }) => account.id === id && account.market === "cn-equity",
    );
    if (!paper?.state) throw new Error("纸面账户成交证据不可用");
    const result = paper.state.result;
    const fills = withTradeIds(ref, result.fills).map((fill) => ({
      ...fill,
      tradeId: `paper:${id}:${fill.tradeId.slice(fill.tradeId.lastIndexOf(":") + 1)}`,
    }));
    attachOrderTriggers(fills, result.orders ?? []);
    return {
      fills,
      cycles: engineCycles(fills, result.corporateActions, warnings),
      bars: book.bars[ref.symbol],
    };
  }
  const selectedBatch = book.facts.batches.find(
    (batch) => batch.id === ref.refId,
  );
  const selectedTrade = book.facts.fills.find(
    (fill) =>
      `delivery:${fill.id}` === ref.refId &&
      (fill.symbol ?? fill.code) === ref.symbol,
  );
  const sourceAccount =
    selectedBatch?.account ?? selectedTrade?.account ?? ref.refId;
  const account = ref.accountId ?? sourceAccount;
  if (
    !book.facts.batches.some((batch) => batch.account === account) ||
    sourceAccount !== account
  )
    throw new Error("实盘交割单账户或批次不可用");
  const rows = book.facts.fills.filter(
    (fill) =>
      fill.account === account &&
      (fill.symbol ?? fill.code) === ref.symbol &&
      (fill.instrument === "stock" || fill.instrument === "fund") &&
      (fill.kind === "buy" || fill.kind === "sell"),
  );
  const fills = rows.map((fill): TradeReviewFill => {
    const tradeId = `delivery:${fill.id}`;
    return {
      symbol: ref.symbol,
      date: fill.tradeDate,
      side: fill.kind === "buy" ? "buy" : "sell",
      price: fill.price,
      quantity: fill.quantity,
      tradeId,
      backHref: accountTradeHref(ref, tradeId, fill.batchId),
    };
  });
  // Pair the whole account first. The matching side can be in another batch.
  const {
    movingAverage: { closedRounds },
  } = reviewTrades({
    fills: rows,
    cashFlows: book.facts.cashFlows.filter((flow) => flow.account === account),
  });
  const relevant = (index: number) => {
    if (selectedTrade) return rows[index]!.id === selectedTrade.id;
    return !selectedBatch || rows[index]!.batchId === selectedBatch.id;
  };
  const cycles = closedRounds.flatMap((round): Cycle[] => {
    const { openingDate, closingDate, buyAveragePrice, sellAveragePrice } =
      round;
    if (
      round.openingUnknown ||
      !openingDate ||
      !closingDate ||
      buyAveragePrice.value === null ||
      sellAveragePrice.value === null ||
      !round.fillIndices.some(relevant)
    )
      return [];
    const closingTrade = fills[round.fillIndices.at(-1)!]!;
    const comparable = !events.some(
      (event) => event.date > openingDate && event.date <= closingDate,
    );
    return [
      {
        entryDate: openingDate,
        exitDate: closingDate,
        entryPrice: buyAveragePrice.value,
        exitPrice: sellAveragePrice.value,
        pnlAmount: comparable ? round.netProfit.value : null,
        pnlPct:
          comparable && round.netReturn.value !== null
            ? 100 * round.netReturn.value
            : null,
        pnlReason: comparable
          ? round.netReturn.reason
          : "持仓跨除权，原价交割收益不可比较",
        comparable,
        backHref: closingTrade.backHref,
        tradeIds: round.fillIndices.map((index) => fills[index]!.tradeId),
      },
    ];
  });
  const linked = new Set(cycles.flatMap((cycle) => cycle.tradeIds));
  return {
    fills: fills.filter(
      (fill, index) => relevant(index) || linked.has(fill.tradeId),
    ),
    cycles,
    bars: book.bars[ref.symbol],
  };
}

async function labEvidence(ref: TradeReviewRef, warnings: string[]) {
  const archiveId = /^(lab|cli)-/.test(ref.refId)
    ? ref.refId
    : readJobResultSnapshot(ref.refId, ({ job, json }) =>
        job.type === "backtest" &&
        job.status === "completed" &&
        json("$.input.type") === "lab-diagnose"
          ? json<string>("$.result.archiveId")
          : null,
      );
  const archive =
    archiveId && (await readDiagnoseArchive(archiveId, { allCells: true }));
  if (!archive) throw new Error("诊断归档不可用");
  const eligible = archive.cells.flatMap((cell, index) =>
    cell.symbols.includes(ref.symbol)
      ? cell.scenarios.map((scenario) => ({
          key: `${index}:${scenario.scenarioId}`,
          scenario,
        }))
      : [],
  );
  const selected = ref.unitKey
    ? eligible.find((row) => row.key === ref.unitKey)
    : eligible.length === 1
      ? eligible[0]
      : undefined;
  if (!selected)
    throw new Error("请指定复盘单元 unitKey（零基单元索引:情景 ID）");
  const { scenario } = selected;
  const marks = tradeFillsFromDiagnose({
    sampleFills: scenario.fullFills ?? scenario.sampleFills,
    sampleOrders: scenario.sampleOrders,
  });
  const fills = withTradeIds(
    { ...ref, unitKey: selected.key },
    (scenario.fullFills ?? scenario.sampleFills).map((fill, index) => ({
      ...fill,
      trigger: marks[index]?.trigger,
    })),
  );
  if (
    !scenario.fullFills &&
    scenario.sampleFills.length !== scenario.counts.fills
  ) {
    warnings.push("归档只包含样本成交，无法确认完整持仓回合");
    return { fills, cycles: [] };
  }
  const cycles = engineCycles(fills, [], warnings, false);
  return { fills, cycles };
}

export async function loadChartTradeReview(
  raw: TradeReviewRef,
): Promise<ChartTradeReview> {
  const ref = tradeReviewRefSchema.parse(raw);
  const warnings = [dailyRangeNote];
  let fills: TradeReviewFill[],
    cycles: Cycle[],
    bars: Bar[] | undefined,
    calendar: string[] | undefined;
  if (ref.source === "lab-diagnose") {
    ({ fills, cycles } = await labEvidence(ref, warnings));
  } else if (ref.source === "paper-account" || ref.source === "real-delivery") {
    ({ fills, cycles, bars } = await accountEvidence(ref, warnings));
  } else {
    const evidence = researchEvidence(ref);
    if (!evidence) throw new Error("已完成的回测逐笔证据不可用");
    ({ fills, bars, calendar } = evidence);
    cycles = engineCycles(evidence.fills, evidence.actions, warnings);
  }
  if (!cycles.length)
    return {
      ref,
      adjustment: "none",
      fills: fills.map(publicFill),
      boxes: [],
      warnings,
    };

  const config =
    calendar && bars && ref.source === "etf-rotation" ? null : settings();
  if (config) {
    const [barResult, reference, actions] = await Promise.all([
      bars === undefined
        ? readSnapshot(config.tdxRoot, ref.symbol, "day", {
            chartFunds: true,
          }).catch(() => null)
        : null,
      calendar === undefined
        ? fullLocalCalendarReference(config.tdxRoot, config.calendar).catch(
            () => null,
          )
        : null,
      readGbbq(config.tdxRoot).catch(() => null),
    ]);
    bars ??= barResult?.bars;
    calendar ??= reference?.days;
    if (!actions) warnings.push("本地 GBBQ 不可读，除权证据覆盖未知。");
    const events = (actions?.events.get(ref.symbol) ?? []).filter((event) =>
      [1, 11, 12].includes(event.category),
    );
    for (const cycle of cycles) {
      if (
        !events.some(
          (event) =>
            event.date > cycle.entryDate && event.date <= cycle.exitDate,
        )
      )
        continue;
      cycle.comparable = false;
      if (ref.source === "lab-diagnose" || ref.source === "real-delivery") {
        cycle.pnlAmount = cycle.pnlPct = null;
        cycle.pnlReason = "持仓跨除权，缺少可核对的公司行动现金流";
      }
    }
  }
  const prices = bars ?? [];
  const byDate = new Map(prices.map((bar) => [bar.date, bar]));
  const inputs = cycles.map((cycle, index) => ({
    id: String(index),
    symbol: ref.symbol,
    openedAt: cycle.entryDate,
    closedAt: cycle.exitDate,
    entryAverage: cycle.comparable ? cycle.entryPrice : null,
    expectedHoldingSessions: calendar?.filter(
      (date) => date >= cycle.entryDate && date <= cycle.exitDate,
    ),
  }));
  const excursions = computeTradeExcursions(inputs, { [ref.symbol]: prices });
  const boxes = cycles
    .map(({ comparable, ...cycle }, index): TradeReviewBox => {
      const result = excursions[index]!;
      let lowest: Bar | undefined, highest: Bar | undefined;
      if (result.reason === null) {
        for (const date of inputs[index]!.expectedHoldingSessions!) {
          const bar = byDate.get(date)!;
          if (!lowest || bar.low < lowest.low) lowest = bar;
          if (!highest || bar.high > highest.high) highest = bar;
        }
      }
      return {
        ...cycle,
        maePct: result.mae === null ? null : 100 * result.mae,
        mfePct: result.mfe === null ? null : 100 * result.mfe,
        maeDate: result.mae === 0 ? null : (lowest?.date ?? null),
        maePrice: result.mae === 0 ? null : (lowest?.low ?? null),
        mfeDate: result.mfe === 0 ? null : (highest?.date ?? null),
        mfePrice: result.mfe === 0 ? null : (highest?.high ?? null),
        holdingDays: result.days,
        excursionReason: comparable
          ? result.reason
          : "持仓价格跨公司行动或份额无法配平，原价极值不可比较",
      };
    })
    .sort((a, b) => a.entryDate.localeCompare(b.entryDate));
  return {
    ref,
    adjustment: "none",
    fills: fills.map(publicFill),
    boxes,
    warnings,
  };
}

function publicFill({
  symbol,
  date,
  side,
  price,
  quantity,
  orderId,
  trigger,
  tradeId,
  backHref,
}: TradeReviewFill): TradeReviewFill {
  return {
    symbol,
    date: day(date),
    side,
    price,
    quantity,
    orderId,
    trigger,
    tradeId,
    backHref,
  };
}
