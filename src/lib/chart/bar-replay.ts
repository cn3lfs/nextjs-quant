import { z } from "zod";
import { researchDateSchema } from "trading-strategies/research/contracts/date";
import {
  executionCostsForInstrument,
  researchExecutionCosts,
} from "trading-strategy-core/costs";
import type { Bar } from "../domain";
import { boll, ma, macd } from "../indicators";
import { researchNavStatistics } from "../research/strategy-research";

export const barReplayStrategyKeys = ["ma-cross", "double-breakout"] as const;
export type BarReplayStrategyKey = (typeof barReplayStrategyKeys)[number];
export const barReplayExecutionRules = ["next-open", "same-close"] as const;
export type BarReplayExecutionRule = (typeof barReplayExecutionRules)[number];
export const barReplayAdjustmentSchema = z.enum([
  "none",
  "forward",
  "backward",
]);
export type BarReplayAdjustment = z.infer<typeof barReplayAdjustmentSchema>;
export const barReplaySymbolSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(sh|sz|bj)\d{6}$/);

export const barReplayOrderSchema = z
  .object({
    date: researchDateSchema,
    side: z.enum(["buy", "sell"]),
    quantity: z.number().int().positive().max(1e9),
  })
  .strict();

export const barReplaySessionSchema = z
  .object({
    startDate: researchDateSchema,
    initialCash: z.number().min(100).max(1e9).default(100_000),
    executionRule: z.enum(barReplayExecutionRules).default("next-open"),
    orders: z.array(barReplayOrderSchema).max(2000).default([]),
  })
  .strict();

export type BarReplayOrder = z.infer<typeof barReplayOrderSchema>;
export type BarReplaySession = z.input<typeof barReplaySessionSchema>;
export type BarReplaySignal = Pick<BarReplayOrder, "date" | "side">;
export type BarReplayFill = BarReplayOrder & {
  orderIndex: number;
  executionDate: string;
  price: number;
  fee: number;
};
export type BarReplayRejection = {
  orderIndex: number;
  order: BarReplayOrder;
  executionDate: string;
  reason: "lot-size" | "no-quote" | "cash" | "holdings" | "t-plus-one";
};
export type BarReplaySimulation = {
  cash: number;
  quantity: number;
  sellableQuantity: number;
  equity: { date: string; value: number }[];
  fills: BarReplayFill[];
  rejections: BarReplayRejection[];
  pending: { orderIndex: number; order: BarReplayOrder }[];
  blockedReason: string | null;
  totalReturn: number | null;
  maxDrawdown: number | null;
  discipline: {
    score: number;
    sellAttempts: number;
    tPlusOneRejections: number;
    stopOpportunities: number;
    stopExecutions: number;
    buyFills: number;
    chaseFills: number;
    holdPastStop: number;
  };
};

export type BarReplayFrame<Czsc = unknown> = {
  symbol: string;
  cutoffDate: string;
  adjustment: BarReplayAdjustment;
  strategyKey: BarReplayStrategyKey | null;
  bars: Bar[];
  indicators: ReturnType<typeof barReplayIndicators>;
  czsc: Czsc | null;
  hasMore: boolean;
  simulation: BarReplaySimulation | null;
  warnings: string[];
};

export type BarReplayEvaluation = {
  user: BarReplaySimulation;
  theory: BarReplaySimulation;
  theorySignals: BarReplaySignal[];
  /** Decimal ratios. Differences are user minus theory. */
  returnDifference: number | null;
  maxDrawdownDifference: number | null;
  timing: {
    precision: number | null;
    recall: number | null;
    f1: number | null;
    matches: number;
    userSignals: number;
    theorySignals: number;
    toleranceSessions: number;
  };
  missed: (BarReplaySignal & {
    followUpDate: string | null;
    forwardReturn: number | null;
  })[];
};

export function barReplayIndicators(bars: readonly Bar[]) {
  return {
    ma: {
      5: ma(bars, 5),
      10: ma(bars, 10),
      20: ma(bars, 20),
      60: ma(bars, 60),
    },
    macd: macd(bars),
    boll: boll(bars),
  };
}

export type BarReplaySimulationInput = {
  symbol: string;
  bars: readonly Bar[];
  /** Known effective dates. A held position crossing one cannot be settled. */
  actionDates?: readonly string[];
  session: BarReplaySession;
};

const lotSize = 100;
const stopLoss = 0.08;
const chaseGap = 0.05;
const costs = researchExecutionCosts("cn-equity", "base");
const ratio = (numerator: number, denominator: number) =>
  denominator ? numerator / denominator : null;

