import { z } from "zod";
import { asOfTimestampSchema } from "../evidence/as-of";

const slotSchema = z
  .object({
    start: asOfTimestampSchema,
    availableAt: asOfTimestampSchema,
    capturedAt: asOfTimestampSchema,
    volume: z.number().finite().nonnegative(),
  })
  .strict();
export const cryptoTimeSlotSchema = z
  .object({
    market: z.literal("crypto-24x7"),
    symbol: z.string().trim().min(1),
    source: z.string().trim().min(1),
    unit: z.literal("base-asset-units"),
    evidence: z.string().trim().min(1),
    asOf: asOfTimestampSchema,
    capturedBy: asOfTimestampSchema,
    target: slotSchema,
    history: z.array(slotSchema),
  })
  .strict();

/** Deferred-market method; UTC hour slots avoid DST or stock-session substitutions. */
export function evaluateCryptoTimeSlot(raw: unknown) {
  const p = cryptoTimeSlotSchema.safeParse(raw);
  const boundary =
    "VP-crypto-time-slot：后续7x24品种；UTC完整小时，同小时前7日及同星期同小时前4周分别比较，不与日均量比较；无A股交易输出";
  if (!p.success)
    return {
      status: "missing" as const,
      boundary,
      reason: p.error.message,
      variants: [],
    };
  const v = p.data,
    hour = 3600000,
    at = Date.parse(v.target.start);
  const all = [...v.history, v.target];
  if (
    new Set(all.map((r) => Date.parse(r.start))).size !== all.length ||
    all.some(
      (r) =>
        Date.parse(r.start) % hour !== 0 ||
        Date.parse(r.availableAt) < Date.parse(r.start) + hour ||
        Date.parse(r.availableAt) > Date.parse(v.asOf) ||
        Date.parse(r.capturedAt) < Date.parse(r.availableAt) ||
        Date.parse(r.capturedAt) > Date.parse(v.capturedBy),
    ) ||
    v.history.some((r) => Date.parse(r.start) >= at)
  )
    return {
      status: "missing" as const,
      boundary,
      reason: "小时窗口/可知时点/采集截止或历史身份无效",
      variants: [],
    };
  const variants = (
    [
      { id: "same-hour-7-days", count: 7, stride: 24 },
      { id: "same-weekday-hour-4-weeks", count: 4, stride: 168 },
    ] as const
  ).map((policy) => {
    const slots = Array.from({ length: policy.count }, (_, i) =>
      v.history.find(
        (r) => Date.parse(r.start) === at - (i + 1) * policy.stride * hour,
      ),
    );
    const mean = slots.every((r) => r != null)
      ? slots.reduce((n, r) => n + r!.volume / policy.count, 0)
      : null;
    const reason =
      mean == null ? "同期同时段历史缺口" : mean <= 0 ? "基准均量为零" : null;
    return {
      ...policy,
      mean,
      ratio: reason ? null : v.target.volume / mean!,
      reason,
      slots: slots.map((r) => r ?? null),
      source: v.source,
      unit: v.unit,
    };
  });
  return {
    status: variants.some((r) => r.reason)
      ? ("missing" as const)
      : ("computed" as const),
    boundary,
    reason: variants.some((r) => r.reason)
      ? "保留各版本缺口，不以另一版本填充"
      : null,
    variants,
    stockBacktestEligible: false,
    realBacktest: false,
  };
}
