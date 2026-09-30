import type { Job } from "~/lib/domain";
import { sqlite } from "../db";
import { taskStateColumns, taskTextPreview } from "./task-history";

/** Project before crossing into JS: historical screen results can be very large. */
/** Uses the job_recent_summary index (migrations.ts jobTaskIndexes). */
export const jobSummariesSql = `
    SELECT ${taskStateColumns},
      substr(json_extract(payload, '$.phase'), 1, 128) AS phase,
      substr(json_extract(payload, '$.error'), 1, 128) AS error
    FROM records INDEXED BY job_recent_summary
    WHERE kind = 'job' ORDER BY updated_at DESC LIMIT 80
  `;
type SummaryRow = Omit<
  Job,
  "input" | "result" | "phase" | "error" | "attemptId" | "auditIncomplete"
> & {
  phase: string | null;
  error: string | null;
  attemptId: string | null;
  auditIncomplete: number | null;
};
export function jobSummaries(): Omit<Job, "input" | "result">[] {
  const rows = sqlite().prepare(jobSummariesSql).all() as Record<
    string,
    unknown
  >[];
  return rows.map((row) => {
    const { phase, error, attemptId, auditIncomplete, ...state } =
      row as SummaryRow;
    return {
      ...state,
      ...(attemptId != null ? { attemptId } : {}),
      ...(auditIncomplete != null
        ? { auditIncomplete: Boolean(auditIncomplete) }
        : {}),
      ...(phase != null ? { phase: taskTextPreview(phase, 28) } : {}),
      ...(error != null ? { error: taskTextPreview(error, 28) } : {}),
    };
  });
}
