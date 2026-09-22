import type { Job } from "~/lib/domain";
import { sqlite } from "../db";
import { taskStateFields, taskTextPreview } from "./task-history";

/** Project before crossing into JS: historical screen results can be very large. */
export function jobSummaries(): Omit<Job, "input" | "result">[] {
  const rows = sqlite()
    .prepare(
      `
    SELECT json_object(${taskStateFields},
      'attemptId', json_extract(payload, '$.attemptId'),
      'auditIncomplete', json_extract(payload, '$.auditIncomplete'),
      'phase', substr(json_extract(payload, '$.phase'), 1, 128),
      'error', substr(json_extract(payload, '$.error'), 1, 128)) AS payload
    FROM records WHERE kind = 'job' ORDER BY updated_at DESC LIMIT 80
  `,
    )
    .all() as { payload: string }[];
  return rows.map((row) => {
    const { phase, error, attemptId, auditIncomplete, ...state } = JSON.parse(
      row.payload,
    );
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
