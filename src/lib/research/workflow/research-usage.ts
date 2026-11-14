import { z } from "zod";

import { researchDateSchema } from "trading-strategies/research/contracts/date";
export const researchRangeSchema = z
  .object({ start: researchDateSchema, end: researchDateSchema })
  .refine((range) => range.start <= range.end, "起点不能晚于终点");
export const researchKinds = [
  "walk-forward",
  "backtest",
  "formula-screen",
  "factor-eval",
  "sample-research",
  "discipline-counterfactual",
] as const;
export const researchUsageSchema = z.object({
  id: z.string().min(1),
  at: z.number().finite(),
  kind: z.enum(researchKinds),
  symbols: z.array(z.string()).min(1),
  universeSize: z.number().int().nonnegative().nullable(),
  range: researchRangeSchema,
  candidateCount: z.number().int().nonnegative(),
  configHash: z.string().min(1),
  touchedHoldout: z.boolean(),
  holdoutStart: researchDateSchema.nullable(),
});
export type ResearchUsage = z.infer<typeof researchUsageSchema>;
export type ResearchRange = z.infer<typeof researchRangeSchema>;
export const researchUsageReason =
  "已记录的试验次数（下界）：台账建立之前的运行没有记录；应用外的思考与筛选不可观测；失败、取消见独立运行审计，不计入成功候选数；台账写入失败可能漏记。跨标的跨配置累计值不能代入 DSR。";

export function summarizeResearchUsage(
  records: Iterable<ResearchUsage>,
  range: ResearchRange,
  holdoutStart: string | null = null,
) {
  const configs = new Set<string>();
  const touchedConfigs = new Set<string>();
  let runs = 0;
  let candidateSum = 0;
  let firstRunAt: number | null = null;
  let lastRunAt: number | null = null;
  let touches = 0;
  let firstTouchAt: number | null = null;
  const byKind = Object.fromEntries(
    researchKinds.map((kind) => [kind, 0]),
  ) as Record<ResearchUsage["kind"], number>;
  for (const row of records) {
    // Holdout coverage spans all recorded runs, independent of the requested range.
    if (holdoutStart !== null && row.range.end >= holdoutStart) {
      touches++;
      touchedConfigs.add(row.configHash);
      firstTouchAt =
        firstTouchAt === null ? row.at : Math.min(firstTouchAt, row.at);
    }
    if (row.range.start > range.end || row.range.end < range.start) continue;
    runs++;
    configs.add(row.configHash);
    candidateSum += row.candidateCount;
    firstRunAt = firstRunAt === null ? row.at : Math.min(firstRunAt, row.at);
    lastRunAt = lastRunAt === null ? row.at : Math.max(lastRunAt, row.at);
    byKind[row.kind]++;
  }
  const distinctConfigs = configs.size;
  return {
    runs,
    distinctConfigs,
    candidateSum,
    trialLowerBound: Math.max(candidateSum, distinctConfigs),
    reason: researchUsageReason,
    firstRunAt,
    lastRunAt,
    byKind,
    holdout: {
      start: holdoutStart,
      touches,
      firstTouchAt,
      distinctConfigs: touchedConfigs.size,
    },
  };
}
export type ResearchUsageSummary = ReturnType<typeof summarizeResearchUsage>;
