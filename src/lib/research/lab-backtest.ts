import { z } from "zod";
import { strategyObjectSchema } from "trading-strategies";
import { researchDateSchema } from "trading-strategies/research/contracts/date";
export const labBacktestSchema = z
  .object({
    strategy: strategyObjectSchema,
    start: researchDateSchema,
    end: researchDateSchema,
    initial: z.number().finite().positive().max(1e9),
    riskPerTrade: z.number().finite().positive().max(0.1).default(0.01),
    maxPositions: z.number().int().positive().max(100).default(10),
  })
  .strict()
  .refine(
    (v) => v.start < v.end && v.end < new Date().toISOString().slice(0, 10),
    "仅允许完整历史日期，开始须早于结束",
  );
