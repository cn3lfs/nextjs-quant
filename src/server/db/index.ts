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
export function list<T>(kind: string, limit = 200): T[] {
  return db()
    .select()
    .from(schema.records)
    .where(eq(schema.records.kind, kind))
    .orderBy(desc(schema.records.updatedAt))
    .limit(limit)
    .all()
    .map((r) => r.payload as T);
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
    return sqlite().transaction(fn)();
  } finally {
    receipts.clear();
  }
}
