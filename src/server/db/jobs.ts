import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { settingsSchema, type Job } from "~/lib/domain";
import { newsArchiveIdSchema } from "~/lib/news/news-workspace";
import { dataDirectory, put, sqlite } from "./index";
import { readSnapshot } from "./snapshot";

export const jobIdSchema = z.string().min(1).max(200);
const jobSchema = z.object({
  id: jobIdSchema,
  type: z.enum([
    "scan",
    "screen",
    "online-screen",
    "backtest",
    "walk-forward",
    "factor-eval",
    "research",
    "market-data-backfill",
    "tdx-import",
    "monitor",
  ]),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  progress: z.number().finite(),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  newsAnalysisId: newsArchiveIdSchema.optional(),
});

/** The primary key locates updated_at; the v23 covering index stores status.
 * This avoids decoding even a large completed job's JSON inside SQLite. */
export function getJobStatus(id: string): Job["status"] | undefined {
  return sqlite()
    .prepare(
      `SELECT json_extract(payload,'$.status') FROM records INDEXED BY job_recent_summary
       WHERE kind='job' AND updated_at=(SELECT updated_at FROM records WHERE id=@id) AND id=@id`,
    )
    .pluck()
    .get({ id }) as Job["status"] | undefined;
}

/** Run a brief synchronous step while holding the SQLite write reservation if
 * the job is still running, so a cross-process cancel cannot commit in between. */
export function runIfJobRunning(id: string, work: () => void): boolean {
  return sqlite()
    .transaction(() => {
      if (getJobStatus(id) !== "running") return false;
      work();
      return true;
    })
    .immediate();
}

/** Explicit detail read. Lists/polling must use the metadata repositories. */
export function readJob(id: string): Job | undefined {
  jobIdSchema.parse(id);
  return readSnapshot(() => readJobPayload(sqlite(), id));
}

type JobReader = Database.Database | DatabaseSync;

function readJobPayload(db: JobReader, id: string): Job | undefined {
  const statement =
    db.prepare(`SELECT substr(CAST(payload AS BLOB),?,262144) chunk
    FROM records WHERE id=? AND kind='job'`);
  const parts: string[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let offset = 1; ; offset += 262144) {
    const row = statement.get(offset, id) as { chunk: Uint8Array } | undefined;
    if (!row) return undefined;
    parts.push(decoder.decode(row.chunk, { stream: true }));
    if (row.chunk.length < 262144) break;
  }
  parts.push(decoder.decode());
  return JSON.parse(parts.join("")) as Job;
}

function readExistingDatabase<T>(
  directory: string,
  read: (db: JobReader) => T,
) {
  const path = join(/* turbopackIgnore: true */ directory, "quant.sqlite");
  if (!existsSync(path)) return null;
  const liveWal = existsSync(path + "-wal");
  if (liveWal && !existsSync(path + "-shm")) return null;
  // Ordinary read-only opens can create WAL sidecars on a checkpointed DB.
  // node:sqlite supports immutable URIs without changing global SQLite options.
  const db = liveWal
    ? new Database(path, { readonly: true, fileMustExist: true })
    : new DatabaseSync(pathToFileURL(path).href + "?immutable=1", {
        readOnly: true,
      });
  try {
    db.exec("BEGIN");
    return read(db);
  } finally {
    db.close();
  }
}

function readValidatedJob(db: JobReader, id: string): Job | null {
  const job = readJobPayload(db, id);
  return job?.id === id && jobSchema.safeParse(job).success ? job : null;
}

export function readJobByIdReadOnly(jobId: string): Job | null {
  const id = jobIdSchema.safeParse(jobId);
  if (!id.success) return null;
  try {
    return readExistingDatabase(dataDirectory(), (db) =>
      readValidatedJob(db, id.data),
    );
  } catch {
    return null;
  }
}

export function readJobByKeyReadOnly(key: string): Job | null {
  try {
    return readExistingDatabase(dataDirectory(), (db) => {
      const claim = db
        .prepare(
          "SELECT json_extract(payload,'$.jobId') AS jobId FROM records WHERE id=? AND kind='job-key'",
        )
        .get(key) as { jobId: unknown } | undefined;
      const id = jobIdSchema.safeParse(claim?.jobId);
      return id.success ? readValidatedJob(db, id.data) : null;
    });
  } catch {
    return null;
  }
}

