import { z } from "zod";
import { defaultBacktestCosts, type BacktestCosts } from "./backtest-costs";
import { big, bpsOf, moneyMul, toNumber } from "./money";
import { aggregateLedger, type LedgerRow } from "./signal-ledger";
import type { SkillUse } from "~/server/research-skills";
import type { TdxXdxr } from "~/server/tdx-wire";

export const feeLabel = "实验参数，非历史实际费用";
const positive = z.number().finite().positive();
export const tradeInputSchema = z
  .object({
    id: z.string().uuid(),
    symbol: z
      .string()
      .regex(/^(sh(60|68)\d{4}|sz(00|30)\d{4}|bj(43|83|87|88|92)\d{4})$/),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((s) => {
        const d = new Date(s);
        return (
          Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s
        );
      }, "无效日期"),
    side: z.enum(["buy", "sell"]),
    price: positive,
    // User-required 100-share rule; concrete lot contract is mock-trading API spec.
    quantity: z.number().int().positive().max(100000000).multipleOf(100),
    lowerLimit: positive,
    upperLimit: positive,
    limitSource: z.string().trim().min(1).max(200),
    signalId: z.string().max(128).nullable().default(null),
    stop: positive.nullable().default(null),
    note: z.string().max(500).default(""),
  })
  .superRefine((t, ctx) => {
    // Bands are explicitly supplied from the day's terminal, not inferred from a
    // previous close (ex-dates, special sessions and rounding need source facts).
    if (
      t.lowerLimit > t.upperLimit ||
      t.price < t.lowerLimit ||
      t.price > t.upperLimit
    )
      ctx.addIssue({ code: "custom", message: "价格超出当日涨跌停范围" });
  });
export type TradeInput = z.infer<typeof tradeInputSchema>;
export type Trade = TradeInput & {
  createdAt: number;
  methods: SkillUse[];
  costs: BacktestCosts;
  fees: { commission: number; tax: number; slippage: number; total: number };
};
export function tradeFees(
  t: Pick<TradeInput, "price" | "quantity" | "side">,
  c = defaultBacktestCosts,
) {
  const amount = moneyMul(t.price, t.quantity);
  const commission = Math.max(c.minimumCommission, bpsOf(amount, c.commissionBps));
  const tax = t.side === "sell" ? bpsOf(amount, c.sellTaxBps) : 0;
  const slippage = bpsOf(amount, c.slippageBps);
  return {
    commission,
    tax,
    slippage,
    total: toNumber(big(commission).plus(tax).plus(slippage)),
  };
}
export type CorporateEvidence = {
  events: TdxXdxr[];
  coverageEnd: string | null;
  source: string;
  bonusListings?: Record<string, { date: string; source: string }>;
};
export type CostAdjustment = {
  id: string;
  symbol: string;
  event: TdxXdxr;
  source: string;
  beforeQuantity: number;
  afterQuantity: number;
  beforeCost: number;
  afterCost: number | null;
  basis: string;
};
export type Position = {
  symbol: string;
  quantity: number;
  sellable: number;
  averageCost: number;
  adjustedCost: number | null;
  floating: number | null;
  realized: number;
  quote: { price: number; date: string } | null;
  stop: number | null;
  stopDistancePct: number | null;
  adjustmentStatus: string;
  adjustments: CostAdjustment[];
};
/** Replay immutable fills and ex-events in date order. Events precede that day's
 * fills. Sales remove moving-average cost; sale profit never changes residual cost.
 * Rights subscriptions and share-consolidation dates are not inferable from GBBQ:
 * expose an unresolved event instead of fabricating receipt/payment of shares. */
