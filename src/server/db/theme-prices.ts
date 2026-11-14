import { sqlite } from "./index";
import type { ThemePrices } from "../news/theme-prices";
export function latestThemePrices(themeId: string): ThemePrices | null {
  const row = sqlite()
    .prepare(
      "SELECT payload FROM records WHERE kind='theme-prices' AND json_extract(payload,'$.themeId')=? ORDER BY updated_at DESC,id DESC LIMIT 1",
    )
    .get(themeId) as { payload: string } | undefined;
  return row ? (JSON.parse(row.payload) as ThemePrices) : null;
}
