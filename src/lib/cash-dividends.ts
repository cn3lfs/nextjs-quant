import { z } from "zod";
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const n = Date.parse(v);
    return Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === v;
  });
export const cashDividendPlanSchema = z
  .object({
    version: z.enum(["cash-dividends-1", "cash-dividends-2"]),
    signalStart: date.optional(),
    warmupWarnings: z.array(z.string()).max(1000).optional(),
    reconciliationHash: z.string().regex(/^[a-f0-9]{64}$/),
    taxBps: z.number().int().min(0).max(10000),
    events: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            announcement: date,
            record: date,
            ex: date,
            pay: date,
            perShare: z.number().finite().nonnegative().max(1e6),
          })
          .refine(
            (e) =>
              e.announcement <= e.record && e.record < e.ex && e.ex <= e.pay,
            "分红日期顺序非法",
          ),
      )
      .max(1000),
  })
  .refine(
    (p) =>
      new Set(p.events.map((e) => e.id)).size === p.events.length &&
      new Set(p.events.map((e) => e.ex)).size === p.events.length,
    "分红事件ID或除权日重复",
  )
  .refine(
    (p) => p.version !== "cash-dividends-2" || p.signalStart !== undefined,
    "复权信号缺少预热覆盖日期",
  );
export type CashDividendPlan = z.infer<typeof cashDividendPlanSchema>;
