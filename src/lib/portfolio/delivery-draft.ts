import { z } from "zod";
export const deliveryDraftSchema = z.object({
  path: z.string().max(2048),
  account: z.string().max(64),
  source: z.enum(["generic", "ths", "eastmoney", "tdx"]),
  scope: z.enum(["all", "cashFlowsOnly"]),
});
export const deliveryRecoverySchema = z.object({
  account: z.string().min(1).max(64),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  source: deliveryDraftSchema.shape.source,
  scope: deliveryDraftSchema.shape.scope,
});
export type DeliveryDraft = z.infer<typeof deliveryDraftSchema>;
export type DeliveryRecovery = z.infer<typeof deliveryRecoverySchema>;
export const emptyDeliveryDraft: DeliveryDraft = {
  path: "",
  account: "",
  source: "generic",
  scope: "all",
};
const sessionSchema = z.object({
  directory: z.string().max(2048),
  draft: deliveryDraftSchema,
  pending: deliveryRecoverySchema.nullable(),
});
export function restoreDeliveryDraft(text: string | null) {
  try {
    return sessionSchema.parse(JSON.parse(text ?? ""));
  } catch {
    return null;
  }
}
