import { createHash } from "node:crypto";
import type { Evidence, Snapshot } from "~/lib/domain";
import { evidenceEnvelope } from "./evidence";
import { latestIndustryNewsReport } from "./news-sector-history";

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function verifiedIndustry(
  symbol: string,
  evidence: Evidence[],
  now: number,
) {
  const matches = evidence.filter(
    (e) =>
      e.envelope?.source === "hithink-basicinfo-query" &&
      e.envelope.symbol === symbol,
  );
  if (matches.length !== 1) return undefined;
  const entry = matches[0]!;
  const fetchedAt = entry.envelope!.fetchedAt;
  if (fetchedAt > now || now - fetchedAt >= 1800000) return undefined;
  try {
    const payload = JSON.parse(entry.text);
    const industry = payload.row?.["所属申万一级行业"];
    if (
      digest(payload) !== entry.envelope!.payloadHash ||
      payload.row?.["股票代码"] !==
        `${symbol.slice(2)}.${symbol.slice(0, 2).toUpperCase()}` ||
      typeof industry !== "string" ||
      !/^[\u4e00-\u9fff]{2,10}$/.test(industry)
    )
      return undefined;
    return {
      industry,
      evidenceId: entry.id,
      payloadHash: entry.envelope!.payloadHash,
      fetchedAt,
    };
  } catch {
    return undefined;
  }
}

export function industryNewsEvidence(
  source: Snapshot,
  evidence: Evidence[],
  now = Date.now(),
): Evidence[] {
  if (source.historicalAsOf) return [];
  const missing = (text: string): Evidence[] => [
    {
      id: `missing-industry-news-${source.symbol}`,
      source: "行业新闻关联检查",
      asOf: "未知",
      text,
    },
  ];
  const identity = verifiedIndustry(source.symbol, evidence, now);
  if (!identity)
    return missing(
      "当前证券的申万一级行业归属未唯一核验或已过期，未关联行业新闻；不得根据公司名称或新闻提及猜测行业。",
    );
  const report = latestIndustryNewsReport(identity.industry, now);
  if (!report)
    return missing(
      `${identity.industry}今天尚无截止时间已到的行业研究档案。请在数据与连接中完成新闻分类及该行业研究；不自动重复调用模型。`,
    );
  if (
    report.method.version !== "news-sector-1" ||
    !report.sources.length ||
    report.createdAt < report.cutoff ||
    report.sources.some(
      (s) =>
        s.classification.id !== s.news.id ||
        s.classification.industry !== identity.industry ||
        !Number.isFinite(Date.parse(s.news.publishedAt)) ||
        Date.parse(s.news.publishedAt) > report.cutoff ||
        (s.news.collectedAt !== null &&
          (!Number.isFinite(Date.parse(s.news.collectedAt)) ||
            Date.parse(s.news.collectedAt) > report.createdAt)),
    )
  )
    return missing(
      "行业新闻档案的版本、来源或时点无法核验，未将其加入候选股研究。",
    );
  const payload = {
    version: "industry-news-background-1",
    industry: identity.industry,
    reportId: report.id,
    reportHash: digest(report),
    analysisId: report.input.analysisId,
    cutoff: report.cutoff,
    createdAt: report.createdAt,
    model: report.model,
    method: report.method,
    classificationMethod: report.classificationMethod,
    coverage: report.coverage,
    classificationAggregation: report.classificationAggregation,
    interpretation: report.result,
    sources: report.sources.map((s) => ({
      ...s,
      news: {
        ...s.news,
        content: s.news.content.slice(0, 2000),
        truncated: s.news.content.length > 2000,
      },
    })),
  };
  const envelope = evidenceEnvelope(payload, {
    source: "news-sector/background",
    symbol: null,
    type: "news",
    asOf: new Date(report.cutoff).toISOString(),
    publishedAt: null,
    fetchedAt: report.createdAt,
    currency: null,
    unit: {},
    adjustment: "not-applicable",
    reportPeriod: null,
    quality: "partial",
    warnings: [
      "当前行业归属和当天归档背景仅供当前研究，不用于历史信号。",
      "行业结论是此前模型解释；原文转述、推测与已核验事实必须区分，不得据此认定个股受益、资金流入或价格确认。",
      "仅复用已生成档案，不保证覆盖当日所有新闻或最新动态；原文截断标记与完整来源hash保留。",
    ],
  });
  const background: Evidence = {
    id: `industry-news-${envelope.payloadHash.slice(0, 24)}`,
    source: `${identity.industry} / 已归档行业新闻研究（共享背景）`,
    asOf: envelope.asOf!,
    text: JSON.stringify(payload),
    envelope,
  };
  const association = {
    version: "industry-news-link-1",
    symbol: source.symbol,
    identity,
    backgroundId: background.id,
    reportId: report.id,
    relationship: "仅申万一级行业归属相同，不代表新闻直接涉及或利好本证券",
  };
  const linkEnvelope = evidenceEnvelope(association, {
    ...envelope,
    source: "news-sector/industry-association",
    symbol: source.symbol,
  });
  return [
    background,
    {
      id: `industry-news-link-${source.symbol}-${linkEnvelope.payloadHash.slice(0, 16)}`,
      source: `${source.symbol} → ${identity.industry}（行业间接关联）`,
      asOf: background.asOf,
      text: JSON.stringify(association),
      envelope: linkEnvelope,
    },
  ];
}
