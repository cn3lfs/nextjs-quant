import { z } from "zod";
import { poolSelectionSchema } from "../market/market-pool";
import { rpsPeriods } from "../screening/rps";
import { previewSlots } from "../research/analysis/intraday-preview";

const cutoffSchema = z.string().refine((value) => {
  try {
    previewSlots(value);
    return true;
  } catch {
    return false;
  }
}, "选择交易时段内的5分钟时点");
export const intradayConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    source: z.enum(["tdx-local", "tdx-7709"]).default("tdx-local"),
    pool: poolSelectionSchema
      .nullable()
      .default({ category: "index", name: "中证A500" }),
    rpsPeriod: z
      .number()
      .refine((n) => (rpsPeriods as readonly number[]).includes(n))
      .default(50),
    minimumRps: z.number().min(0).max(100).default(90),
    czscConfig: z.union([z.literal(0), z.literal(1100)]).default(0),
    noon: cutoffSchema.default("11:20"),
    late: cutoffSchema.default("14:40"),
  })
  .superRefine((value, context) => {
    if (value.noon > "11:30")
      context.addIssue({
        code: "custom",
        path: ["noon"],
        message: "午盘时点应在上午",
      });
    if (value.late < "13:05" || value.late >= "15:00")
      context.addIssue({
        code: "custom",
        path: ["late"],
        message: "尾盘时点应在下午收盘前",
      });
  });
export type IntradayConfig = z.infer<typeof intradayConfigSchema>;
export type IntradaySlot = "noon" | "late";

/** The five-minute launch window is exclusive at its end. A missed window
 * cannot become an on-time observation through a later historical replay.
 */
export function intradaySchedule(
  config: IntradayConfig,
  now: number,
  calendar: {
    days: string[];
    closedDays?: string[];
  },
) {
  if (!Number.isFinite(now)) throw new Error("运行时间无效");
  const local = new Date(now + 8 * 3600000).toISOString();
  const date = local.slice(0, 10);
  const days = [...new Set(calendar.days)].sort();
  const previousTradingDay = days.filter((day) => day < date).at(-1) ?? null;
  const trading = days.includes(date)
    ? "open"
    : calendar.closedDays?.includes(date)
      ? "closed"
      : "unknown";
  const slots = (["noon", "late"] as const).map((slot) => {
    const barCutoff = `${date}T${config[slot]}:00+08:00`;
    const at = Date.parse(barCutoff);
    const status = !config.enabled
      ? "disabled"
      : trading !== "open"
        ? trading
        : !previousTradingDay
          ? "unknown"
          : now < at
            ? "pending"
            : now < at + 5 * 60000
              ? "due"
              : "missed";
    return { slot, barCutoff, status };
  });
  return {
    date,
    previousTradingDay,
    trading,
    slots,
    closeDue:
      config.enabled &&
      trading === "open" &&
      now >= Date.parse(`${date}T15:05:00+08:00`),
  };
}
