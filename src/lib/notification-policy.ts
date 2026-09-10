import { z } from "zod";

export const deliveryTierSchema = z.enum(["immediate", "summary", "ledger"]);
export type DeliveryTier = z.infer<typeof deliveryTierSchema>;
export const tierLabels: Record<DeliveryTier, string> = {
  immediate: "立即推送",
  summary: "并入收盘汇总",
  ledger: "仅入台账不推送",
};
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const notificationPolicySchema = z
  .object({
    czsc: z
      .object({
        observe: deliveryTierSchema.default("ledger"),
        confirmed: deliveryTierSchema.default("summary"),
        strong: deliveryTierSchema.default("immediate"),
      })
      .default({}),
    breakout: z
      .object({
        highMin: z.number().int().min(0).max(5).default(5),
        middleMin: z.number().int().min(0).max(5).default(3),
        high: deliveryTierSchema.default("immediate"),
        middle: deliveryTierSchema.default("summary"),
        low: deliveryTierSchema.default("ledger"),
      })
      .refine((v) => v.middleMin < v.highMin, "双突破中档阈值必须小于高档阈值")
      .default({}),
    // Per destination: reserve one of the daily message slots for the digest.
    dailyLimit: z.number().int().min(1).max(100).default(5),
    dedupTradingDays: z.number().int().min(0).max(60).default(3),
    quietOutsideTrading: z.boolean().default(true),
    quietEnabled: z.boolean().default(false),
    quietStart: time.default("20:00"),
    quietEnd: time.default("09:30"),
    // A short, explicit exception to non-trading quiet; custom quiet still wins.
    summaryTime: time
      .refine(
        (v) => v >= "15:05" && v <= "23:30",
        "汇总时间需在15:05至23:30之间",
      )
      .default("15:15"),
  })
  .default({});
export type NotificationPolicy = z.infer<typeof notificationPolicySchema>;
export type PolicyUnit = {
  symbol: string;
  strategy: "czsc" | "dual-breakout";
  date: string;
  endpointDate: string;
  direction: "long" | "short";
  score: number;
  pointKey?: string;
};
export type NotificationDecision = PolicyUnit & {
  messageKind?: "signal" | "analysis";
  id: string;
  signalId?: string;
  channelId?: string;
  deliveryId?: string;
  summaryId?: string;
  body?: string;
  tier: DeliveryTier;
  reasons: string[];
  policy: NotificationPolicy;
  createdAt: number;
};
export const chinaClock = (now: number) => {
  const iso = new Date(now + 8 * 3600000).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
};
export const minutes = (value: string) =>
  Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
export function grade(
  unit: Pick<PolicyUnit, "strategy" | "score">,
  p: NotificationPolicy,
): DeliveryTier {
  if (!Number.isInteger(unit.score)) return "ledger";
  if (unit.strategy === "czsc")
    return (
      ([p.czsc.observe, p.czsc.confirmed, p.czsc.strong] as const)[
        unit.score
      ] ?? "ledger"
    );
  if (unit.score < 0 || unit.score > 5) return "ledger";
  return unit.score >= p.breakout.highMin
    ? p.breakout.high
    : unit.score >= p.breakout.middleMin
      ? p.breakout.middle
      : p.breakout.low;
}
export function customQuiet(now: number, p: NotificationPolicy) {
  if (!p.quietEnabled) return false;
  const t = chinaClock(now).time;
  // Equal endpoints deliberately mean all day, never accidentally no silence.
  return p.quietStart < p.quietEnd
    ? t >= p.quietStart && t < p.quietEnd
    : t >= p.quietStart || t < p.quietEnd;
}
export function quiet(now: number, days: string[], p: NotificationPolicy) {
  const c = chinaClock(now);
  return (
    customQuiet(now, p) ||
    (p.quietOutsideTrading &&
      (!days.includes(c.date) ||
        !(
          (c.time >= "09:30" && c.time < "11:30") ||
          (c.time >= "13:00" && c.time < "15:00")
        )))
  );
}
export function summaryWindow(
  now: number,
  days: string[],
  p: NotificationPolicy,
) {
  const c = chinaClock(now),
    elapsed = minutes(c.time) - minutes(p.summaryTime);
  return (
    days.includes(c.date) &&
    elapsed >= 0 &&
    elapsed < 15 &&
    !customQuiet(now, p)
  );
}
export function withinTradingWindow(
  previous: string,
  current: string,
  days: string[],
  n: number,
) {
  if (!n) return false;
  const ordered = [...new Set(days)].sort();
  const a = ordered.indexOf(previous),
    b = ordered.indexOf(current);
  // Missing coverage fails closed; do not replace exchange dates with weekdays.
  return a < 0 || b < 0 || b - a < n;
}
