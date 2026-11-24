import {
  type PortfolioExecution,
  type PortfolioFill,
  type PortfolioInstrument,
  type PortfolioRequest,
  type runPortfolio,
} from "quant-backtest";
import { evaluateTrades, pairPositionCycles } from "quant-performance";
import { executionCostsForDate } from "trading-strategy-core/costs";
import { marketRules } from "trading-strategy-core/market-rules";
import { big, bpsOf, moneyMul, toNumber } from "trading-strategy-core/money";
import type { SleeveAttribution } from "./sleeve-attribution";

type PortfolioResult = ReturnType<typeof runPortfolio>;
type TradeLedger = Pick<PortfolioResult, "fills" | "corporateActions">;
type Curve = PortfolioResult["equity"];
type SleeveTarget = NonNullable<PortfolioRequest["sleeveTargets"]>[number];

const positionId = (fill: Pick<PortfolioFill, "strategyId" | "symbol">) =>
  JSON.stringify([fill.strategyId, fill.symbol]);
const session = (date: string) => date.slice(0, 10);

/** Keep independently funded positions distinct when two strategies trade the same symbol. */
export function pairSleevePositionCycles({
  fills,
  corporateActions,
}: TradeLedger) {
  return pairPositionCycles(
    fills.map((fill) => ({
      ...fill,
      date: session(fill.date),
      symbol: positionId(fill),
    })),
    corporateActions.map((action) => ({
      date: session(action.date),
      symbol: positionId(action),
      bonus: (action.quantity - action.before) / action.before,
      dividend: action.cash / action.before,
    })),
  ).map(({ symbol: key, ...cycle }) => {
    const [strategyId, symbol] = JSON.parse(key) as [string, string];
    return { ...cycle, strategyId, symbol };
  });
}

function quantile(sorted: readonly number[], fraction: number) {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  return (
    sorted[lower]! +
    (sorted[Math.ceil(index)]! - sorted[lower]!) * (index - lower)
  );
}

function protectiveSellReference(
  instrument: PortfolioInstrument,
  index: number,
  price: number,
  slippageBps: number,
) {
  const bar = instrument.bars[index]!;
  const input = instrument.execution;
  const execution =
    typeof input === "function"
      ? input(bar, instrument.bars[index - 1])
      : "evidence" in input
        ? (input as PortfolioExecution)
        : input[bar.date];
  if (!execution) return;
  if (execution.slippagePolicy === "none" || slippageBps === 0) return price;
  // A clamped protective sale at the low has multiple possible reference
  // prices. Everywhere else the portfolio quote's multiplicative slip can be inverted.
  if (execution.slippagePolicy === "clamp" && price === bar.low) return;
  return price / (1 - slippageBps / 10_000);
}

/** Total one-sided turnover = (buys + sells) / (2 × mean closing equity).
 * Costs cover all fills; only completed, actually traded cycles enter win/loss metrics. */