function simulate(
  { symbol, bars, actionDates = [], session }: BarReplaySimulationInput,
  choices?: ReadonlyMap<string, BarReplaySignal["side"]>,
) {
  const { startDate, initialCash, executionRule, orders } =
    barReplaySessionSchema.parse(session);
  const signals: BarReplaySignal[] = [];
  const dates = new Map(bars.map((bar, index) => [bar.date, index]));
  const start = dates.get(startDate);
  if (start === undefined) throw new Error("训练起始日缺少可见日线");
  if (
    bars.some(
      (bar, i) =>
        (i > 0 && bar.date <= bars[i - 1]!.date) ||
        ![bar.open, bar.close].every(
          (price) => Number.isFinite(price) && price > 0,
        ),
    )
  )
    throw new Error("训练日线日期或价格无效");

  const scheduled = new Map<number, BarReplaySimulation["pending"]>();
  const pending: BarReplaySimulation["pending"] = [];
  const effectiveDates = [...actionDates].sort();
  for (const [orderIndex, order] of orders.entries()) {
    const index = dates.get(order.date);
    if (index === undefined || index < start)
      throw new Error("手工操作必须发生在训练区间的可见交易日");
    const executionIndex = index + Number(executionRule === "next-open");
    if (executionIndex === bars.length) pending.push({ orderIndex, order });
    else {
      const list = scheduled.get(executionIndex) ?? [];
      list.push({ orderIndex, order });
      scheduled.set(executionIndex, list);
    }
  }

  const fills: BarReplayFill[] = [];
  const rejections: BarReplayRejection[] = [];
  const equity: BarReplaySimulation["equity"] = [];
  let cash = initialCash,
    quantity = 0,
    sellableQuantity = 0,
    positionCost = 0;
  let stopDue = false,
    blockedReason: string | null = null;
  let sellAttempts = 0,
    tPlusOneRejections = 0;
  let stopOpportunities = 0,
    stopExecutions = 0,
    buyFills = 0,
    chaseFills = 0;
  let nextChoice: BarReplaySimulation["pending"][number] | undefined;
  let actionIndex = 0;

  for (let i = start; i < bars.length; i++) {
    const bar = bars[i]!,
      previous = bars[i - 1];
    while (
      effectiveDates[actionIndex] &&
      effectiveDates[actionIndex]! <= (previous?.date ?? bar.date)
    )
      actionIndex++;
    if (
      quantity &&
      effectiveDates[actionIndex] &&
      effectiveDates[actionIndex]! <= bar.date
    ) {
      blockedReason = `${bar.date} 持仓跨公司行动，模拟结算缺少到账与可卖依据`;
      break;
    }
    sellableQuantity = quantity;
    const stopEligibleQuantity = stopDue ? sellableQuantity : 0;
    let stopSold = 0;
    const price = executionRule === "next-open" ? bar.open : bar.close;
    const todayOrders = scheduled.get(i) ?? [];
    if (choices && executionRule === "same-close")
      nextChoice = theoreticalOrder();
    if (nextChoice) todayOrders.push(nextChoice);
    nextChoice = undefined;

    for (const { orderIndex, order } of todayOrders) {
      const buy = order.side === "buy";
      if (!buy) sellAttempts++;
      const gross = price * order.quantity;
      const dated = executionCostsForInstrument(costs, symbol, bar.date);
      const fee =
        Math.max(dated.minimumCommission, (gross * dated.commissionBps) / 1e4) +
        (gross * ((dated.transferBps ?? 0) + (buy ? 0 : dated.sellTaxBps))) /
          1e4;
      let reason: BarReplayRejection["reason"] | null = null;
      if (order.quantity % lotSize || order.quantity < lotSize)
        reason = "lot-size";
      else if (!(bar.volume > 0)) reason = "no-quote";
      else if (buy && gross + fee > cash) reason = "cash";
      else if (!buy && order.quantity > quantity) reason = "holdings";
      else if (!buy && order.quantity > sellableQuantity) reason = "t-plus-one";
      if (reason) {
        if (reason === "t-plus-one") tPlusOneRejections++;
        rejections.push({ order, orderIndex, executionDate: bar.date, reason });
        continue;
      }
      if (buy) {
        buyFills++;
        if (previous && price >= previous.close * (1 + chaseGap)) chaseFills++;
        cash -= gross + fee;
        quantity += order.quantity;
        positionCost += gross;
      } else {
        stopSold += order.quantity;
        cash += gross - fee;
        positionCost *= (quantity - order.quantity) / quantity;
        quantity -= order.quantity;
        sellableQuantity -= order.quantity;
      }
      fills.push({ ...order, orderIndex, executionDate: bar.date, price, fee });
    }
    if (stopEligibleQuantity) {
      stopOpportunities++;
      if (stopSold >= stopEligibleQuantity) stopExecutions++;
    }
    stopDue =
      quantity > 0 && bar.close <= (positionCost / quantity) * (1 - stopLoss);
    equity.push({ date: bar.date, value: cash + quantity * bar.close });

    if (choices && executionRule === "next-open")
      nextChoice = theoreticalOrder();
    function theoreticalOrder() {
      const side = choices?.get(bar.date);
      if (!side || (side === "buy" ? quantity > 0 : quantity === 0)) return;
      const orderIndex = signals.length;
      signals.push({ date: bar.date, side });
      const shares =
        side === "buy"
          ? Math.floor((cash * 0.95) / bar.close / lotSize) * lotSize
          : quantity;
      return { orderIndex, order: { date: bar.date, side, quantity: shares } };
    }
  }
  if (nextChoice && !blockedReason) pending.push(nextChoice);
  if (blockedReason) pending.length = 0;
  const stats = blockedReason
    ? null
    : researchNavStatistics(
        initialCash,
        equity.map((row) => row.value),
        0,
      );
  const holdPastStop = stopOpportunities - stopExecutions;
  const score = Math.round(
    100 -
      40 * (ratio(tPlusOneRejections, sellAttempts) ?? 0) -
      40 * (ratio(holdPastStop, stopOpportunities) ?? 0) -
      20 * (ratio(chaseFills, buyFills) ?? 0),
  );
  const simulation: BarReplaySimulation = {
    cash,
    quantity,
    sellableQuantity,
    equity,
    fills,
    rejections,
    pending,
    blockedReason,
    totalReturn: stats?.totalReturn ?? null,
    maxDrawdown: stats?.maxDrawdown ?? null,
    discipline: {
      score,
      sellAttempts,
      tPlusOneRejections,
      stopOpportunities,
      stopExecutions,
      buyFills,
      chaseFills,
      holdPastStop,
    },
  };
  return { simulation, signals };
}

