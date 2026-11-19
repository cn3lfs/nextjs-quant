import { z } from "zod";
import { strategyObjectSchema } from "trading-strategies";
import { researchDateSchema } from "trading-strategies/research/contracts/date";
import { researchCostScenarios } from "trading-strategy-core/costs";
export const labBacktestSourceSchema = z
  .enum(["local", "thsdk"])
  .default("local");
export const labBacktestCostScenarioSchema = z
  .enum(researchCostScenarios)
  .default("fixed");
export const labBacktestSchema = z
  .object({
    source: labBacktestSourceSchema,
    strategy: strategyObjectSchema,
    start: researchDateSchema,
    end: researchDateSchema,
    initial: z.number().finite().positive().max(1e9),
    riskPerTrade: z.number().finite().positive().max(0.1).default(0.01),
    maxPositions: z.number().int().positive().max(100).default(10),
    costScenario: labBacktestCostScenarioSchema,
  })
  .strict()
  .refine(
    (v) =>
      v.source !== "thsdk" ||
      !["triple-screen", "utc-orb"].includes(v.strategy.entry.kind),
    "多周期理论策略需要本地日历与归档证据，请使用本地数据源",
  )
  .refine(
    (v) => v.source !== "thsdk" || v.strategy.market === "cn-equity",
    "同花顺数据源仅支持 A 股策略回测",
  )
  .refine(
    (v) => v.start < v.end && v.end < new Date().toISOString().slice(0, 10),
    "仅允许完整历史日期，开始须早于结束",
  );