export function computeSleeveTradeMetrics(
  result: PortfolioResult,
  request: Pick<PortfolioRequest, "market" | "costs" | "instruments">,
) {
  const cycles = pairSleevePositionCycles(result);
  const orders = new Map(result.orders.map((order) => [order.id, order]));
  const days = new Map(result.equity.map(({ date }, index) => [date, index]));
  const instruments = new Map(
    request.instruments.map((instrument) => [
      instrument.symbol,
      {
        instrument,
        dates: new Map(instrument.bars.map(({ date }, index) => [date, index])),
      },
    ]),
  );
  const costs = request.costs ?? marketRules[request.market].costs!;
  const fees = result.fills.map((fill) => {
    const rates = executionCostsForDate(costs, fill.date);
    const notional = moneyMul(fill.quantity, fill.price);
    const commission = Math.max(
      rates.minimumCommission,
      bpsOf(notional, rates.commissionBps),
    );
    const stampDuty =
      fill.side === "sell" ? bpsOf(notional, rates.sellTaxBps) : 0;
    const transferFee = bpsOf(notional, rates.transferBps ?? 0);
    const calculated = toNumber(
      big(commission).plus(stampDuty).plus(transferFee),
    );
    if (
      Math.abs(calculated - fill.fee) >
      Number.EPSILON * Math.max(1, fill.fee)
    )
      throw new Error(`成交费用与冻结费率不符：${fill.orderId}`);
    const trigger = orders.get(fill.orderId)?.trigger;
    const opening =
      fill.side === "buy" || trigger === "signal" || trigger === "time";
    const source = instruments.get(fill.symbol);
    const index = source?.dates.get(fill.date);
    let reference = fill.executionEvidence?.intendedPrice;
    if (reference === undefined && source && index !== undefined) {
      if (opening) reference = source.instrument.bars[index]!.open;
      else if (trigger)
        reference = protectiveSellReference(
          source.instrument,
          index,
          fill.price,
          rates.slippageBps,
        );
    }
    return {
      sleeve: fill.sleeve,
      notional,
      commission,
      stampDuty,
      transferFee,
      slippage:
        reference === undefined
          ? null
          : toNumber(
              big(fill.price)
                .minus(reference)
                .times(fill.quantity)
                .times(fill.side === "buy" ? 1 : -1),
            ),
      totalFees: fill.fee,
    };
  });
  const sleeveByStrategy = new Map(
    result.fills.map((fill) => [fill.strategyId, fill.sleeve]),
  );
  function summarize(
    positions: typeof cycles,
    charges: typeof fees,
    equity: readonly Pick<Curve[number], "cash" | "equity">[],
  ) {
    const trade = evaluateTrades(positions);
    const holding = positions
      .flatMap(({ openedAt, closedAt }) => {
        if (closedAt === null) return [];
        const from = days.get(openedAt);
        const to = days.get(closedAt);
        if (from === undefined || to === undefined)
          throw new Error("闭合交易未落在组合交易日历内");
        return [to - from];
      })
      .sort((a, b) => a - b);
    const positiveEquity = equity.filter((row) => row.equity > 0);
    const avgEquity = equity.length
      ? equity.reduce((sum, row) => sum + row.equity, 0) / equity.length
      : 0;
    const sum = (
      field:
        | "commission"
        | "stampDuty"
        | "transferFee"
        | "slippage"
        | "totalFees"
        | "notional",
    ) => charges.reduce((total, row) => total + (row[field] ?? 0), 0);
    const slippageMissingFills = charges.filter(
      (row) => row.slippage === null,
    ).length;
    return {
      roundTrips: trade.closedTrades,
      winRate: trade.winRate.value,
      profitLossRatio: trade.payoffRatio.value,
      profitFactor: trade.profitFactor.value,
      holdingPeriod: {
        p25: quantile(holding, 0.25),
        p50: quantile(holding, 0.5),
        p75: quantile(holding, 0.75),
        p90: quantile(holding, 0.9),
      },
      cashRatio: positiveEquity.length
        ? positiveEquity.reduce((sum, row) => sum + row.cash / row.equity, 0) /
          positiveEquity.length
        : null,
      oneSidedTurnover:
        avgEquity > 0 ? sum("notional") / (2 * avgEquity) : null,
      costs: {
        commission: sum("commission"),
        stampDuty: sum("stampDuty"),
        transferFee: sum("transferFee"),
        slippage: slippageMissingFills ? null : sum("slippage"),
        slippageMissingFills,
        // Slippage is already reflected in the fill price, not in fill.fee.
        totalFees: sum("totalFees"),
      },
    };
  }
  const sleeveIds = result.equity[0]?.sleeves.map(({ id }) => id).sort() ?? [];
  return {
    portfolio: summarize(cycles, fees, result.equity),
    sleeves: sleeveIds.map((id) => ({
      id,
      ...summarize(
        cycles.filter((cycle) => sleeveByStrategy.get(cycle.strategyId) === id),
        fees.filter((fee) => fee.sleeve === id),
        result.equity.map((row) => {
          const sleeve = row.sleeves.find((s) => s.id === id);
          if (!sleeve) throw new Error(`分仓权益缺失 ${id} ${row.date}`);
          return sleeve;
        }),
      ),
    })),
  };
}

export type SleeveTradeMetrics = ReturnType<typeof computeSleeveTradeMetrics>;

function validateDailyCalendar(calendar: readonly string[]) {
  for (const [i, date] of calendar.entries()) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date ||
      (i > 0 && date <= calendar[i - 1]!)
    )
      throw new Error("分仓分配需要严格递增的日线交易日历");
  }
}

