import { z } from "zod";

export const evidenceEnvelopeSchema = z.object({
  version: z.literal("evidence-1"),
  source: z.string().min(1),
  symbol: z.string().nullable(),
  type: z.enum(["bars", "quote-financial", "announcement", "news"]),
  asOf: z.string().nullable(),
  publishedAt: z.string().nullable(),
  fetchedAt: z.number().int().nonnegative(),
  currency: z.string().nullable(),
  unit: z.record(z.string()),
  adjustment: z.enum([
    "none",
    "forward",
    "backward",
    "unknown",
    "not-applicable",
  ]),
  reportPeriod: z.string().nullable(),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  quality: z.enum(["validated", "partial", "unavailable"]),
  warnings: z.array(z.string()),
});
export type EvidenceEnvelope = z.infer<typeof evidenceEnvelopeSchema>;
