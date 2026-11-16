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
  dimension: z.enum(["market", "sleeve", "symbol", "industry", "heat"]),
  key: z.string().trim().min(1).max(100),
  fraction: z.number().finite().nonnegative().max(1),
});
export const accountReviewSettingsSchema = z
  .object({
    caps: z.array(exposureCapSchema).max(100).default([]),
    portfolioLimits: z
      .object({
        enabled: z.boolean().default(true),
        symbolWeight: z.number().finite().nonnegative().max(1).default(0.15),
        heat: z.number().finite().nonnegative().max(1).default(0.06),
        industryWeight: z.number().finite().nonnegative().max(1).default(0.3),
      })
      .default({}),
    decayPercentile: z.number().finite().gt(0).lt(0.5).default(0.1),
    minimumSamples: z.number().int().min(5).max(10000).default(30),
    chaseFraction: z.number().finite().positive().max(1).default(0.03),
  })
  .default({});
export type AccountReviewSettings = z.infer<typeof accountReviewSettingsSchema>;
export function effectiveExposureCaps(
  review: AccountReviewSettings,
  market: AccountMarket,
) {
  const defaults: AccountReviewSettings["caps"] = review.portfolioLimits.enabled
    ? [
        {
          market,
          dimension: "symbol",
          key: "*",
          fraction: review.portfolioLimits.symbolWeight,
        },
        ...(market === "cn-equity"
          ? [
              {
                market,
                dimension: "industry" as const,
                key: "*",
                fraction: review.portfolioLimits.industryWeight,
              },
            ]
          : []),
        {
          market,
          dimension: "heat",
          key: market,
          fraction: review.portfolioLimits.heat,
        },
      ]
    : [];
  return [...review.caps.filter((c) => c.market === market), ...defaults];
}
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
  /** Read old single-industry facts only when the array is absent. */
  industryGroups?: readonly string[];
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
  timePrecision?: "instant" | "day";
  sourceOrder?: { source: string; index: number };
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
/** An explicit empty snapshot is unknown. Never recover a stale single label
 * from it or split a display string into invented classifications. */
export function industryGroupsFor(value: {
  industryGroups?: readonly string[];
  industry?: string;
}) {
  const groups = value.industryGroups ?? [value.industry ?? ""];
  return [
    ...new Set(
      groups
        .map((group) => group.trim())
        .filter((group) => group && group !== "未知"),
    ),
  ].sort();
}
export function checkExposureCaps(input: {
  positions: readonly AccountPosition[];
  reserved: readonly {
    market: AccountMarket;
    symbol: string;
    sleeve: string;
    industry: string;
    industryGroups?: readonly string[];
    value: number;
    openRisk?: number | null;
  }[];
  proposed: {
    market: AccountMarket;
    symbol: string;
    sleeve: string;
    industry: string;
    industryGroups?: readonly string[];
    value: number;
    openRisk?: number | null;
    maxPositions?: number;
  };
  capital: Record<AccountMarket, number>;
  caps: AccountReviewSettings["caps"];
}) {
  const { proposed, caps, capital } = input;
  const positions = input.positions.filter(
    (p) => p.kind === "real" && p.market === proposed.market,
  );
  const items = [
    ...positions.map((p) => ({
      ...p,
      openRisk:
        p.price !== null &&
        p.stop !== null &&
        Number.isFinite(p.price) &&
        Number.isFinite(p.stop) &&
        Number.isFinite(p.quantity)
          ? Math.max(0, p.price - p.stop) * p.quantity
          : null,
    })),
    ...input.reserved.filter((p) => p.market === proposed.market),
    proposed,
  ];
  const violations: CapViolation[] = [];
  if (proposed.maxPositions !== undefined) {
    const names = new Set(
      items
        .filter(
          (p) =>
            p.sleeve === proposed.sleeve && (p.value === null || p.value > 0),
        )
        .map((p) => p.symbol),
    );
    if (names.size > proposed.maxPositions)
      violations.push({
        dimension: "positions",
        key: `${proposed.market}:${proposed.sleeve}`,
        used: names.size,
        limit: proposed.maxPositions,
        reason:
          "计划后持仓品种数超过策略验证的分仓上限；确认将记录偏离验证策略",
      });
  }
  for (const cap of caps.filter((c) => c.market === proposed.market)) {
    if (cap.dimension === "heat") {
      const used = items.every(
        (p) =>
          p.openRisk != null && Number.isFinite(p.openRisk) && p.openRisk >= 0,
      )
        ? items.reduce((n, p) => n + p.openRisk!, 0)
        : null;
      const limit = capital[cap.market] * cap.fraction;
      if (used === null || capital[cap.market] <= 0 || used > limit)
        violations.push({
          dimension: "heat",
          key: cap.market,
          used,
          limit,
          reason:
            used === null || capital[cap.market] <= 0
              ? "止损、估值或资本依据不足，无法证明总持仓风险未超限"
              : "真实持仓及计划的止损本金风险超过市场资金上限",
        });
      continue;
    }
    if (cap.dimension === "industry") {
      // The weekly review's zero-valued proposed item is neutral. A real
      // missing valuation remains exposure and must not bypass classification.
      const grouped = items
        .filter((item) => item.value !== 0)
        .map((item) => ({ item, groups: industryGroupsFor(item) }));
      const missingGroups = grouped.some((row) => row.groups.length === 0);
      const keys =
        cap.key === "*"
          ? [...new Set(grouped.flatMap((row) => row.groups))].sort()
          : [cap.key];
      if (!keys.length && missingGroups) keys.push("未知");
      for (const key of keys) {
        const matching = grouped.filter((row) => row.groups.includes(key));
        const unknown =
          missingGroups ||
          capital[cap.market] <= 0 ||
          matching.some((row) => row.item.value === null);
        const used = unknown
          ? null
          : matching.reduce((sum, row) => sum + row.item.value!, 0);
        const limit = capital[cap.market] * cap.fraction;
        if (unknown || used! > limit)
          violations.push({
            dimension: "industry",
            key,
            used,
            limit,
            reason: unknown
              ? "持仓估值、行业组或资本依据不足，无法证明未超限"
              : "计划及未完成预留加入后超过行业组敞口上限（各组独立校验）",
          });
      }
      continue;
    }
    const dimension = cap.dimension;
    const applies =
      dimension === "market" ||
      cap.key === "*" ||
      proposed[dimension] === cap.key;
    if (!applies) continue;
    const keys =
      cap.key === "*" && dimension !== "market"
        ? [...new Set(items.map((p) => p[dimension]))].sort()
        : [cap.key];
    for (const key of keys) {
      const matching = items.filter(
        (p) => dimension === "market" || p[dimension] === key,
      );
      const used = matching.every((p) => p.value !== null)
        ? matching.reduce((n, p) => n + p.value!, 0)
        : null;
      const limit = capital[cap.market] * cap.fraction;
      const unknown =
        used === null ||
        capital[cap.market] <= 0 ||
        (dimension === "sleeve" &&
          matching.some((p) => p[dimension] === "未知"));
      if (unknown || used! > limit)
        violations.push({
          dimension: cap.dimension,
          key,
          used,
          limit,
          reason: unknown
            ? "持仓估值、分组或资本依据不足，无法证明未超限"
            : "计划及未完成预留加入后超过敞口上限",
        });
    }
  }
  return violations;
}
