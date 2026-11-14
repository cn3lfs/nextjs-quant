import type { Job } from "~/lib/domain";
import { jobIdSchema } from "./jobs";
import { sqlite } from "./index";
import { readSnapshot } from "./snapshot";

export const resultBatchRows = 1;
export const resultBatchBytes = 256 * 1024;
type ArrayRow = { position: number; payload: string | null };

/** Final exports can grow with the complete result. Each DB->JS transfer is
 * bounded to 256 KiB; arrays stream one element at a time. SQLite still parses JSON.
 * Concurrent commits are visible on the next snapshot, never midway through it.
 */
export function readJobResultSnapshot<T>(
  id: string,
  read: (source: {
    job: Pick<Job, "id" | "type" | "status" | "createdAt" | "updatedAt">;
    json: <Value>(path: string, omitPaths?: readonly string[]) => Value;
    array: <Value>(path: string) => Iterable<Value>;
  }) => T,
): T | null {
  jobIdSchema.parse(id);
  return readSnapshot(() => {
    const db = sqlite();
    const job = db
      .prepare(
        `SELECT id, json_extract(payload,'$.type') type,
      json_extract(payload,'$.status') status,
      json_extract(payload,'$.createdAt') createdAt,
      json_extract(payload,'$.updatedAt') updatedAt
      FROM records WHERE kind='job' AND id=?`,
      )
      .get(id) as
      | Pick<Job, "id" | "type" | "status" | "createdAt" | "updatedAt">
      | undefined;
    if (!job) return null;
    let active = true;
    const cursors = new Set<IterableIterator<ArrayRow>>();
    const assertActive = () => {
      if (!active) throw new Error("任务结果快照已关闭");
    };
    function json<Value>(
      path: string,
      omitPaths: readonly string[] = [],
    ): Value {
      assertActive();
      // Paths are bound values; callers select fields, never provide SQL.
      // json_quote preserves strings, booleans and null alongside objects.
      const expression = `CASE json_type(payload,@path)
        WHEN 'true' THEN 'true' WHEN 'false' THEN 'false'
        ELSE json_quote(json_extract(payload,@path)) END`;
      const projected = omitPaths.length
        ? `json_remove(${expression},${omitPaths.map((_, i) => `@omit${i}`).join(",")})`
        : expression;
      const statement =
        db.prepare(`SELECT substr(CAST(${projected} AS BLOB),@offset,@bytes) chunk
        FROM records WHERE kind='job' AND id=@id`);
      const params = Object.fromEntries(
        omitPaths.map((path, i) => [`omit${i}`, path]),
      );
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const parts: string[] = [];
      for (let offset = 1; ; offset += resultBatchBytes) {
        const { chunk } = statement.get({
          id,
          path,
          ...params,
          offset,
          bytes: resultBatchBytes,
        }) as { chunk: Buffer };
        parts.push(decoder.decode(chunk, { stream: true }));
        if (chunk.length < resultBatchBytes) break;
      }
      parts.push(decoder.decode());
      return JSON.parse(parts.join("")) as Value;
    }
    function* array<Value>(path: string): Generator<Value> {
      assertActive();
      const type = db
        .prepare(
          `SELECT json_type(payload,?) type FROM records WHERE kind='job' AND id=?`,
        )
        .get(path, id) as { type: string | null };
      if (type.type !== "array")
        throw new Error(`任务结果缺少有效数组：${path}`);
      // Stream the SQLite cursor instead of reparsing the document for every
      // offset page. Oversized elements transfer as byte chunks on demand.
      const quoted = `CASE j.type WHEN 'true' THEN 'true' WHEN 'false' THEN 'false'
        ELSE json_quote(j.value) END`;
      const statement = db.prepare(`WITH source AS MATERIALIZED (
        SELECT jsonb(payload) document FROM records WHERE kind='job' AND id=@id
      ) SELECT CAST(j.key AS INTEGER) position,
        CASE WHEN length(CAST(${quoted} AS BLOB))<=@bytes THEN ${quoted} END payload
        FROM source,json_each(source.document,@path) j ORDER BY CAST(j.key AS INTEGER)`);
      const rows = statement.iterate({
        id,
        path,
        bytes: resultBatchBytes,
      }) as IterableIterator<ArrayRow>;
      cursors.add(rows);
      try {
        for (const row of rows) {
          assertActive();
          yield row.payload === null
            ? json<Value>(`${path}[${row.position}]`)
            : (JSON.parse(row.payload) as Value);
          assertActive();
        }
      } finally {
        rows.return?.();
        cursors.delete(rows);
      }
    }
    try {
      return read({ job, json, array });
    } finally {
      active = false;
      for (const cursor of cursors) cursor.return?.();
    }
  });
}
