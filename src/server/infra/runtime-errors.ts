import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { dataDirectory } from "../db";
import {
  runtimeErrorEvents,
  type RuntimeErrorEvent,
  type RuntimeErrorEntry,
  type RuntimeErrorReport,
} from "~/lib/common/runtime-errors";

// A separate bounded file avoids business-schema migrations and serializes writers
// from the web/RPC processes with SQLite's existing cross-process locking.
const maxEntries = 128;
const maxPages = 128; // 4096-byte pages: at most 512 KiB, plus a bounded rollback journal.
const codes = new Set([
  "EACCES",
  "EPERM",
  "ENOENT",
  "ENOSPC",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
  "SQLITE_FULL",
  "SQLITE_CORRUPT",
  "SQLITE_NOTADB",
  "SQLITE_CONSTRAINT",
  "INVALID_DATA",
  "UNEXPECTED_ERROR",
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const jobIdPattern =
  /^job-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const scope = globalThis as typeof globalThis & {
  quantErrorLosses?: Map<string, number>;
};
const losses = (scope.quantErrorLosses ??= new Map<string, number>());

function location() {
  return join(resolve(dataDirectory()), "logs", "runtime-errors.sqlite");
}
function assertRegularPath(path: string) {
  for (let current = path; ; current = dirname(current)) {
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error("Linked diagnostics path refused");
    if (current === dirname(current)) break;
  }
}
function errorCode(error: unknown) {
  const candidate =
    error && typeof error === "object" && "code" in error ? error.code : null;
  if (typeof candidate === "string" && codes.has(candidate)) return candidate;
  return error instanceof SyntaxError ? "INVALID_DATA" : "UNEXPECTED_ERROR";
}
function openLog(path: string, readonly: boolean) {
  assertRegularPath(path);
  assertRegularPath(`${path}-journal`);
  if (!readonly) mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, {
    readonly,
    fileMustExist: readonly,
    timeout: 25,
  });
  try {
    const version = db.pragma("user_version", { simple: true });
    if (!readonly && version === 0) {
      db.pragma("page_size = 4096");
      db.pragma(`max_page_count = ${maxPages}`);
      db.transaction(() => {
        if (db.pragma("user_version", { simple: true }) === 1) return;
        if (
          db.prepare("SELECT name FROM sqlite_master WHERE type='table'").get()
        )
          throw new Error("Unknown diagnostics file");
        db.exec(`CREATE TABLE errors (
          id TEXT PRIMARY KEY, groupKey TEXT NOT NULL UNIQUE, event TEXT NOT NULL,
          code TEXT NOT NULL, firstSeen INTEGER NOT NULL, lastSeen INTEGER NOT NULL,
          count INTEGER NOT NULL, retryCount INTEGER NOT NULL, jobId TEXT, requestId TEXT
        ); PRAGMA user_version = 1;`);
      }).immediate();
    } else if (version !== 1) throw new Error("Unknown diagnostics version");
    if (!readonly) {
      db.pragma(`max_page_count = ${maxPages}`);
      db.pragma("journal_mode = DELETE");
      db.pragma("secure_delete = ON");
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Never throws or copies error.message/stack/cause, provider responses or request payloads. */
export function recordRuntimeError(
  event: RuntimeErrorEvent,
  error: unknown,
  context: {
    jobId?: string;
    requestId?: string;
    retryCount?: number;
    cancelled?: boolean;
  } = {},
): boolean {
  let db: Database.Database | undefined;
  let path = "";
  try {
    if (
      context.cancelled ||
      (error instanceof Error && error.name === "AbortError")
    )
      return false;
    path = location();
    if (!Object.hasOwn(runtimeErrorEvents, event)) return false;
    const code = errorCode(error);
    const jobId =
      context.jobId && jobIdPattern.test(context.jobId) ? context.jobId : null;
    const requestId =
      context.requestId && uuid.test(context.requestId)
        ? context.requestId
        : null;
    const retryCount =
      Number.isSafeInteger(context.retryCount) && context.retryCount! >= 0
        ? Math.min(context.retryCount!, 1_000_000)
        : 0;
    const now = Date.now();
    // At most one row per event/code/task/minute; repeats retain count and latest time.
    const groupKey = createHash("sha256")
      .update(JSON.stringify([event, code, jobId, Math.floor(now / 60000)]))
      .digest("hex");
    db = openLog(path, false);
    const connection = db;
    connection
      .transaction(() => {
        connection
          .prepare(
            `INSERT INTO errors VALUES (@id,@groupKey,@event,@code,@now,@now,1,@retryCount,@jobId,@requestId)
        ON CONFLICT(groupKey) DO UPDATE SET firstSeen=min(errors.firstSeen,excluded.firstSeen),
        lastSeen=max(errors.lastSeen,excluded.lastSeen),
        count=errors.count+1, retryCount=max(errors.retryCount,excluded.retryCount),
        requestId=coalesce(excluded.requestId,errors.requestId)`,
          )
          .run({
            id: randomUUID(),
            groupKey,
            event,
            code,
            now,
            retryCount,
            jobId,
            requestId,
          });
        connection
          .prepare(
            `DELETE FROM errors WHERE id IN (
        SELECT id FROM errors ORDER BY lastSeen DESC,id DESC LIMIT -1 OFFSET ?
      )`,
          )
          .run(maxEntries);
      })
      .immediate();
    return true;
  } catch {
    // No recursive logger/console call: the caller still owns the original failure.
    if (path) losses.set(path, (losses.get(path) ?? 0) + 1);
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      /* Diagnostics must not replace the original failure. */
    }
  }
}

export function recentRuntimeErrors(): RuntimeErrorReport {
  let db: Database.Database | undefined;
  const path = location();
  const unrecordedInThisProcess = losses.get(path) ?? 0;
  try {
    assertRegularPath(path);
    if (!existsSync(path))
      return {
        entries: [],
        available: unrecordedInThisProcess === 0,
        unrecordedInThisProcess,
      };
    db = openLog(path, true);
    const rows = db
      .prepare(
        "SELECT id,event,code,firstSeen,lastSeen,count,retryCount,jobId,requestId FROM errors ORDER BY lastSeen DESC,id DESC LIMIT 30",
      )
      .all() as Omit<RuntimeErrorEntry, "module" | "stage" | "summary">[];
    const entries = rows.map((row) => {
      if (
        !uuid.test(row.id) ||
        !Object.hasOwn(runtimeErrorEvents, row.event) ||
        !codes.has(row.code) ||
        ![row.firstSeen, row.lastSeen, row.count, row.retryCount].every(
          Number.isSafeInteger,
        ) ||
        row.count < 1 ||
        row.retryCount < 0 ||
        row.lastSeen < row.firstSeen ||
        (row.jobId !== null && !jobIdPattern.test(row.jobId)) ||
        (row.requestId !== null && !uuid.test(row.requestId))
      )
        throw new Error("Invalid diagnostics record");
      return { ...row, ...runtimeErrorEvents[row.event] };
    });
    return { entries, available: true, unrecordedInThisProcess };
  } catch {
    return { entries: [], available: false, unrecordedInThisProcess };
  } finally {
    try {
      db?.close();
    } catch {
      /* Reading diagnostics must not break the task page. */
    }
  }
}
