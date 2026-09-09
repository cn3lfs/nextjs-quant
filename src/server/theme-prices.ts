import { createHash } from "node:crypto";
import { get, put, sqlite } from "./db";
import {
  fetchSectorPrices,
  type SectorPriceData,
} from "./tencent-sector-prices";
import type { NewsThemesReport } from "./news-themes";
import { sharedRead } from "./shared-read";
import { evidenceEnvelope } from "./evidence";
export type ThemePrices = {
  id: string;
  version: "theme-prices-1";
  themeId: string;
  themeHash: string;
  createdAt: number;
  data: SectorPriceData;
  envelope: ReturnType<typeof evidenceEnvelope>;
};
export function latestThemePrices(themeId: string): ThemePrices | null {
  const row = sqlite()
    .prepare(
      "SELECT payload FROM records WHERE kind='theme-prices' AND json_extract(payload,'$.themeId')=? ORDER BY updated_at DESC,id DESC LIMIT 1",
    )
    .get(themeId) as { payload: string } | undefined;
  return row ? (JSON.parse(row.payload) as ThemePrices) : null;
}
const shared = sharedRead<ThemePrices>();
export async function checkThemePrices(themeId: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const theme = get<NewsThemesReport>(themeId);
  if (!theme || theme.method?.version !== "news-themes-1")
    throw new Error("主题报告不存在或版本不支持");
  const industries = theme.ranked.map((r) => r.industry);
  if (!industries.length) throw new Error("报告没有可核验的实体行业");
  const themeHash = createHash("sha256")
    .update(JSON.stringify(theme))
    .digest("hex");
  const previous = latestThemePrices(themeId),
    now = Date.now();
  if (
    previous?.themeHash === themeHash &&
    previous.version === "theme-prices-1" &&
    previous.data.fetchedAt <= now &&
    now - previous.data.fetchedAt < 60000
  )
    return previous;
  return shared(
    `${themeId}:${themeHash}`,
    async (upstream) => {
      const data = await fetchSectorPrices(industries, theme.cutoff, upstream);
      upstream.throwIfAborted();
      const dates = [
        ...new Set(
          data.metrics?.results
            .map((r) => r.asOf)
            .filter((date): date is string => !!date) ?? [],
        ),
      ];
      const envelope = evidenceEnvelope(data, {
        source: data.source,
        symbol: null,
        type: "bars",
        asOf: dates.length === 1 ? dates[0]! : null,
        publishedAt: null,
        fetchedAt: data.fetchedAt,
        currency: null,
        unit: {
          index: "点",
          return: "%",
          volumeRatio: "倍",
          volume: "源单位未独立核验",
        },
        adjustment: "none",
        reportPeriod: null,
        quality: "partial",
        warnings: [
          "当前抓取的历史指数序列，不证明数据在原新闻时点已可获取；不得回填历史交易信号。",
          "指数历史数据可能延迟或修订；新闻、价格与估值是不同证据，不能据此直接给出交易结论。",
          ...(data.metrics?.assumptions ?? []),
          ...data.failures.map((f) => `${f.industry}：${f.reason}`),
        ],
      });
      const id =
        "theme-prices-" +
        createHash("sha256")
          .update(JSON.stringify({ themeHash, envelope }))
          .digest("hex");
      const report: ThemePrices = {
        id,
        version: "theme-prices-1",
        themeId,
        themeHash,
        createdAt: Date.now(),
        data,
        envelope,
      };
      upstream.throwIfAborted();
      put("theme-prices", id, report);
      return report;
    },
    signal,
  );
}
