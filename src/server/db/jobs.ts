import { z } from "zod";
import type { Job } from "~/lib/domain";
import { newsArchiveIdSchema } from "~/lib/news/news-workspace";
import { put, sqlite } from "./index";
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

/** Explicit detail read. Lists/polling must use the metadata repositories. */
export function readJob(id: string): Job | undefined {
  jobIdSchema.parse(id);
  return readSnapshot(() => {
    const statement = sqlite()
      .prepare(`SELECT substr(CAST(payload AS BLOB),@offset,262144) chunk
      FROM records WHERE id=@id AND kind='job'`);
    const parts: string[] = [];
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (let offset = 1; ; offset += 262144) {
      const row = statement.get({ id, offset }) as
        { chunk: Buffer } | undefined;
      if (!row) return undefined;
      parts.push(decoder.decode(row.chunk, { stream: true }));
      if (row.chunk.length < 262144) break;
    }
    parts.push(decoder.decode());
    return JSON.parse(parts.join("")) as Job;
  });
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
