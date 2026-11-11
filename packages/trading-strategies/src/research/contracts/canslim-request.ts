import { z } from "zod";
import { symbolSchema } from "./security.js";
import { researchDateSchema } from "./date.js";
import { asOfTimestampSchema } from "./time.js";
export const canslimAsOfRequestSchema = z
  .object({
    symbol: symbolSchema,
    asOf: asOfTimestampSchema,
    capturedBy: asOfTimestampSchema.optional(),
    observationDate: researchDateSchema,
    // Explicit expected periods: absent disclosures produce visible missing rows.
    financialPeriods: z.array(researchDateSchema).min(1).max(100),
    annualPeriods: z.array(researchDateSchema).min(1).max(100),
    institutionPeriods: z.array(researchDateSchema).min(1).max(100),
    universeId: z.string().trim().min(1),
    benchmarkId: z.string().trim().min(1),
  })
  .strict();
export type CanslimAsOfRequest = z.infer<typeof canslimAsOfRequestSchema>;
