import { z } from "zod";

export const researchDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) =>
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 10) === value,
    "日期无效",
  );
export const researchRangeSchema = z
  .object({ start: researchDateSchema, end: researchDateSchema })
  .refine((range) => range.start <= range.end, "起点不能晚于终点");
export const researchKinds = [
  "walk-forward",
  "backtest",
  "formula-screen",
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
  records: readonly ResearchUsage[],
  range: ResearchRange,
  holdoutStart: string | null = null,
) {
  const rows = records.filter(
    (row) => row.range.start <= range.end && row.range.end >= range.start,
  );
  const distinctConfigs = new Set(rows.map((row) => row.configHash)).size;
  const candidateSum = rows.reduce((sum, row) => sum + row.candidateCount, 0);
  // Re-evaluate historical coverage against the current boundary; never erase recorded touches.
  const touches =
    holdoutStart === null
      ? []
      : records.filter((row) => row.range.end >= holdoutStart);
  const earliest = (values: readonly ResearchUsage[]) =>
    values.reduce<number | null>(
      (at, row) => (at === null ? row.at : Math.min(at, row.at)),
      null,
    );
  return {
    runs: rows.length,
    distinctConfigs,
    candidateSum,
    trialLowerBound: Math.max(candidateSum, distinctConfigs),
    reason: researchUsageReason,
    firstRunAt: earliest(rows),
    lastRunAt: rows.reduce<number | null>(
      (at, row) => (at === null ? row.at : Math.max(at, row.at)),
      null,
    ),
    byKind: Object.fromEntries(
      researchKinds.map((kind) => [
        kind,
        rows.filter((row) => row.kind === kind).length,
      ]),
    ) as Record<ResearchUsage["kind"], number>,
    holdout: {
      start: holdoutStart,
      touches: touches.length,
      firstTouchAt: earliest(touches),
      distinctConfigs: new Set(touches.map((row) => row.configHash)).size,
    },
  };
}
export type ResearchUsageSummary = ReturnType<typeof summarizeResearchUsage>;