export function settleBarReplaySession(
  input: BarReplaySimulationInput,
): BarReplaySimulation {
  return simulate(input).simulation;
}

export function evaluateBarReplaySession(
  input: BarReplaySimulationInput & {
    theorySignals: readonly BarReplaySignal[];
    signalBars?: readonly Bar[];
    toleranceSessions?: number;
  },
): BarReplayEvaluation {
  const {
    bars,
    theorySignals,
    toleranceSessions = 2,
    signalBars = bars,
  } = input;
  if (
    !Number.isInteger(toleranceSessions) ||
    toleranceSessions < 0 ||
    signalBars.length !== bars.length ||
    signalBars.some((bar, i) => bar.date !== bars[i]!.date)
  )
    throw new Error("评分容忍窗口或理论行情日期无效");
  const user = settleBarReplaySession(input);
  const { simulation: theory, signals } = simulate(
    { ...input, session: { ...input.session, orders: [] } },
    new Map(theorySignals.map((signal) => [signal.date, signal.side])),
  );
  const byDate = new Map(bars.map((bar, index) => [bar.date, index]));
  // Ordered one-to-one matching maximizes matches for a fixed session tolerance.
  const matched = new Set<BarReplaySignal>();
  const decisions = new Map(
    user.fills.map((fill) => [`${fill.date}:${fill.side}`, fill]),
  );
  for (const side of ["buy", "sell"] as const) {
    const candidates = [...decisions.values()].filter(
      (fill) => fill.side === side,
    );
    let cursor = 0;
    for (const signal of signals.filter((row) => row.side === side)) {
      const index = byDate.get(signal.date)!;
      while (
        cursor < candidates.length &&
        byDate.get(candidates[cursor]!.date)! < index - toleranceSessions
      )
        cursor++;
      if (
        cursor < candidates.length &&
        byDate.get(candidates[cursor]!.date)! <= index + toleranceSessions
      ) {
        matched.add(signal);
        cursor++;
      }
    }
  }
  const precision = ratio(matched.size, decisions.size);
  const recall = ratio(matched.size, signals.length);
  const difference = (a: number | null, b: number | null) =>
    a === null || b === null ? null : a - b;
  return {
    user,
    theory,
    theorySignals: signals,
    returnDifference: difference(user.totalReturn, theory.totalReturn),
    maxDrawdownDifference: difference(user.maxDrawdown, theory.maxDrawdown),
    timing: {
      precision,
      recall,
      f1: ratio(2 * matched.size, decisions.size + signals.length),
      matches: matched.size,
      userSignals: decisions.size,
      theorySignals: signals.length,
      toleranceSessions,
    },
    missed: signals
      .filter((signal) => !matched.has(signal))
      .map((signal) => {
        const index = byDate.get(signal.date)!;
        const end = signalBars[index + 5];
        return {
          ...signal,
          followUpDate: end?.date ?? null,
          forwardReturn: end ? end.close / signalBars[index]!.close - 1 : null,
        };
      }),
  };
}
