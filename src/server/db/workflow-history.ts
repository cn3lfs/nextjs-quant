import { z } from "zod";
import { sqlite } from "./index";
import { rpsLogIdPrefix, toRpsLogEntry } from "~/lib/screening/rps-log";
import { newsArchiveIdSchema } from "~/lib/news/news-workspace";

export function rpsWorkflowHistory() {
  const rows = sqlite()
    .prepare(
      "SELECT id,payload,updated_at AS updatedAt FROM records WHERE kind='workflow-check' AND id LIKE ? ORDER BY updated_at DESC,id DESC LIMIT 50",
    )
    .all(`${rpsLogIdPrefix}%`) as {
    id: string;
    payload: string;
    updatedAt: number;
  }[];
  return rows
    .map((row) => toRpsLogEntry({ ...row, payload: JSON.parse(row.payload) }))
    .filter((entry) => entry !== null);
}

export function strategyCenterHistory() {
  return sqlite()
    .prepare(
      "SELECT id,json_extract(payload,'$.status') AS status,json_extract(payload,'$.input.strategyId') AS strategyId,json_extract(payload,'$.input.symbol') AS symbol FROM records WHERE kind='job' AND json_extract(payload,'$.input.type')='strategy-center' ORDER BY updated_at DESC,id DESC LIMIT 30",
    )
    .all() as {
    id: string;
    status: string;
    strategyId: string;
    symbol: string;
  }[];
}

export function newsAnalysisIdForTask(id: string) {
  z.string().min(1).max(200).parse(id);
  const row = sqlite()
    .prepare(
      `SELECT json_extract(payload,'$.newsAnalysisId') AS archivedId,
        json_extract(payload,'$.result.id') AS resultId
      FROM records WHERE kind='job' AND id=?
        AND json_extract(payload,'$.input.kind')='news-analysis'`,
    )
    .get(id) as
    { archivedId: string | null; resultId: string | null } | undefined;
  // The running task records its first persisted archive; completed records
  // written before that pointer existed still expose their result archive.
  const candidate = row?.archivedId ?? row?.resultId ?? null;
  if (!candidate || !newsArchiveIdSchema.safeParse(candidate).success)
    return null;
  return sqlite()
    .prepare(
      `SELECT 1 FROM records WHERE kind='news-analysis' AND id=?
        AND json_type(payload,'$.news')='array'
        AND json_array_length(payload,'$.news')>0
        AND json_type(payload,'$.items')='array'
        AND json_array_length(payload,'$.items')>0`,
    )
    .get(candidate)
    ? candidate
    : null;
}
