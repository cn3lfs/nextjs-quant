import { sqlite } from "./db";
import type { NewsSectorReport } from "./news-sector";

export function latestIndustryNewsReport(
  industry: string,
  now: number,
): NewsSectorReport | undefined {
  const dayStart =
    Math.floor((now + 8 * 3600000) / 86400000) * 86400000 - 8 * 3600000;
  const row = sqlite()
    .prepare(
      `
    SELECT payload FROM records
    WHERE kind = 'news-sector'
      AND json_extract(payload, '$.input.industry') = ?
      AND json_extract(payload, '$.cutoff') BETWEEN ? AND ?
      AND json_extract(payload, '$.createdAt') <= ?
    ORDER BY json_extract(payload, '$.cutoff') DESC,
      json_extract(payload, '$.createdAt') DESC, id DESC LIMIT 1
  `,
    )
    .get(industry, dayStart, now, now) as { payload: string } | undefined;
  return row ? (JSON.parse(row.payload) as NewsSectorReport) : undefined;
}

export function newsSectorHistory(analysisId: string): NewsSectorReport[] {
  // Filter before ranking: unrelated archives cannot displace this archive's reports.
  const rows = sqlite()
    .prepare(
      `
    SELECT payload FROM (
      SELECT payload, updated_at, id,
        ROW_NUMBER() OVER (
          PARTITION BY json_extract(payload, '$.input.industry')
          ORDER BY updated_at DESC, id DESC
        ) AS position
      FROM records
      WHERE kind = 'news-sector' AND json_extract(payload, '$.input.analysisId') = ?
    ) WHERE position = 1 ORDER BY updated_at DESC, id DESC
  `,
    )
    .all(analysisId) as { payload: string }[];
  return rows.map((row) => JSON.parse(row.payload) as NewsSectorReport);
}
