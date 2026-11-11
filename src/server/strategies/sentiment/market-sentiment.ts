import { evidenceEnvelope } from "../../infra/evidence";
import type { Evidence } from "~/lib/domain";
import {
  marketSentiment,
  marketSentimentInputSchema,
  type MarketSentimentInput,
} from "trading-strategies/research/factors/market-sentiment";

export function marketSentimentEvidence(input: MarketSentimentInput): Evidence {
  const normalized = marketSentimentInputSchema.parse(input);
  const facts = marketSentiment(normalized);
  const payload = { input: normalized, facts };
  const dates = [
    ...new Set(
      facts.factors.filter((f) => f.value !== null).map((f) => f.source!.asOf),
    ),
  ];
  const envelope = evidenceEnvelope(payload, {
    source: "market-sentiment/ashare-proxy",
    symbol: null,
    type: "quote-financial",
    asOf: dates.length === 1 ? dates[0]! : null,
    publishedAt: null,
    fetchedAt: normalized.observedAt,
    currency: null,
    unit: { score: "0–100", effectiveWeight: "ratio" },
    adjustment: "not-applicable",
    reportPeriod: null,
    quality: facts.used ? "partial" : "unavailable",
    warnings: facts.warnings,
  });
  return {
    id: `market-sentiment-${envelope.payloadHash}`,
    source: "市场情绪 / 自建A股五因子代理 / JS计算",
    asOf: envelope.asOf ?? "各因子日期分别披露",
    text: JSON.stringify(payload),
    envelope,
  };
}
