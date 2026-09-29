import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";

const factsByDatabase = new WeakMap<
  Database.Database,
  { revision: string; accounts: Map<string, string> }
>();
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** All ledger content, not just counts or the latest batch. SQLite counters only
 * avoid rehashing unchanged content; neither counter is itself a public version.
 * data_version catches other connections; total_changes catches this connection.
 */
export function cashReviewInputIdentity(
  db: Database.Database,
  account: string,
  config: { tdxRoot: string; calendar: string[] },
) {
  const revision = JSON.stringify([
    db.pragma("data_version", { simple: true }),
    db.prepare("SELECT total_changes() n").get(),
  ]);
  let cached = factsByDatabase.get(db);
  if (!cached || cached.revision !== revision) {
    cached = { revision, accounts: new Map() };
    factsByDatabase.set(db, cached);
  }
  let facts = cached.accounts.get(account);
  if (!facts) {
    // A short read transaction fixes the three tables to the same database view.
    facts = db.transaction(() => {
      const digest = createHash("sha256");
      for (const table of ["import_batches", "trade_fills", "cash_flows"]) {
        digest.update(table);
        for (const raw of db
          .prepare(`SELECT * FROM ${table} WHERE account=? ORDER BY id`)
          .iterate(account)) {
          const { payload, ...metadata } = raw as Record<string, unknown> & {
            payload: string;
          };
          // Length-framed raw JSON avoids escaping a large payload a second
          // time. Every metadata field and payload byte still participates;
          // no large serialized evidence is retained by this identity cache.
          digest.update(JSON.stringify(metadata));
          digest.update(`:${Buffer.byteLength(payload)}:`);
          digest.update(payload);
        }
      }
      return digest.digest("hex");
    })();
    if (cached.accounts.size >= 4)
      cached.accounts.delete(cached.accounts.keys().next().value!);
    cached.accounts.set(account, facts);
  }
  let calendarFile: unknown = null;
  if (!config.calendar.length) {
    try {
      const info = statSync(
        join(config.tdxRoot, "vipdoc/sh/lday/sh000001.day"),
      );
      calendarFile = [
        info.dev,
        info.ino,
        info.size,
        info.mtimeMs,
        info.ctimeMs,
        info.birthtimeMs,
      ];
    } catch {
      calendarFile = "unavailable";
    }
  }
  return hash(["cash-workspace-v1", account, facts, config, calendarFile]);
}

export function cashReviewVersion(
  inputIdentity: string,
  calendarHash: string | null,
  cash: unknown,
) {
  return hash(["cash-workspace-v1", inputIdentity, calendarHash, cash]);
}

export function assertCashReviewVersion(actual: string, expected: string) {
  if (actual !== expected) throw new Error("现金核对数据已更新，请刷新后重试");
}
