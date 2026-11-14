import { sqlite } from "./index";
export function financialQualityHistory() {
  return sqlite()
    .prepare(
      `SELECT id, json_extract(payload,'$.createdAt') AS createdAt,
    json_extract(payload,'$.facts.symbol') AS symbol FROM records
    WHERE kind='financial-quality' ORDER BY updated_at DESC,id LIMIT 100`,
    )
    .all() as { id: string; createdAt: number; symbol: string }[];
}
