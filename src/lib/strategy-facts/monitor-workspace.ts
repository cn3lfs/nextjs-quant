import { z } from "zod";

/** UI reads only. Runtime monitoring and outbox readers keep their own contracts. */
export const monitorWorkspaceId = z.string().trim().min(1).max(200);
export const monitorWorkspaceDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return (
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, "日期无效");
export const deliveryStatus = z.enum([
  "pending",
  "sending",
  "sent",
  "failed",
  "expired",
  "cancelled",
]);
const page = {
  query: z.string().trim().max(100).default(""),
  cursor: z.string().max(2048).optional(),
};
const dates = {
  from: monitorWorkspaceDate.optional(),
  to: monitorWorkspaceDate.optional(),
};
const dateRange = (input: { from?: string; to?: string }) =>
  !input.from || !input.to || input.from <= input.to;
const strategy = z.enum(["ma-cross", "czsc", "dual-breakout"]).optional();
export const monitorPageSchema = z.object({
  ...page,
  enabled: z.boolean().optional(),
  strategy,
  symbol: z.string().trim().max(20).optional(),
});
export const signalPageSchema = z
  .object({
    ...page,
    ...dates,
    monitorId: monitorWorkspaceId.optional(),
    symbol: z.string().trim().max(20).optional(),
    strategy,
  })
  .refine(dateRange, "起始日期不能晚于截止日期");
export const deliveryPageSchema = z
  .object({
    ...page,
    ...dates,
    signalId: monitorWorkspaceId.optional(),
    channelId: monitorWorkspaceId.optional(),
    status: deliveryStatus.optional(),
    kind: z.enum(["signal", "analysis", "test", "summary"]).optional(),
  })
  .refine(dateRange, "起始日期不能晚于截止日期");
export const monitorRetrySchema = z.object({
  deliveryId: monitorWorkspaceId,
  requestId: z.string().uuid(),
});

export type MonitorPageInput = z.infer<typeof monitorPageSchema>;
export type SignalPageInput = z.infer<typeof signalPageSchema>;
export type DeliveryPageInput = z.infer<typeof deliveryPageSchema>;

/** Counts delivery records, not channels or recipients; failed originals remain failed. */
export function deliveryOutcomeCounts(
  rows: readonly { status: z.infer<typeof deliveryStatus> }[],
) {
  const counts = {
    pending: 0,
    sending: 0,
    sent: 0,
    failed: 0,
    expired: 0,
    cancelled: 0,
  };
  for (const row of rows) counts[row.status]++;
  return counts;
}
