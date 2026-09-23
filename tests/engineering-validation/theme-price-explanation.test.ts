import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { themePriceEvidence } from "~/server/news/theme-price-explanation";
import { sectorPriceMetrics } from "~/server/market/sector-price-metrics";
import { evidenceEnvelope } from "~/server/infra/evidence";
import type { ThemePrices } from "~/server/news/theme-prices";
import type { NewsThemesReport } from "~/server/news/news-themes";
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const cutoff = Date.parse("2026-09-08T16:00:00+08:00");
const claim = { text: "fixture", citations: [1] };
const theme: NewsThemesReport = {
  id: "theme",
  analysisId: "analysis",
  createdAt: cutoff,
  cutoff,
  model: "codex:default",
  tokens: 0,
  method: { version: "news-themes-1", file: "fixture", hash: "a".repeat(64) },
  classificationMethod: { version: "fixture", files: [] },
  aggregation: {
    version: "news-day-1",
    day: "2026-09-08",
    archiveIds: [],
    conflicts: [],
    observed: 0,
  },
  ranked: [{ industry: "电子", count: 1 }],
  sources: [],
  result: {
    summary: claim,
    themes: [],
    background: [],
    risks: [claim],
    missing: ["fixture"],
  },
};
function fixture(): ThemePrices {
  const raw = ["pt01801080", "sh000001"].flatMap((symbol) =>
    Array.from({ length: 6 }, (_, i) => ({
      symbol,
      date: `2026-09-0${i + 1}`,
      last: 100 + i,
      volume: 100,
    })),
  );
  const data = {
    source: "tencent/westock-data" as const,
    cutoff,
    fetchedAt: cutoff,
    scriptHash: "b".repeat(64),
    mappings: [
      {
        industry: "电子",
        symbol: "pt01801080",
        classification: "申万一级行业清单",
      },
    ],
    failures: [],
    raw,
    metrics: sectorPriceMetrics(raw, ["pt01801080"], cutoff),
  };
  return {
    id: "price",
    version: "theme-prices-1",
    themeId: theme.id,
    themeHash: digest(theme),
    createdAt: cutoff,
    data,
    envelope: evidenceEnvelope(data, {
      source: data.source,
      symbol: null,
      type: "bars",
      asOf: "2026-09-06",
      publishedAt: null,
      fetchedAt: cutoff,
      currency: null,
      unit: {},
      adjustment: "none",
      reportPeriod: null,
      quality: "partial",
      warnings: ["fixture"],
    }),
  };
}
it("keeps news and prices as separate traceable evidence with calculated gaps", () => {
  const evidence = themePriceEvidence(fixture(), theme);
  expect(evidence).toHaveLength(2);
  expect(evidence[0]!.envelope?.type).toBe("news");
  const prices = JSON.parse(evidence[1]!.text);
  expect(prices.metrics.results[0].return30).toBeNull();
  expect(prices.windows[0]).toMatchObject({
    start5: "2026-09-01",
    start30: null,
    end: "2026-09-06",
  });
  expect(prices.windows[1].symbol).toBe("sh000001");
  expect(
    evidence.every(
      (e) => e.envelope?.payloadHash === digest(JSON.parse(e.text)),
    ),
  ).toBe(true);
});
it("rejects edited archives and recomputes metrics even if the payload hash was updated", () => {
  const price = fixture();
  expect(() => themePriceEvidence(price, { ...theme, tokens: 1 })).toThrow(
    "哈希",
  );
  price.data.metrics!.results[0]!.return5 = 999;
  expect(() => themePriceEvidence(price, theme)).toThrow("哈希");
  price.envelope.payloadHash = digest(price.data);
  expect(() => themePriceEvidence(price, theme)).toThrow("计算");
});
it("rejects prices for unrelated industries", () => {
  const price = fixture();
  price.data.mappings[0]!.industry = "银行";
  price.envelope.payloadHash = digest(price.data);
  expect(() => themePriceEvidence(price, theme)).toThrow("不匹配");
});
