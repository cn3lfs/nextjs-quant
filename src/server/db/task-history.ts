import { sqlite } from "../db";
import {
  taskHistoryInput,
  type TaskState,
} from "~/lib/research/workflow/task-history";
import type { z } from "zod";
import { workProgressSchema } from "~/lib/research/workflow/work-progress";

export const taskStateFields = `
 'id', id, 'type', json_extract(payload, '$.type'),
 'status', json_extract(payload, '$.status'), 'progress', json_extract(payload, '$.progress'),
 'createdAt', json_extract(payload, '$.createdAt'), 'updatedAt', json_extract(payload, '$.updatedAt')`;
const created = "json_extract(payload, '$.createdAt')";
/**
 * Plain columns, not json_object(): SQLite serves these from the covering job
 * indexes only when they are selected directly (migrations.ts jobTaskIndexes).
 */
export const taskStateColumns = `id,
 json_extract(payload, '$.type') AS type, json_extract(payload, '$.status') AS status,
 json_extract(payload, '$.progress') AS progress, json_extract(payload, '$.createdAt') AS createdAt,
 json_extract(payload, '$.updatedAt') AS updatedAt,
 json_extract(payload, '$.attemptId') AS attemptId,
 json_extract(payload, '$.auditIncomplete') AS auditIncomplete`;
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
/** One page of task metadata; ordered and covered by job_task_history. */
export const taskHistorySql = (pageFilter: string) =>
  `SELECT ${taskStateColumns},
      substr(json_extract(payload, '$.phase'), 1, 128) AS phase,
      substr(json_extract(payload, '$.error'), 1, 128) AS error,
      length(json_extract(payload, '$.phase')) > 128 AS phaseTruncated,
      length(json_extract(payload, '$.error')) > 128 AS errorTruncated
    FROM records WHERE ${pageFilter}
    ORDER BY ${created} DESC, id DESC LIMIT 21`;
export function taskHistory(input: z.infer<typeof taskHistoryInput>) {
  const { status, type, id, cursor } = taskHistoryInput.parse(input);
  const filter =
    "kind = 'job'" +
    (status ? " AND json_extract(payload, '$.status') = ?" : "") +
    (type ? " AND json_extract(payload, '$.type') = ?" : "") +
    (id ? " AND id = ?" : "");
  const filterArgs = [status, type, id].filter(
    (value): value is string => value !== undefined,
  );
  const args: (string | number)[] = [...filterArgs];
  const pageFilter =
    filter +
    (cursor ? ` AND (${created} < ? OR (${created} = ? AND id < ?))` : "");
  if (cursor) args.push(cursor.createdAt, cursor.createdAt, cursor.id);
  return sqlite().transaction(() => {
    const rows = sqlite()
      .prepare(taskHistorySql(pageFilter))
      .all(...args) as Record<string, unknown>[];
    const items = rows.slice(0, 20).map((row) => {
      const { attemptId, auditIncomplete, ...value } = row as TaskState & {
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
          .get(...filterArgs) as { n: number }
      ).n,
      nextCursor:
        rows.length > 20 && last
          ? { createdAt: last.createdAt, id: last.id }
          : null,
      hasMore: rows.length > 20,
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
    'workProgress', json_extract(payload, '$.workProgress'),
    'inputType', json_extract(payload, '$.input.type'),
    'inputKind', json_extract(payload, '$.input.kind'),
    'inputMethod', json_extract(payload, '$.input.method'),
    'screenResultId', CASE WHEN json_extract(payload, '$.type') = 'screen'
      AND json_extract(payload, '$.input.type') = 'formula-screen'
      AND json_extract(payload, '$.status') = 'completed'
      AND json_type(payload, '$.result') = 'object' THEN id
      ELSE NULL END
    ) AS payload FROM records WHERE kind = 'job' AND id = ?`,
    )
    .get(id) as { payload: string } | undefined;
  if (!row) return null;
  const {
    attemptId,
    auditIncomplete,
    inputType,
    inputKind,
    inputMethod,
    ...value
  } = JSON.parse(row.payload);
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
    screenResultId: value.screenResultId ?? undefined,
    isFormulaScreen: value.type === "screen" && inputType === "formula-screen",
    resultLink: taskResultLink(id),
    sourceLink: taskSourceLink(value.type, inputType, inputKind, inputMethod),
  };
}

function taskSourceLink(
  type: string,
  inputType: unknown,
  kind: unknown,
  method: unknown,
): TaskState["sourceLink"] {
  let href: string | undefined;
  if (type === "scan") href = "/system";
  else if (type === "screen" && inputType === "formula-screen")
    href = "/scan?tab=formula";
  else if (type === "backtest") href = "/lab/backtest";
  else if (
    type === "research" &&
    typeof kind === "string" &&
    [
      "news-analysis",
      "automatic-news-analysis",
      "news-sector",
      "news-themes",
      "theme-prices",
      "theme-price-explanation",
    ].includes(kind)
  )
    href = "/intel";
  else if (type === "research" && (method === "general" || method === "sepa"))
    href = "/lab/analysis";
  return href ? { href, label: "前往来源页重新配置" } : undefined;
}

// Only expose a destination for a persisted report, never infer one from status
// or materialize the job result (which can contain a whole screening universe).
function taskResultLink(id: string): TaskState["resultLink"] {
  const report = sqlite()
    .prepare(
      `
    SELECT r.id, r.kind FROM records j JOIN records r
    ON r.id = COALESCE(json_extract(j.payload, '$.result.reportId'), json_extract(j.payload, '$.result.id'))
    WHERE j.kind = 'job' AND j.id = ?
      AND json_extract(j.payload, '$.type') = 'research'
      AND json_extract(j.payload, '$.status') = 'completed'
      AND r.kind='report'
  `,
    )
    .get(id) as { id: string; kind: string } | undefined;
  if (!report || report.id.length > 200) return undefined;
  return {
    href: `/lab/reports/${report.kind}/${encodeURIComponent(report.id)}`,
    label: "查看研究报告",
  };
}
export function screenTaskProgress(id: string) {
  const task = taskState(id);
  return task?.isFormulaScreen ? task : null;
}
