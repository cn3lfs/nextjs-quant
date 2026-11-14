import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import * as schema from "./schema";
import { eq, desc } from "drizzle-orm";
import { migrate } from "./migrations";
import { WriteReceipts } from "./write-receipts";
export function dataDirectory() {
  return (
    process.env.QUANT_DATA_DIR ??
    join(process.env.LOCALAPPDATA ?? homedir(), "QuantWorkbench")
  );
}
let connection: Database.Database | undefined;
let receipts: WriteReceipts;
export function sqlite() {
  if (connection) return connection;
  mkdirSync(dataDirectory(), { recursive: true });
  connection = new Database(join(dataDirectory(), "quant.sqlite"));
  connection.pragma("journal_mode = WAL");
  connection.pragma("busy_timeout = 5000");
  migrate(connection);
  receipts = new WriteReceipts(connection);
  return connection;
}
export const db = () => drizzle(sqlite(), { schema });
export function put<T>(kind: string, id: string, value: T) {
  sqlite();
  receipts.observeLocal();
  receipts.forget(id);
  const updatedAt = Date.now();
  db()
    .insert(schema.records)
    .values({ id, kind, payload: value, updatedAt })
    .onConflictDoUpdate({
      target: schema.records.id,
      set: { kind, payload: value, updatedAt },
    })
    .run();
  receipts.acknowledgeLocal();
  return value;
}
export function get<T>(id: string): T | undefined {
  return db()
    .select()
    .from(schema.records)
    .where(eq(schema.records.id, id))
    .get()?.payload as T | undefined;
}
/** Preserve the existing upsert contract, but do not rewrite identical records. */
export function putChangedBatch<T extends { id: string }>(
  kind: string,
  values: T[],
  stringify: (value: T) => string = JSON.stringify,
  beforeWrite?: () => void,
) {
  const connection = sqlite();
  // Nested callers may later roll back; only publish receipts after our own commit.
  const nested = connection.inTransaction;
  if (nested) receipts.clear();
  const committed = new Map<string, string>();
  const statement = connection.prepare(`
    INSERT INTO records (id, kind, payload, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      kind=excluded.kind, payload=excluded.payload, updated_at=excluded.updated_at
    WHERE records.kind <> excluded.kind OR records.payload <> excluded.payload
  `);
  try {
    const changed = connection
      .transaction(() => {
        beforeWrite?.();
        receipts.observeLocal();
        receipts.observeExternal(kind);
        let changed = 0;
        for (const value of values) {
          const payload = stringify(value);
          if (
            !nested &&
            (committed.get(value.id) ??
              (receipts.matches(value.id, kind, payload)
                ? payload
                : undefined)) === payload
          )
            continue;
          changed += statement.run(value.id, kind, payload, Date.now()).changes;
          committed.set(value.id, payload);
        }
        receipts.acknowledgeKind(kind);
        return changed;
      })
      .immediate();
    receipts.acknowledgeLocal();
    if (!nested)
      for (const [id, payload] of committed)
        receipts.remember(id, kind, payload);
    return changed;
  } catch (error) {
    receipts.clear();
    throw error;
  }
}
function validateRecordLimit(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new RangeError("记录读取上限必须是 1–1000 的整数");
}

/** Recent records only. A limit is mandatory; use readRecordSnapshot for a full scan. */
export function list<T>(kind: string, limit: number): T[] {
  validateRecordLimit(limit);
  return db()
    .select()
    .from(schema.records)
    .where(eq(schema.records.kind, kind))
    .orderBy(desc(schema.records.updatedAt), desc(schema.records.id))
    .limit(limit)
    .all()
    .map((r) => r.payload as T);
}

export type RecordCursor = { kind: string; id: string };

/** ID order is immutable. Separate calls see live data; use a snapshot for totals/export. */
export function recordPage<T>(
  kind: string,
  limit: number,
  cursor?: RecordCursor,
): { items: T[]; nextCursor: RecordCursor | null } {
  validateRecordLimit(limit);
  if (cursor && (cursor.kind !== kind || typeof cursor.id !== "string"))
    throw new Error("记录游标与查询类型不匹配");
  const rows = sqlite()
    .prepare(
      `SELECT id,payload FROM records WHERE kind=? ${cursor ? "AND id>?" : ""}
       ORDER BY id ASC LIMIT ?`,
    )
    .all(...(cursor ? [kind, cursor.id, limit + 1] : [kind, limit + 1])) as {
    id: string;
    payload: string;
  }[];
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    items: page.map((row) => JSON.parse(row.payload) as T),
    nextCursor: hasMore ? { kind, id: page[page.length - 1]!.id } : null,
  };
}

/**
 * Consume synchronously and read-only inside one SQLite read transaction.
 * Payloads are loaded in batches of 200; concurrent external writes are visible
 * on the next scan, never partway through this one. Do not retain the iterable.
 */
export function readRecordSnapshot<T, Result>(
  kind: string,
  read: (records: Iterable<T>) => Result,
): Result {
  return sqlite().transaction(() => {
    let active = true;
    function* records(): Generator<T> {
      let cursor: RecordCursor | undefined;
      do {
        if (!active) throw new Error("记录快照已关闭");
        const page = recordPage<T>(kind, 200, cursor);
        for (const item of page.items) {
          if (!active) throw new Error("记录快照已关闭");
          yield item;
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
    }
    try {
      const result = read(records());
      if (result && typeof (result as { then?: unknown }).then === "function")
        throw new Error("记录快照必须同步读取");
      return result;
    } finally {
      active = false;
    }
  })();
}
export function remove(id: string) {
  const connection = sqlite();
  receipts.observeLocal();
  receipts.forget(id);
  connection.prepare("DELETE FROM records WHERE id=?").run(id);
  receipts.acknowledgeLocal();
}
export function atomic<T>(fn: () => T) {
  try {
    // Background RPS publication can commit between this callback's reads and writes.
    // Acquire the write reservation first: a deferred WAL snapshot cannot upgrade
    // after another writer commits, even with busy_timeout configured.
    return sqlite().transaction(fn).immediate();
  } finally {
    receipts.clear();
  }
}
