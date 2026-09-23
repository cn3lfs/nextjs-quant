import { z } from "zod";
import { researchKinds, researchRangeSchema } from "./research-usage";

export const researchAttemptStates = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
] as const;
export const researchAttemptSchema = z.object({
  version: z.literal("research-attempt-1"),
  id: z.string(),
  taskId: z.string(),
  kind: z.enum(researchKinds),
  state: z.enum(researchAttemptStates),
  ownerPid: z.number().int(),
  createdAt: z.number(),
  updatedAt: z.number(),
  configHash: z.string(),
  requestedRange: researchRangeSchema.nullable(),
  actualRange: researchRangeSchema.nullable(),
  symbols: z.array(z.string()),
  resultId: z.string().nullable(),
  error: z.string().nullable(),
  usageId: z.string().nullable(),
  auditIncomplete: z.boolean().default(false),
});
export type ResearchAttempt = z.infer<typeof researchAttemptSchema>;
export type ResearchMode = "exploration" | "final-validation";
export const isAttemptTerminal = (state: ResearchAttempt["state"]) =>
  state !== "queued" && state !== "running";
export const researchAttemptsQuerySchema = z.object({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
  kind: z.enum(researchKinds).optional(),
  state: z.enum(researchAttemptStates).optional(),
});
