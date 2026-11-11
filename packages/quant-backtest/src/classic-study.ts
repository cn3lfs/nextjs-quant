import { z } from "zod";
import { big, moneyMul, toNumber } from "trading-strategy-core/money";
import { fillMarketOrder, affordableQuantity } from "./execution.js";
import { defaultExecutionCosts } from "./costs.js";
import type { Bar } from "./model.js";
import {
  createStudyDecision,
  type StudyOrder as Order,
} from "trading-strategies";
import {
  studyStrategies,
  studyNames,
  studyWarmup,
  studyCatalog,
  type StudyStrategy,
  nativeStudyStrategies,
  nativeStudyDefinition,
  isNativeStudyStrategy,
  type NativeStudyStrategy,
  type FrozenChanObservation,
} from "trading-strategies";

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => new Date(v).toISOString().slice(0, 10) === v);
const barSchema = z
  .object({
    date,
    open: z.number().positive().finite(),
    high: z.number().positive().finite(),
    low: z.number().positive().finite(),
    close: z.number().positive().finite(),
    volume: z.number().nonnegative().finite(),
    amount: z.number().nonnegative().finite(),
  })
  .passthrough();
const dividendSchema = z.object({
  date,
  perShare: z.number().positive().finite(),
});
export const classicStudyDatasetSchema = z.object({
  bars: z.array(barSchema).min(142),
  dividends: z.array(dividendSchema),
});
export type StudyDividend = z.infer<typeof dividendSchema>;
type StudyCommonOptions = {
  start: string;
  end: string;
  initial: number;
  slippageBps?: number;
  dividendTaxBps?: number;
};
export type StudyOptions = StudyCommonOptions &
  (
    | { strategy: StudyStrategy; nativeObservations?: never }
    | {
        strategy: NativeStudyStrategy;
        nativeObservations: readonly FrozenChanObservation[];
      }
  );
export type StudyFill = {
  signalDate: string;
  date: string;
  side: "buy" | "sell";
  price: number;
  shares: number;
  fee: number;
  cash: number;
  holding: number;
  reason: string;
};
const rules = {
  evidence: "explicit-mainboard-scenario-not-certified-history",
  minimumBuy: 100,
  buyStep: 100,
  maximumOrder: 1000000,
  limitUp: null,
  limitDown: null,
  tradable: true,
};
const cashAdd = (a: number, b: number) => toNumber(big(a).plus(b));

/** Cash-only causal normalization: future ex-dates never rewrite the past. */
export function studySignalBars(
  bars: readonly Bar[],
  dividends: readonly StudyDividend[],
) {
  const events = new Map(dividends.map((d) => [d.date, d.perShare]));
  let factor = 1;
  return bars.map((b, i) => {
    const dividend = events.get(b.date);
    if (dividend && i > 0) {
      const previous = bars[i - 1]!.close;
      if (previous <= dividend) throw new Error("现金除息参考价非正");
      factor *= previous / (previous - dividend);
    }
    return {
      ...b,
      open: b.open * factor,
      high: b.high * factor,
      low: b.low * factor,
      close: b.close * factor,
    };
  });
}

