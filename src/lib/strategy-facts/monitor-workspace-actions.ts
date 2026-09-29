import { z } from "zod";
import { periodSchema, strategySchema, symbolSchema } from "~/lib/domain";
import { marketSourceSchema } from "~/lib/market/market-source";
import { monitorWorkspaceId } from "./monitor-workspace";

export const monitorSaveSchema = z
  .object({
    id: monitorWorkspaceId.optional(),
    expectedVersion: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    name: z.string().trim().min(1).max(80),
    symbols: z.array(symbolSchema).min(1).max(20),
    strategy: strategySchema,
    period: periodSchema,
    source: marketSourceSchema.default("local"),
    channels: z.array(monitorWorkspaceId).max(20),
    ai: z.boolean(),
    enabled: z.boolean(),
  })
  .refine(
    (value) => !value.id || !!value.expectedVersion,
    "编辑订阅必须提供读取时的版本",
  )
  .refine(
    (value) =>
      !["czsc", "dual-breakout"].includes(value.strategy.type ?? "") ||
      value.period === "day",
    "缠论/双突破监控仅支持日线",
  );
export const monitorToggleSchema = z.object({
  id: monitorWorkspaceId,
  expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
  enabled: z.boolean(),
});
export const deliveryConfirmSchema = z.object({
  deliveryId: monitorWorkspaceId,
  requestId: z.string().uuid(),
  expectedChannelVersion: z.string().regex(/^[a-f0-9]{64}$/),
});