/** After the A-share close, submit targets for the next session's idle-cash transfer. */
function nextSleeveTarget(
  close: string,
  nextSession: string,
  shares: SleeveTarget["shares"],
): SleeveTarget {
  return {
    date: nextSession,
    availableAt: `${close}T15:00:00.001+08:00`,
    shares,
  };
}

/** Pass these targets with `rebalance: {}` for the isolated idle-cash control. */
export function buildMonthEndEqualRebalanceTargets(
  calendar: readonly string[],
  sleeveIds: readonly string[],
): SleeveTarget[] {
  validateDailyCalendar(calendar);
  if (
    !sleeveIds.length ||
    new Set(sleeveIds).size !== sleeveIds.length ||
    sleeveIds.includes("")
  )
    throw new Error("月末等权需要非空且唯一的分仓");
  const shares = Object.fromEntries(
    [...sleeveIds].sort().map((id) => [id, 1 / sleeveIds.length]),
  );
  return calendar.flatMap((close, i) => {
    const next = calendar[i + 1];
    return next && close.slice(0, 7) !== next.slice(0, 7)
      ? [nextSleeveTarget(close, next, shares)]
      : [];
  });
}

/** Causal policy updates use at most 60 completed sessions and keep each
 * ineligible sleeve's last policy share, including a currently all-cash sleeve. */
export function buildCausalRiskParity60Targets(
  calendar: readonly string[],
  attribution: {
    sleeves: readonly Pick<
      SleeveAttribution["sleeves"][number],
      "id" | "dailyInvestmentReturns"
    >[];
  },
  initialShares: SleeveTarget["shares"],
): SleeveTarget[] {
  validateDailyCalendar(calendar);
  const ids = attribution.sleeves.map(({ id }) => id).sort();
  if (
    !ids.length ||
    new Set(ids).size !== ids.length ||
    Object.keys(initialShares).length !== ids.length ||
    ids.some(
      (id) =>
        !Number.isFinite(initialShares[id]) ||
        initialShares[id]! < 0 ||
        initialShares[id]! > 1,
    ) ||
    Math.abs(ids.reduce((sum, id) => sum + initialShares[id]!, 0) - 1) > 1e-10
  )
    throw new Error("风险平价初始分仓权重无效");
  const bySleeve = new Map(
    attribution.sleeves.map(({ id, dailyInvestmentReturns }) => [
      id,
      new Map(dailyInvestmentReturns.map((row) => [row.date, row])),
    ]),
  );
  let shares = { ...initialShares };
  const targets: SleeveTarget[] = [];
  for (let i = 19; i < calendar.length - 1; i++) {
    const close = calendar[i]!;
    const window = calendar.slice(Math.max(0, i - 59), i + 1);
    const eligible = ids.flatMap((id) => {
      const series = bySleeve.get(id)!;
      if (!series.get(close)?.invested) return [];
      let count = 0,
        mean = 0,
        sumSquared = 0;
      for (const day of window) {
        const value = series.get(day)?.return;
        if (value == null || !Number.isFinite(value)) continue;
        const delta = value - mean;
        mean += delta / ++count;
        sumSquared += delta * (value - mean);
      }
      if (count < 20 || sumSquared <= 0) return [];
      const volatility = Math.sqrt(sumSquared / (count - 1));
      return Number.isFinite(volatility) && volatility > 0
        ? [{ id, volatility }]
        : [];
    });
    if (!eligible.length) continue;
    if (eligible.length === 1) {
      targets.push(nextSleeveTarget(close, calendar[i + 1]!, shares));
      continue;
    }
    const min = Math.min(...eligible.map((sleeve) => sleeve.volatility));
    const budget = eligible.reduce((sum, { id }) => sum + shares[id]!, 0);
    const scaled = eligible.map(({ id, volatility }) => ({
      id,
      weight: min / volatility,
    }));
    const total = scaled.reduce((sum, { weight }) => sum + weight, 0);
    shares = {
      ...shares,
      ...Object.fromEntries(
        scaled.map(({ id, weight }) => [id, (budget * weight) / total]),
      ),
    };
    targets.push(nextSleeveTarget(close, calendar[i + 1]!, shares));
  }
  return targets;
}

/** Overlay on an existing ranked-weekly sleeve, keeping selection/exit/sizing settings. */
export const weeklyRps20_50Control = {
  rank: { kind: "rps-composite" as const, periods: [20, 50] },
  rebalanceKind: "ranked-weekly" as const,
};
