import { sqlite } from "../db";

const symbolPaths = {
  "fundamental-report": "$.dossier.symbol",
  "wyckoff-report": "$.frames.symbol",
  "chan-report": "$.evidence.symbol",
  "canslim-report": "$.dossier.symbol",
} as const;

type ResearchSummary = {
  id: string;
  createdAt: number;
  symbol: string;
  title: string;
  model: string;
};

/** Project in SQLite so archived bars and method documents never cross into JS. */
export function researchHistory(
  kind: keyof typeof symbolPaths,
): ResearchSummary[] {
  return sqlite()
    .prepare(
      `SELECT json_extract(payload, '$.id') AS id,
        json_extract(payload, '$.createdAt') AS createdAt,
        json_extract(payload, ?) AS symbol,
        json_extract(payload, '$.result.title') AS title,
        json_extract(payload, '$.model') AS model
       FROM records WHERE kind = ? ORDER BY updated_at DESC LIMIT 100`,
    )
    .all(symbolPaths[kind], kind) as ResearchSummary[];
}
