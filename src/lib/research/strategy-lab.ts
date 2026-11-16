import { z } from "zod";
export const labIdentitySchema = z
  .object({
    id: z.string().min(1).max(150),
    version: z.number().int().positive(),
  })
  .strict();
export const labQuerySchema = z
  .object({
    market: z.enum(["cn-equity", "crypto"]),
    query: z.string().max(150).default(""),
    page: z.number().int().min(0).max(100000).default(0),
  })
  .strict();
export const labActionSchema = labIdentitySchema
  .extend({
    action: z.enum(["shadow", "promote", "live", "pause", "pause-live"]),
    confirmed: z.literal(true),
    revision: z.string().min(1).max(100),
    riskAccepted: z.literal(true).optional(),
  })
  .strict();
export const labActionLabels = {
  shadow: "开启影子前推",
  promote: "晋级策略",
  live: "开启 live 提醒",
  pause: "暂停策略观察与提醒",
  "pause-live": "暂停 live 提醒",
};