export function positionFor(
  symbol: string,
  trades: Trade[],
  asOf: string,
  calendar: string[],
  evidence: CorporateEvidence,
  quote: Position["quote"] = null,
): Position {
  let quantity = 0,
    totalCost = 0,
    realized = 0,
    stop: number | null = null;
  const lots: { date: string; quantity: number; availableOn?: string }[] = [];
  const adjustments: CostAdjustment[] = [];
  let unresolved = false;
  const entries = [
    ...trades
      .filter((t) => t.symbol === symbol && t.date <= asOf)
      .map((t) => ({ date: t.date, rank: 1, t, e: null })),
    ...evidence.events
      .filter((e) => e.date <= asOf && [1, 11, 12].includes(e.category))
      .map((e) => ({ date: e.date, rank: 0, t: null, e })),
  ].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.rank - b.rank ||
      (a.t?.createdAt ?? 0) - (b.t?.createdAt ?? 0) ||
      (a.t?.id ?? "").localeCompare(b.t?.id ?? ""),
  );
  const days = [...new Set(calendar)].sort();
  const canSell = (lot: (typeof lots)[number], date: string) =>
    lot.availableOn
      ? lot.availableOn <= date && days.includes(lot.availableOn)
      : days.includes(lot.date) && lot.date < date;
  const available = (date: string) =>
    days.includes(date)
      ? lots.filter((l) => canSell(l, date)).reduce((s, l) => s + l.quantity, 0)
      : 0;
  for (const { t, e } of entries) {
    if (e && quantity > 0) {
      const beforeQuantity = quantity,
        beforeCost = totalCost / quantity;
      const invalid =
        e.category !== 1 ||
        (e.rightsRatio ?? 0) !== 0 ||
        !Number.isFinite(e.dividend ?? 0) ||
        !Number.isFinite(e.bonusRatio ?? 0) ||
        (e.bonusRatio ?? 0) < 0;
      const factor = 1 + (e.bonusRatio ?? 0);
      // GBBQ has no share-credit/tradability date. Bonus shares are reflected in
      // cost but kept unavailable until their listing date is explicitly known.
      if (
        invalid ||
        Math.abs(quantity * factor - Math.round(quantity * factor)) > 1e-5
      )
        unresolved = true;
      else {
        totalCost -= quantity * (e.dividend ?? 0);
        quantity = Math.round(quantity * factor);
        const listing = evidence.bonusListings?.[e.date];
        if (listing && quantity > beforeQuantity)
          lots.push({
            date: e.date,
            quantity: quantity - beforeQuantity,
            availableOn: listing.date,
          });
      }
      adjustments.push({
        id: JSON.stringify([
          symbol,
          e,
          evidence.source,
          beforeQuantity,
          beforeCost,
          evidence.bonusListings?.[e.date] ?? null,
        ]),
        symbol,
        event: e,
        source: evidence.source,
        beforeQuantity,
        afterQuantity: quantity,
        beforeCost,
        afterCost: unresolved ? null : totalCost / quantity,
        basis: invalid
          ? "配股/缩股需实际认购或到账依据，成本待核对"
          : `(调整前总成本－原股数×每股派息)÷送转后股数；${evidence.bonusListings?.[e.date] ? `送转股可卖依据：${JSON.stringify(evidence.bonusListings[e.date])}` : "送转股可卖日期未知，暂不计可卖"}`,
      });
    }
    if (!t) continue;
    if (t.side === "buy") {
      totalCost += t.price * t.quantity + t.fees.total;
      quantity += t.quantity;
      lots.push({ date: t.date, quantity: t.quantity });
    } else {
      if (t.quantity > available(t.date) || t.quantity > quantity)
        throw new Error("卖出超过 T+1 可卖数量（含日历或送转股到账日期未知）");
      const cost = (totalCost / quantity) * t.quantity;
      realized += t.price * t.quantity - t.fees.total - cost;
      totalCost -= cost;
      quantity -= t.quantity;
      let remaining = t.quantity;
      for (const lot of lots)
        if (canSell(lot, t.date) && remaining > 0) {
          const used = Math.min(lot.quantity, remaining);
          lot.quantity -= used;
          remaining -= used;
        }
      if (!quantity) {
        totalCost = 0;
        unresolved = false;
      }
    }
    if (t.stop !== null) stop = t.stop;
  }
  const covered = !!evidence.coverageEnd && evidence.coverageEnd >= asOf;
  const averageCost = quantity ? totalCost / quantity : 0;
  const adjustedCost = covered && !unresolved ? averageCost : null;
  return {
    symbol,
    quantity,
    sellable: Math.min(quantity, available(asOf)),
    averageCost,
    adjustedCost,
    realized,
    floating:
      quote &&
      adjustedCost !== null &&
      !evidence.events.some(
        (e) =>
          [1, 11, 12].includes(e.category) &&
          e.date > quote.date &&
          e.date <= asOf,
      )
        ? (quote.price - adjustedCost) * quantity
        : null,
    quote,
    stop,
    stopDistancePct:
      quote && stop ? ((quote.price - stop) / quote.price) * 100 : null,
    adjustmentStatus: unresolved
      ? "除权事件待核对，成本不可用"
      : covered
        ? "成本已按 GBBQ 核对"
        : "成本未按除权调整",
    adjustments,
  };
}
/** Compare the SAME N1 forward outcomes, not actual fill P&L against hypothetical
 * price returns. Selection is descriptive, never causal or a P3 factor analysis. */
export function tradedSignalComparison(rows: LedgerRow[], trades: Trade[]) {
  const linked = new Set(
    trades.flatMap((t) => (t.signalId ? [t.signalId] : [])),
  );
  return [true, false].flatMap((done) =>
    aggregateLedger(rows.filter((r) => linked.has(r.id) === done)).map((g) => ({
      ...g,
      group: done ? "做过的信号" : "没做的信号",
    })),
  );
}
