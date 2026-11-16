import { z } from "zod";

export const accountKinds = ["real", "paper", "exchange-simulation"] as const;
export type AccountKind = (typeof accountKinds)[number];
export type AccountMarket = "cn-equity" | "crypto";
export const accountKindLabels = {
  real: "真实",
  paper: "纸面",
  "exchange-simulation": "模拟交易所",
};
export const exposureCapSchema = z.object({
  market: z.enum(["cn-equity", "crypto"]),
  dimension: z.enum(["market", "sleeve", "symbol", "industry"]),
  key: z.string().trim().min(1).max(100),
  fraction: z.number().finite().positive().max(1),
});
export const accountReviewSettingsSchema = z
  .object({
    caps: z.array(exposureCapSchema).max(100).default([]),
    decayPercentile: z.number().finite().gt(0).lt(0.5).default(0.1),
    minimumSamples: z.number().int().min(5).max(10000).default(30),
    chaseFraction: z.number().finite().positive().max(1).default(0.03),
  })
  .default({});
export type AccountReviewSettings = z.infer<typeof accountReviewSettingsSchema>;
export const accountPageSchema = z.object({
  page: z.number().int().min(0).max(1000000).default(0),
  kind: z.enum(["real", "paper", "exchange-simulation", "all"]).default("real"),
  market: z.enum(["cn-equity", "crypto", "all"]).default("all"),
  sleeve: z.string().max(100).default(""),
  group: z.enum(["market", "sleeve", "kind"]).default("market"),
});
export type AccountPosition = {
  id: string;
  account: string;
  kind: AccountKind;
  market: AccountMarket;
  currency: "CNY" | "USDT";
  symbol: string;
  sleeve: string;
  industry: string;
  quantity: number;
  cost: number | null;
  price: number | null;
  value: number | null;
  stop: number | null;
  at: string | null;
  strategyId: string | null;
  strategyVersion: number | null;
  reasons: string[];
};
export type AccountTrade = {
  id: string;
  account: string;
  kind: AccountKind;
  market: AccountMarket;
  symbol: string;
  side: "buy" | "sell";
  date: string;
  time: number;
  price: number;
  quantity: number;
  strategyId: string | null;
  strategyVersion: number | null;
  sleeve: string;
  planId: string | null;
  alertKey: string | null;
};
export const tradeLinkSchema = z.object({
  tradeId: z.string().min(1).max(500),
  planId: z.string().min(1).max(200).nullable(),
  alertKey: z.string().min(1).max(1000).nullable(),
  strategyId: z.string().min(1).max(150),
  strategyVersion: z.number().int().positive(),
  sleeve: z.string().min(1).max(100),
});
export type TradeLink = z.infer<typeof tradeLinkSchema> & {
  linkedAt: number;
  tradeFingerprint: string;
};
export function accountTradeFingerprint(
  trade: Pick<
    AccountTrade,
    | "id"
    | "account"
    | "kind"
    | "market"
    | "symbol"
    | "side"
    | "date"
    | "price"
    | "quantity"
  >,
) {
  return JSON.stringify([
    trade.id,
    trade.account,
    trade.kind,
    trade.market,
    trade.symbol,
    trade.side,
    trade.date,
    trade.price,
    trade.quantity,
  ]);
}

export function positionMetrics(p: AccountPosition) {
  return {
    stopDistance:
      p.price !== null && p.stop !== null ? (p.price - p.stop) / p.price : null,
    rMultiple:
      p.price !== null && p.cost !== null && p.stop !== null && p.cost > p.stop
        ? (p.price - p.cost) / (p.cost - p.stop)
        : null,
  };
}

/** All samples must already share the version, parameters and horizon. */
export function decayFlag(
  expected: readonly number[],
  observed: readonly number[],
  config: AccountReviewSettings,
) {
  const clean = (values: readonly number[]) =>
    values.filter(Number.isFinite).sort((a, b) => a - b);
  const e = clean(expected),
    o = clean(observed);
  const enough =
    e.length >= config.minimumSamples && o.length >= config.minimumSamples;
  const quantile = (values: number[], p: number) => {
    const n = (values.length - 1) * p,
      lo = Math.floor(n),
      hi = Math.ceil(n);
    return values[lo]! + (values[hi]! - values[lo]!) * (n - lo);
  };
  const threshold = e.length ? quantile(e, config.decayPercentile) : null;
  const median = o.length ? quantile(o, 0.5) : null;
  return {
    flagged: enough && median! < threshold!,
    enough,
    expectedSamples: e.length,
    observedSamples: o.length,
    threshold,
    median,
    percentile: config.decayPercentile,
    reason: enough
      ? null
      : `同口径期望与观察均至少 ${config.minimumSamples} 个样本`,
  };
}

export type CapViolation = {
  dimension: string;
  key: string;
  used: number | null;
  limit: number;
  reason: string;
};
export function checkExposureCaps(input: {
  positions: readonly AccountPosition[];
  reserved: readonly {
    market: AccountMarket;
    symbol: string;
    sleeve: string;
    industry: string;
    value: number;
  }[];
  proposed: {
    market: AccountMarket;
    symbol: string;
    sleeve: string;
    industry: string;
    value: number;
  };
  capital: Record<AccountMarket, number>;
  caps: AccountReviewSettings["caps"];
}) {
  const { proposed, caps, capital } = input;
  const positions = input.positions.filter(
    (p) => p.kind === "real" && p.market === proposed.market,
  );
  const items = [
    ...positions,
    ...input.reserved.filter((p) => p.market === proposed.market),
    proposed,
  ];
  const violations: CapViolation[] = [];
  for (const cap of caps.filter((c) => c.market === proposed.market)) {
    const applies =
      cap.dimension === "market" ||
      proposed[cap.dimension] === cap.key ||
      (cap.dimension === "industry" && proposed.industry === "未知");
    if (!applies) continue;
    const matching = items.filter(
      (p) =>
        cap.dimension === "market" ||
        p[cap.dimension] === cap.key ||
        (cap.dimension === "industry" && p.industry === "未知"),
    );
    const used = matching.every((p) => p.value !== null)
      ? matching.reduce((n, p) => n + p.value!, 0)
      : null;
    const limit = capital[cap.market] * cap.fraction;
    const unknown =
      used === null ||
      capital[cap.market] <= 0 ||
      ((cap.dimension === "industry" || cap.dimension === "sleeve") &&
        matching.some((p) => p[cap.dimension] === "未知"));
    if (unknown || used! > limit)
      violations.push({
        dimension: cap.dimension,
        key: cap.key,
        used,
        limit,
        reason: unknown
          ? "持仓估值、分组或资本依据不足，无法证明未超限"
          : "计划及未完成预留加入后超过敞口上限",
      });
  }
  return violations;
}