export function runClassicStudy(
  rawBars: readonly Bar[],
  rawDividends: readonly StudyDividend[],
  options: StudyOptions,
) {
  const o = z
    .object({
      start: date,
      end: date,
      initial: z.number().positive().finite(),
      strategy: z.enum([...studyStrategies, ...nativeStudyStrategies]),
      slippageBps: z.number().min(0).max(100).default(0),
      dividendTaxBps: z.number().int().min(0).max(10000).default(0),
    })
    .parse(options);
  if (o.start > o.end) throw new Error("研究区间倒序");
  const bars = z.array(barSchema).min(142).parse(rawBars);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (
      (i > 0 && b.date <= bars[i - 1]!.date) ||
      b.high < Math.max(b.open, b.close) ||
      b.low > Math.min(b.open, b.close)
    )
      throw new Error("行情顺序或OHLC无效");
  }
  const dividends = z.array(dividendSchema).parse(rawDividends);
  if (new Set(dividends.map((d) => d.date)).size !== dividends.length)
    throw new Error("分红日期重复");
  if (
    dividends.some(
      (d) =>
        d.date > bars[0]!.date &&
        d.date <= bars.at(-1)!.date &&
        !bars.some((b) => b.date === d.date),
    )
  )
    throw new Error("分红日缺少行情");
  const signal = studySignalBars(bars, dividends);
  const first = bars.findIndex((b) => b.date >= o.start),
    last = bars.reduce((n, b, i) => (b.date <= o.end ? i : n), -1);
  const native = isNativeStudyStrategy(o.strategy);
  const warmup = native
    ? nativeStudyDefinition.warmupBars
    : studyWarmup(o.strategy as StudyStrategy);
  if (first < warmup || last < first)
    throw new Error(`预热至少${warmup}日且研究区间非空`);
  const costs = {
    ...defaultExecutionCosts,
    commissionBps: 1,
    minimumCommission: 5,
    sellTaxBps: 5,
    slippageBps: o.slippageBps,
  };
  const fees = (amount: number, side: "buy" | "sell") =>
    toNumber(
      big(Math.max(5, amount * 0.0001)).plus(
        side === "sell" ? big(amount).times(0.0005) : 0,
      ),
    );
  let cash = o.initial,
    shares = 0,
    dividendAccount = 0,
    totalFees = 0,
    entry = 0,
    entryIndex = 0,
    anchor = 0,
    core = 0,
    sleeveCap = 0,
    initialized = false,
    peak = o.initial,
    maxDrawdown = 0,
    lastAllocationMonth = "",
    installments = 0;
  const fills: StudyFill[] = [],
    rejected: { date: string; reason: string; order: Order }[] = [],
    curve: {
      date: string;
      equity: number;
      cash: number;
      shares: number;
      dividends: number;
      exposure: number;
      drawdown: number;
    }[] = [];
  const events = new Map(dividends.map((d) => [d.date, d.perShare]));
  const decision = createStudyDecision(
    o.strategy,
    native ? bars.slice(0, last + 1) : bars,
    native ? signal.slice(0, last + 1) : signal,
    o.initial,
    first,
    options.nativeObservations,
  );
  function decide(i: number): Order | null {
    const state = {
      cash,
      shares,
      entry,
      entryIndex,
      anchor,
      core,
      sleeveCap,
      initialized,
      lastAllocationMonth,
      installments,
    };
    const order = decision(i, state);
    lastAllocationMonth = state.lastAllocationMonth;
    return order;
  }
  let pending = decide(first - 1);
  for (let i = first; i <= last; i++) {
    const b = bars[i]!,
      sb = signal[i]!;
    // Entitlement is based on the prior close, before today's open transaction.
    const perShare = events.get(b.date);
    if (perShare)
      dividendAccount = cashAdd(
        dividendAccount,
        moneyMul(shares, perShare * (1 - o.dividendTaxBps / 10000)),
      );
    if (pending) {
      const reference = bars[i - 1]!.close - (perShare ?? 0);
      const quote = fillMarketOrder(
        b,
        pending.side,
        {
          ...rules,
          limitUp: Math.round(reference * 1.1 * 100) / 100,
          limitDown: Math.round(reference * 0.9 * 100) / 100,
        },
        costs,
      );
      if (quote.price === null)
        rejected.push({ date: b.date, reason: quote.reason, order: pending });
      else {
        const price = quote.price;
        const maxBuy = affordableQuantity(
          pending.fraction === undefined
            ? cash
            : Math.min(cash, o.initial * pending.fraction),
          price,
          rules,
          costs,
        );
        const quantity =
          pending.side === "sell"
            ? Math.min(shares, pending.quantity ?? shares)
            : pending.quantity === undefined
              ? maxBuy
              : Math.min(pending.quantity, maxBuy);
        if (quantity < 100)
          rejected.push({
            date: b.date,
            reason: "资金或可卖整手不足",
            order: pending,
          });
        else {
          const amount = moneyMul(quantity, price),
            fee = fees(amount, pending.side);
          cash = toNumber(
            big(cash)
              .plus(pending.side === "buy" ? -amount : amount)
              .minus(fee),
          );
          if (cash < -1e-7) throw new Error("现金透支");
          shares += pending.side === "buy" ? quantity : -quantity;
          totalFees = cashAdd(totalFees, fee);
          if (
            pending.side === "buy" &&
            o.strategy !== "grid" &&
            shares === quantity
          ) {
            entry = (price * sb.open) / b.open;
            entryIndex = i;
          }
          if (o.strategy === "grid") {
            if (!initialized) {
              core = Math.floor((quantity * 0.75) / 100) * 100;
              sleeveCap = (quantity - core) * 2;
            }
            anchor = (price * sb.open) / b.open;
          }
          initialized = true;
          lastAllocationMonth = pending.signalDate.slice(0, 7);
          if (o.strategy === "dca") installments++;
          fills.push({
            signalDate: pending.signalDate,
            date: b.date,
            side: pending.side,
            price,
            shares: quantity,
            fee,
            cash,
            holding: shares,
            reason: pending.reason,
          });
        }
      }
    }
    const equity = toNumber(
      big(cash).plus(big(shares).times(b.close)).plus(dividendAccount),
    );
    peak = Math.max(peak, equity);
    const drawdown = 1 - equity / peak;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
    curve.push({
      date: b.date,
      equity,
      cash,
      shares,
      dividends: dividendAccount,
      exposure: (shares * b.close) / equity,
      drawdown,
    });
    pending = decide(i);
  }
  const final = curve.at(-1)!,
    years =
      (Date.parse(final.date) - Date.parse(curve[0]!.date)) / 86400000 / 365.25;
  const annual: { year: string; return: number; maxDrawdown: number }[] = [];
  let previous = o.initial;
  for (const year of [...new Set(curve.map((r) => r.date.slice(0, 4)))]) {
    const rows = curve.filter((r) => r.date.startsWith(year));
    let p = previous,
      dd = 0;
    for (const r of rows) {
      p = Math.max(p, r.equity);
      dd = Math.max(dd, 1 - r.equity / p);
    }
    const end = rows.at(-1)!.equity;
    annual.push({ year, return: end / previous - 1, maxDrawdown: dd });
    previous = end;
  }
  return {
    strategy: o.strategy,
    name: native
      ? nativeStudyDefinition.name
      : studyNames[o.strategy as StudyStrategy],
    definition: native
      ? nativeStudyDefinition
      : studyCatalog[o.strategy as StudyStrategy],
    warmupBars: warmup,
    options: o,
    quality: "rule-check-only" as const,
    start: curve[0]!.date,
    end: final.date,
    tradingDays: curve.length,
    finalEquity: final.equity,
    totalReturn: final.equity / o.initial - 1,
    cagr: (final.equity / o.initial) ** (1 / years) - 1,
    maxDrawdown,
    fees: totalFees,
    dividends: dividendAccount,
    averageExposure: curve.reduce((s, r) => s + r.exposure, 0) / curve.length,
    fills,
    rejected,
    curve,
    annual,
    pending,
    coreShares: core,
  };
}