export function readSettingsTdxRootReadOnly(directory: string) {
  const stored = readExistingDatabase(directory, (db) => {
    const row = db
      .prepare(
        "SELECT payload FROM records WHERE id='settings' AND kind='settings'",
      )
      .get() as { payload: string } | undefined;
    return row && (JSON.parse(row.payload) as unknown);
  });
  return settingsSchema.parse(stored ?? {}).tdxRoot;
}

/** Caller owns lifecycle policy; the repository owns kind safety and persistence. */
export function saveJob(job: Job) {
  // Recovery updates existing recorded formats without inventing missing fields.
  // New jobs use createJob's complete contract; updates validate every provided
  // metadata field and require the identity/status/update time they persist.
  jobSchema
    .partial()
    .required({ id: true, status: true, updatedAt: true })
    .parse(job);
  const db = sqlite();
  return db
    .transaction(() => {
      if (
        db
          .prepare("SELECT id FROM records WHERE id=? AND kind<>'job'")
          .get(job.id)
      )
        throw new Error("任务ID已被其他类型占用");
      return put("job", job.id, job);
    })
    .immediate();
}

export function createJob(job: Job) {
  jobSchema.parse(job);
  return saveJob(job);
}

export function activeJobIds() {
  // Freeze identities only. Recovery may update jobs while consuming this set;
  // jobs added later are left for the next recovery pass.
  return (
    sqlite()
      .prepare(
        `SELECT id FROM records WHERE kind='job'
    AND json_extract(payload,'$.status') IN ('running','queued') ORDER BY id`,
      )
      .all() as { id: string }[]
  ).map((row) => row.id);
}

export function requireRunningFormulaJob(id: string) {
  jobIdSchema.parse(id);
  if (
    !sqlite()
      .prepare(
        `SELECT 1 FROM records WHERE id=? AND kind='job'
    AND json_extract(payload,'$.type')='screen'
    AND json_extract(payload,'$.input.type')='formula-screen'
    AND json_extract(payload,'$.status')='running'`,
      )
      .get(id)
  )
    throw new Error("公式选股任务已取消或不再运行");
}

export type FinancialReplayTaskRow = {
  id: string;
  status: string;
  progress: number;
  phase: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  /** Raw nested input for the financial domain mapper to validate. */
  input: string | null;
  reportId: string | null;
};

/** Narrow projection shared with the financial domain store. It intentionally
 * does not materialize result/curve payloads; input validation stays there. */
export function financialReplayTaskRows(limit = 50): FinancialReplayTaskRow[] {
  const bounded =
    Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 50;
  return sqlite()
    .prepare(
      `SELECT id,
        json_extract(payload, '$.status') AS status,
        json_extract(payload, '$.progress') AS progress,
        json_extract(payload, '$.phase') AS phase,
        json_extract(payload, '$.error') AS error,
        json_extract(payload, '$.createdAt') AS createdAt,
        json_extract(payload, '$.updatedAt') AS updatedAt,
        json_extract(payload, '$.input.input') AS input,
        json_extract(payload, '$.result.reportId') AS reportId
      FROM records
      WHERE kind = 'job'
        AND json_extract(payload, '$.input.type') = 'financial-replay'
      ORDER BY json_extract(payload, '$.createdAt') DESC, id DESC
      LIMIT ?`,
    )
    .all(bounded) as FinancialReplayTaskRow[];
}

export function maBaselineHistory() {
  return sqlite()
    .prepare(
      `SELECT id, json_extract(payload,'$.status') AS status,
    json_extract(payload,'$.input.input.symbol') AS symbol,
    json_extract(payload,'$.createdAt') AS createdAt FROM records
    WHERE kind='job' AND json_extract(payload,'$.input.type')='ma-baseline'
    ORDER BY updated_at DESC,id DESC LIMIT 20`,
    )
    .all() as {
    id: string;
    status: string;
    symbol: string;
    createdAt: number;
  }[];
}
