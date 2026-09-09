import { z } from "zod";
import { sqlite } from "./db";
import { screenTaskProgress, taskTextPreview } from "./task-history";
export const screenReviewsInput = z.object({
  id: z.string().min(1).max(200),
  snapshotIds: z.array(z.string().min(1).max(200)).max(50),
});
export function screenReviews(input: z.infer<typeof screenReviewsInput>) {
  const state = screenTaskProgress(input.id);
  const research = state?.research;
  if (!research) return { research: null, items: [] };
  const db = sqlite();
  const row = db
    .prepare(
      "SELECT json_extract(payload,'$.result.reportIds') AS ids FROM records WHERE id=?",
    )
    .get(research.id) as { ids: string | null };
  const ids = z
    .array(z.string())
    .max(10)
    .safeParse(JSON.parse(row.ids ?? "[]"));
  const allowed = new Set(
    (
      db
        .prepare(
          "SELECT json_extract(value,'$.snapshotId') AS id FROM records, json_each(records.payload,'$.result.candidates') WHERE records.id=? AND records.kind='job'",
        )
        .all(input.id) as { id: string }[]
    )
      .map((r) => r.id)
      .filter((id) => input.snapshotIds.includes(id)),
  );
  const items = [];
  for (const id of ids.success ? ids.data : []) {
    const report = db
      .prepare(
        `SELECT id, json_extract(payload,'$.contextId') AS snapshotId,
      substr(json_extract(payload,'$.summary'),1,300) AS summary,
      json_array(substr(json_extract(payload,'$.risks[0]'),1,128),substr(json_extract(payload,'$.risks[1]'),1,128)) AS risks,
      json_array_length(payload,'$.risks') AS riskCount,
      json_array_length(payload,'$.missing') AS missingCount
      FROM records WHERE id=? AND kind='report' AND json_extract(payload,'$.promptVersion') LIKE 'quick-review-%'`,
      )
      .get(id) as
      | {
          id: string;
          snapshotId: string;
          summary: string;
          risks: string;
          riskCount: number;
          missingCount: number;
        }
      | undefined;
    if (!report || !allowed.has(report.snapshotId)) continue;
    items.push({
      reportId: report.id,
      snapshotId: report.snapshotId,
      summary: taskTextPreview(report.summary, 300),
      risks: (JSON.parse(report.risks) as (string | null)[])
        .filter((risk): risk is string => typeof risk === "string")
        .map((risk) => taskTextPreview(risk, 128)),
      riskCount: report.riskCount,
      missingCount: report.missingCount,
    });
  }
  return { research: { id: research.id, status: research.status }, items };
}
