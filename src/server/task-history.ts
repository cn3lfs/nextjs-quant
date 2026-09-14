import { sqlite } from "./db";
import { taskHistoryInput, type TaskState } from "~/lib/task-history";
import type { z } from "zod";
import { workProgressSchema } from "~/lib/work-progress";

export const taskStateFields = `
 'id', id, 'type', json_extract(payload, '$.type'),
 'status', json_extract(payload, '$.status'), 'progress', json_extract(payload, '$.progress'),
 'createdAt', json_extract(payload, '$.createdAt'), 'updatedAt', json_extract(payload, '$.updatedAt')`;
const created = "json_extract(payload, '$.createdAt')";
// Bound text before materializing in JS, then account for JSON escaping in UTF-8.
export function taskTextPreview(value: string | null, maxBytes = 128) {
  if (value == null) return undefined;
  let result = "";
  for (const char of value) {
    if (Buffer.byteLength(JSON.stringify(result + char + "…")) > maxBytes)
      break;
    result += char;
  }
  return result.length === value.length ? value : result + "…";
}
export function taskHistory(input: z.infer<typeof taskHistoryInput>) {
  const { status, cursor } = taskHistoryInput.parse(input);
  const filter =
    "kind = 'job'" +
    (status ? " AND json_extract(payload, '$.status') = ?" : "");
  const args: (string | number)[] = status ? [status] : [];
  const pageFilter =
    filter +
    (cursor ? ` AND (${created} < ? OR (${created} = ? AND id < ?))` : "");
  if (cursor) args.push(cursor.createdAt, cursor.createdAt, cursor.id);
  return sqlite().transaction(() => {
    const rows = sqlite()
      .prepare(
        `SELECT json_object(${taskStateFields},
      'attemptId', json_extract(payload, '$.attemptId'),
      'auditIncomplete', json_extract(payload, '$.auditIncomplete'),
      'phase', substr(json_extract(payload, '$.phase'), 1, 128),
      'error', substr(json_extract(payload, '$.error'), 1, 128),
      'phaseTruncated', length(json_extract(payload, '$.phase')) > 128,
      'errorTruncated', length(json_extract(payload, '$.error')) > 128
    ) AS payload FROM records WHERE ${pageFilter}
    ORDER BY ${created} DESC, id DESC LIMIT 21`,
      )
      .all(...args) as { payload: string }[];
    const items = rows.slice(0, 20).map((row) => {
      const { attemptId, auditIncomplete, ...value } = JSON.parse(
        row.payload,
      ) as TaskState & {
        phaseTruncated: number;
        errorTruncated: number;
      };
      const phase = taskTextPreview(value.phase ?? null),
        error = taskTextPreview(value.error ?? null);
      return {
        ...value,
        ...(attemptId != null ? { attemptId } : {}),
        ...(auditIncomplete != null
          ? { auditIncomplete: Boolean(auditIncomplete) }
          : {}),
        phase,
        error,
        phaseTruncated:
          !!value.phaseTruncated ||
          (value.phase != null && phase !== value.phase),
        errorTruncated:
          !!value.errorTruncated ||
          (value.error != null && error !== value.error),
      };
    });
    const last = items.at(-1);
    return {
      items,
      total: (
        sqlite()
          .prepare(`SELECT count(*) AS n FROM records WHERE ${filter}`)
          .get(...(status ? [status] : [])) as { n: number }
      ).n,
      nextCursor:
        rows.length > 20 && last
          ? { createdAt: last.createdAt, id: last.id }
          : null,
    };
  })();
}
export function taskState(id: string): TaskState | null {
  const row = sqlite()
    .prepare(
      `SELECT json_object(${taskStateFields},
    'attemptId', json_extract(payload, '$.attemptId'),
    'auditIncomplete', json_extract(payload, '$.auditIncomplete'),
    'phase', json_extract(payload, '$.phase'), 'error', json_extract(payload, '$.error'),
    'workProgress', json_extract(payload, '$.workProgress')
    ) AS payload FROM records WHERE kind = 'job' AND id = ?`,
    )
    .get(id) as { payload: string } | undefined;
  if (!row) return null;
  const { attemptId, auditIncomplete, ...value } = JSON.parse(row.payload);
  const counts = workProgressSchema.safeParse(value.workProgress);
  return {
    ...value,
    ...(attemptId != null ? { attemptId } : {}),
    ...(auditIncomplete != null
      ? { auditIncomplete: Boolean(auditIncomplete) }
      : {}),
    workProgress: counts.success ? counts.data : undefined,
    phase: value.phase ?? undefined,
    error: value.error ?? undefined,
  };
}
export function screenTaskProgress(id: string) {
  const rule = taskState(id);
  if (!rule || rule.type !== "screen") return null;
  const related = sqlite()
    .prepare(
      `SELECT id FROM records WHERE kind='job'
    AND json_extract(payload,'$.type')='research'
    AND json_extract(payload,'$.input.contextId')=?
    AND json_extract(payload,'$.input.mode')='quick-review'
    ORDER BY json_extract(payload,'$.createdAt') DESC,id DESC LIMIT 1`,
    )
    .get(id) as { id: string } | undefined;
  return { rule, research: related ? taskState(related.id) : null };
}
