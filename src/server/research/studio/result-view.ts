import {
  computeTradeExcursions,
  evaluatePerformance,
  topDrawdownEpisodes,
  type PerformancePoint,
  type TradeExcursion,
  type TradeExcursionInput,
  type TradeExcursionBarsBySymbol,
} from "quant-performance";
import {
  researchCostScenarios,
  type ResearchCostScenario,
} from "trading-strategy-core/costs";
import type { runPortfolio } from "quant-backtest";
import type {
  StudioResult,
  StudioTemplateKind,
} from "~/lib/research/studio-result";

type Ledger = ReturnType<typeof runPortfolio>;
type Fill = Pick<
  Ledger["fills"][number],
  | "date"
  | "strategyId"
  | "symbol"
  | "price"
  | "fee"
  | "quantity"
  | "holdingAfter"
  | "side"
> & { sleeve?: string };
type Action = Pick<
  Ledger["corporateActions"][number],
  "date" | "strategyId" | "symbol" | "cash"
>;
const keyOf = (r: { strategyId: string; symbol: string }) =>
  JSON.stringify([r.strategyId, r.symbol]);

/** Fills carry the engine's post-action holding, including splits. Track each
 * strategy independently even when two sleeves hold the same symbol. */
export function ledgerExcursions(
  fills: readonly Fill[],
  actions: readonly Action[],
  calendar: readonly string[],
  bars: TradeExcursionBarsBySymbol,
) {
  const sessions = [...new Set(calendar.map((d) => d.slice(0, 10)))];
  const active = new Map<
    string,
    {
      openedAt: string;
      quantity: number;
      notional: number;
      outlay: number;
      cash: number;
      comparable: boolean;
    }
  >();
  const cycles: TradeExcursionInput[] = [];
  const closures: { strategyId: string; sleeve?: string }[] = [];
  let nextAction = 0;
  for (const fill of fills) {
    const date = fill.date.slice(0, 10);
    while (
      nextAction < actions.length &&
      actions[nextAction]!.date.slice(0, 10) <= date
    ) {
      const action = actions[nextAction++]!;
      const position = active.get(keyOf(action));
      if (position) {
        // The portfolio ledger models no rights subscriptions. Splits change
        // share counts, while cash distributions enter net P&L as recorded.
        position.cash += action.cash;
        // Raw highs and lows straddling an ex-date are on different bases.
        position.comparable = false;
      }
    }
    const key = keyOf(fill);
    let pos = active.get(key);
    if (!pos) {
      if (fill.side !== "buy") throw new Error("回合缺少开仓成交");
      pos = {
        openedAt: date,
        quantity: 0,
        notional: 0,
        outlay: 0,
        cash: 0,
        comparable: true,
      };
      active.set(key, pos);
    }
    const notional = fill.quantity * fill.price;
    if (fill.side === "buy") {
      pos.quantity += fill.quantity;
      pos.notional += notional;
      pos.outlay += notional + fill.fee;
      pos.cash -= notional + fill.fee;
    } else pos.cash += notional - fill.fee;
    if (fill.holdingAfter !== 0) continue;
    cycles.push({
      id: JSON.stringify([fill.strategyId, fill.symbol, cycles.length + 1]),
      symbol: fill.symbol,
      openedAt: pos.openedAt,
      closedAt: date,
      entryAverage: pos.comparable ? pos.notional / pos.quantity : null,
      realizedNetReturn: pos.cash / pos.outlay,
      expectedHoldingSessions: sessions.filter(
        (d) => d >= pos.openedAt && d <= date,
      ),
    });
    closures.push({ strategyId: fill.strategyId, sleeve: fill.sleeve });
    active.delete(key);
  }
  return computeTradeExcursions(cycles, bars).map((row, i) => ({
    ...row,
    ...closures[i]!,
  }));
}
export function summarizeExcursions(rows: readonly TradeExcursion[]) {
  function quantile(values: number[], q: number) {
    if (!values.length) return null;
    values.sort((a, b) => a - b);
    const i = (values.length - 1) * q;
    return (
      values[Math.floor(i)]! +
      (i % 1) * (values[Math.ceil(i)]! - values[Math.floor(i)]!)
    );
  }
  const adverse = rows.flatMap((r) => (r.mae === null ? [] : [r.mae])),
    favorable = rows.flatMap((r) => (r.mfe === null ? [] : [r.mfe]));
  return {
    count: rows.length,
    missing: rows.length - adverse.length,
    maeMedian: quantile(adverse, 0.5),
    maeP10: quantile(adverse, 0.1),
    mfeMedian: quantile(favorable, 0.5),
    mfeP90: quantile(favorable, 0.9),
  };
}
export function emptyStudioResult(template: StudioTemplateKind): StudioResult {
  return {
    version: "studio-result-v1",
    template,
    jobId: null,
    archiveId: null,
    strategyKey: null,
    symbols: [],
    costScenario: null,
    performance: null,
    equity: null,
    totalReturn: null,
    maxDrawdown: null,
    costScenarios: researchCostScenarios.map((costScenario) =>
      unavailableCostRow(costScenario, "缺少该成本情景的独立回放"),
    ),
    executionReality: null,
    timeHoldout: null,
    sleeveAttribution: null,
    familyHoldout: null,
    topDrawdowns: null,
    tradeExcursions: null,
    excursionDistribution: null,
    cases: [],
    disclosures: [],
  };
}
export function costRow(
  costScenario: ResearchCostScenario,
  initial: number,
  equity: readonly PerformancePoint[],
  fills: readonly { fee: number }[],
) {
  const perf = evaluatePerformance(initial, equity);
  return {
    costScenario,
    totalReturn: perf.totalReturn.value,
    maxDrawdown: perf.maxDrawdown.value,
    fills: fills.length,
    totalFees: fills.reduce((n, row) => n + row.fee, 0),
    reason: perf.totalReturn.reason,
  };
}
export function unavailableCostRow(
  costScenario: ResearchCostScenario,
  reason: string,
) {
  return {
    costScenario,
    totalReturn: null,
    maxDrawdown: null,
    totalFees: null,
    fills: null,
    reason,
  };
}
export function performanceView(
  initial: number,
  equity: PerformancePoint[],
  tradeExcursions: TradeExcursion[],
) {
  const performance = evaluatePerformance(initial, equity);
  return {
    performance,
    equity,
    totalReturn: performance.totalReturn.value,
    maxDrawdown: performance.maxDrawdown.value,
    topDrawdowns: topDrawdownEpisodes(initial, equity),
    tradeExcursions,
    excursionDistribution: summarizeExcursions(tradeExcursions),
  };
}
export const dailyRangeDisclosure =
  "MAE/MFE 取开平仓日及其间完整交易日的原价高低区间，首尾日极值可能位于成交前后。价格基准跨公司行动无法核实时留空。";
