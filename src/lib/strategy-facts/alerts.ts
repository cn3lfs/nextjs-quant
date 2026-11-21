import { z } from "zod";
import type { Outcome } from "./signal-ledger";
import type { SecurityTradingStatus } from "../market/security-trading-status";

export const UNIVERSAL_DEFAULT_CAPITAL = {
  "cn-equity": 1_000_000,
  crypto: 10_000,
} as const;
export const UNIVERSAL_DEFAULT_RISK = 0.01;

type AlertMarket = keyof typeof UNIVERSAL_DEFAULT_CAPITAL;

/** Use positive configured capital, or the market default. */
export function effectiveMarketCapital(
  alerts: { capital: Record<AlertMarket, number> },
  market: AlertMarket,
): number {
  const configured = alerts.capital[market];
  return Number.isFinite(configured) && configured > 0
    ? configured
    : UNIVERSAL_DEFAULT_CAPITAL[market];
}

/** Unallocated sleeves share the market pool and inherit its primary risk. */
export function universalMarketSleeve(
  alerts: {
    sleeves: readonly {
      id: string;
      market: AlertMarket;
      share: number;
      risk: number;
    }[];
  },
  market: AlertMarket,
  sleeveId: string,
) {
  const exact = alerts.sleeves.find(
    (s) => s.market === market && s.id === sleeveId && s.share > 0,
  );
  if (exact) return exact;
  const primary =
    alerts.sleeves.find((s) => s.market === market && s.share > 0) ??
    alerts.sleeves.find((s) => s.market === market);
  return {
    id: sleeveId,
    market,
    share: 1,
    risk: primary?.risk ?? UNIVERSAL_DEFAULT_RISK,
  };
}

export const alertModes = ["off", "shadow", "live"] as const;
export const alertModeLabels = { off: "关闭", shadow: "影子", live: "开启" };
export const sleeveSchema = z.object({
  id: z.string().min(1).max(80),
  market: z.enum(["cn-equity", "crypto"]),
  share: z.number().finite().min(0).max(1),
  risk: z.number().finite().positive().max(0.1),
});
export const alertsSchema = z
  .object({
    mode: z.enum(alertModes).default("shadow"),
    capital: z
      .object({
        "cn-equity": z.number().finite().nonnegative().default(0),
        crypto: z.number().finite().nonnegative().default(0),
      })
      .default({}),
    sleeves: z
      .array(sleeveSchema)
      .max(20)
      .default([
        { id: "swing", market: "cn-equity", share: 1, risk: 0.01 },
        { id: "low-zone", market: "cn-equity", share: 0, risk: 0.005 },
        { id: "swing", market: "crypto", share: 0.75, risk: 0.01 },
        { id: "breakout", market: "crypto", share: 0.25, risk: 0.005 },
      ])
      .superRefine((sleeves, ctx) => {
        const keys = sleeves.map((s) => `${s.market}:${s.id}`);
        if (new Set(keys).size !== keys.length)
          ctx.addIssue({ code: "custom", message: "分仓重复" });
        for (const market of ["cn-equity", "crypto"])
          if (
            sleeves
              .filter((s) => s.market === market)
              .reduce((n, s) => n + s.share, 0) >
            1 + 1e-10
          )
            ctx.addIssue({
              code: "custom",
              message: "同市场分仓份额合计不得超过100%",
            });
      }),
  })
  .default({});
export const alertKinds = [
  "entry",
  "exit",
  "stop",
  "target",
  "trailing",
  "plan-entry",
  "plan-expired",
  "regime",
  "allocation",
  "missed",
  "paper-fill",
] as const;
export type AlertMode = (typeof alertModes)[number];
export type AlertKind = (typeof alertKinds)[number];
export const alertKindLabels: Record<AlertKind, string> = {
  entry: "入场候选",
  exit: "退出条件",
  stop: "止损",
  target: "目标",
  trailing: "移动止损",
  "plan-entry": "计划入场",
  "plan-expired": "计划到期",
  regime: "市场状态",
  allocation: "分仓偏离",
  missed: "错过窗口",
  "paper-fill": "纸面成交（模拟）",
};
export type AlertEvent = {
  key: string;
  strategyId: string;
  version: number;
  market: "cn-equity" | "crypto";
  symbol: string;
  bar: string;
  type: AlertKind;
  price: number | null;
  sleeve: string;
  stop: number | null;
  target: number | null;
  observedAt: number;
  mode: AlertMode;
  status: "shadow" | "live" | "missed";
  reason: string;
  rankScore?: number;
  source: string;
  subscription?: { id: string; revision: string };
  planId?: string;
  wouldSend: boolean;
  outcomes: Outcome[];
  tradingStatusEvidence?: SecurityTradingStatus;
  postClose?: boolean;
  firstWatchPayload?: string;
  confirmation?: { price: number | null; source: string };
  paperFillId?: string;
};
export const alertSubscriptionSchema = z.object({
  id: z.string().min(1).max(100),
  enabled: z.boolean(),
  channels: z.array(z.string().min(1)).max(30),
  kinds: z.array(z.enum(alertKinds)).min(1),
  symbols: z.array(z.string().min(1)).max(6000).default([]),
  strategyIds: z.array(z.string().min(1)).max(100).default([]),
  market: z.enum(["cn-equity", "crypto"]),
});
export type AlertSubscription = z.infer<typeof alertSubscriptionSchema> & {
  revision: string;
};
export const alertHistorySchema = z.object({
  key: z.string().min(1).max(1000).optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  page: z.number().int().min(0).max(1000000).default(0),
  size: z.number().int().min(1).max(100).default(20),
  symbol: z.string().max(80).default(""),
  strategyId: z.string().max(150).default(""),
  kind: z.enum(alertKinds).optional(),
  mode: z.enum(alertModes).optional(),
  market: z.enum(["cn-equity", "crypto"]).optional(),
});
export type AlertHistoryInput = z.infer<typeof alertHistorySchema>;
export const alertKey = (
  event: Pick<
    AlertEvent,
    | "strategyId"
    | "version"
    | "market"
    | "symbol"
    | "bar"
    | "type"
    | "price"
    | "paperFillId"
  >,
) =>
  JSON.stringify([
    event.strategyId,
    event.version,
    event.market,
    event.symbol,
    event.bar,
    event.type,
    event.price,
    ...(event.paperFillId ? ["paper-fill", event.paperFillId] : []),
  ]);
