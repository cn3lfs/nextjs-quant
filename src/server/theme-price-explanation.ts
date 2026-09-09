import { createHash } from "node:crypto";
import type { Evidence } from "~/lib/domain";
import type { ThemePrices } from "./theme-prices";
import type { NewsThemesReport } from "./news-themes";
import { sectorPriceMetrics } from "./sector-price-metrics";
import { completedBar } from "./screening";
import { evidenceEnvelope } from "./evidence";
import { get } from "./db";
import { background } from "./jobs";
import { analyze, researchModel } from "./research";
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function themePriceEvidence(
  price: ThemePrices,
  theme: NewsThemesReport,
): Evidence[] {
  if (
    price.version !== "theme-prices-1" ||
    theme.method.version !== "news-themes-1" ||
    price.themeId !== theme.id ||
    price.themeHash !== hash(theme) ||
    price.envelope.payloadHash !== hash(price.data) ||
    price.data.cutoff !== theme.cutoff
  )
    throw new Error("主题与价格证据版本或哈希不一致");
  const symbols = price.data.mappings.map((m) => m.symbol);
  if (
    price.data.mappings.some(
      (m) => !theme.ranked.some((r) => r.industry === m.industry),
    ) ||
    new Set(symbols).size !== symbols.length
  )
    throw new Error("价格证据含不匹配的行业");
  if (
    symbols.length &&
    hash(sectorPriceMetrics(price.data.raw, symbols, price.data.cutoff)) !==
      hash(price.data.metrics)
  )
    throw new Error("归档价格计算与原始日线不一致");
  if (!symbols.length && price.data.metrics !== null)
    throw new Error("无行业身份但包含价格计算");
  const news = {
    version: "theme-price-explanation-2",
    themeId: theme.id,
    themeHash: price.themeHash,
    cutoff: theme.cutoff,
    method: theme.method,
    classificationMethod: theme.classificationMethod,
    aggregation: theme.aggregation,
    ranked: theme.ranked,
    result: theme.result,
    sources: theme.sources.map((s) => ({
      ...s,
      news: {
        ...s.news,
        content: s.news.content.slice(0, 2000),
        truncated: s.news.content.length > 2000,
      },
    })),
  };
  const values = {
    version: "theme-price-explanation-2",
    priceId: price.id,
    priceHash: hash(price),
    originalEnvelope: price.envelope,
    cutoff: price.data.cutoff,
    mappings: price.data.mappings,
    failures: price.data.failures,
    metrics: price.data.metrics,
    windows: symbols.length
      ? [...symbols, "sh000001"].map((symbol) => {
          const bars = (
            price.data.raw as {
              symbol: string;
              date: string;
              last: number;
              volume: number;
            }[]
          )
            .filter(
              (row) =>
                row.symbol === symbol &&
                completedBar(row.date, "day", price.data.cutoff),
            )
            .sort((a, b) => a.date.localeCompare(b.date))
            .slice(-31)
            .map((row) => ({
              date: row.date,
              close: row.last,
              volume: row.volume,
            }));
          return {
            symbol,
            start5: bars.at(-6)?.date ?? null,
            start30: bars.at(-31)?.date ?? null,
            end: bars.at(-1)?.date ?? null,
            bars,
          };
        })
      : [],
  };
  const date = new Date(theme.cutoff + 8 * 3600000).toISOString().slice(0, 10);
  return [
    {
      payload: news,
      source: "local/news-themes",
      type: "news" as const,
      asOf: date,
      fetchedAt: theme.createdAt,
      adjustment: "not-applicable" as const,
      warnings: ["主题关联是模型推断，仅覆盖已有新闻；截断原文已标记。"],
    },
    {
      payload: values,
      source: "tencent/sector-price",
      type: "bars" as const,
      asOf: price.envelope.asOf,
      fetchedAt: price.data.fetchedAt,
      adjustment: "none" as const,
      warnings: price.envelope.warnings,
    },
  ].map((item) => {
    const envelope = evidenceEnvelope(item.payload, {
      source: item.source,
      symbol: null,
      type: item.type,
      asOf: item.asOf,
      publishedAt: null,
      fetchedAt: item.fetchedAt,
      currency: null,
      unit: item.type === "bars" ? { return: "%", volumeRatio: "倍" } : {},
      adjustment: item.adjustment,
      reportPeriod: null,
      quality: "partial",
      warnings: item.warnings,
    });
    return {
      id: `theme-compare-${envelope.payloadHash.slice(0, 24)}`,
      source: item.source,
      asOf: item.asOf ?? "价格时点缺失",
      text: JSON.stringify(item.payload),
      envelope,
    };
  });
}
export function explainThemePricesJob(id: string) {
  const price = get<ThemePrices>(id);
  const theme = price ? get<NewsThemesReport>(price.themeId) : undefined;
  if (!price || !theme) throw new Error("主题或价格档案不存在");
  const evidence = themePriceEvidence(price, theme),
    model = researchModel(false);
  return background(
    "research",
    { kind: "theme-price-explanation", contextId: id, model },
    (_job, signal) =>
      analyze(
        id,
        "逐个对照已有新闻主题与行业指数价格。只引用给定JS数值，解释一致、分歧、反证和缺口。单日新闻与5/30个区间涨幅窗口不同，不能把先前涨幅当作新闻发布后的反应，不能从共同上涨推断因果或盈利改善。行业之间、行业与基准比较先核对日期和样本范围；缺失价格明确不能判断。主题本身是模型推断，保留原文证据与覆盖限制。缺少估值、扩散度与事件前后对照，不能给预期差象限、交易指令或仓位比例。相对指数涨幅未扣费，不称净超额；高点距离不称最大回撤。正文解释中文含义，列出后续可验证条件，不重新查询或编造数据。",
        evidence,
        signal,
        "general",
        model,
      ),
    { kind: "theme-price-explanation", id, model, hash: hash(evidence) },
  );
}
