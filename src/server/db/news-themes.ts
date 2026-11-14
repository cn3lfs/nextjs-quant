import { sqlite } from "./index";
import type { NewsThemesReport } from "../news/news-themes";
export function latestNewsThemes(analysisId: string): NewsThemesReport | null {
  const row = sqlite()
    .prepare(
      "SELECT payload FROM records WHERE kind='news-themes' AND json_extract(payload,'$.analysisId')=? ORDER BY updated_at DESC,id DESC LIMIT 1",
    )
    .get(analysisId) as { payload: string } | undefined;
  return row ? (JSON.parse(row.payload) as NewsThemesReport) : null;
}
