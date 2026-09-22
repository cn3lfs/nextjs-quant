import { createHash } from "node:crypto";
import { get, put, sqlite } from "../db";
import type { NewsAnalysis } from "./news-analysis";

export function mergeNewsDay(
  base: NewsAnalysis,
  archives: NewsAnalysis[],
  now = Date.now(),
): NewsAnalysis {
  const cutoff = base.input.cutoff;
  if (!Number.isFinite(cutoff) || cutoff > now)
    throw new Error("新闻截止时点非法");
  const dayStart =
    Math.floor((cutoff + 8 * 3600000) / 86400000) * 86400000 - 8 * 3600000;
  const day = new Date(dayStart + 8 * 3600000).toISOString().slice(0, 10);
  const grouped = new Map<
    number,
    Map<
      string,
      {
        news: NewsAnalysis["news"][number];
        item: NewsAnalysis["items"][number];
        archiveId: string;
      }
    >
  >();
  const archiveIds = new Set<string>();
  for (const archive of [...archives].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    if (
      archive.aggregation ||
      archive.model !== base.model ||
      JSON.stringify(archive.method) !== JSON.stringify(base.method) ||
      archive.input.cutoff > cutoff ||
      archive.createdAt > now
    )
      continue;
    const sources = new Map(archive.news.map((n) => [n.id, n]));
    for (const item of archive.items) {
      const news = sources.get(item.id);
      if (!news) throw new Error("分类引用缺少原始新闻");
      const published = Date.parse(news.publishedAt),
        collected = news.collectedAt ? Date.parse(news.collectedAt) : NaN;
      if (
        !Number.isFinite(published) ||
        !Number.isFinite(collected) ||
        published < dayStart ||
        published > cutoff ||
        collected > cutoff
      )
        continue;
      const versions = grouped.get(news.id) ?? new Map();
      const key = JSON.stringify({ news, item });
      if (!versions.has(key))
        versions.set(key, { news, item, archiveId: archive.id });
      grouped.set(news.id, versions);
      archiveIds.add(archive.id);
    }
  }
  const conflicts = [...grouped]
    .filter(([, versions]) => versions.size > 1)
    .map(([id]) => id)
    .sort((a, b) => a - b);
  const selected = [...grouped.values()]
    .filter((v) => v.size === 1)
    .map((v) => v.values().next().value!)
    .sort(
      (a, b) =>
        b.news.publishedAt.localeCompare(a.news.publishedAt) ||
        b.news.id - a.news.id,
    );
  if (!selected.length) throw new Error("当天没有无冲突的已分类新闻可汇总");
  const aggregation = {
    version: "news-day-1" as const,
    day,
    archiveIds: [...archiveIds].sort(),
    conflicts,
    observed: grouped.size,
  };
  const news = selected.map((s) => s.news),
    items = selected.map((s) => s.item);
  const id =
    "news-analysis-" +
    createHash("sha256")
      .update(
        JSON.stringify({
          cutoff,
          model: base.model,
          method: base.method,
          aggregation,
          news,
          items,
        }),
      )
      .digest("hex");
  return {
    id,
    createdAt: now,
    model: base.model,
    tokens: 0,
    reusedItems: items.length,
    input: {
      ...base.input,
      page: 0,
      query: "",
      scope: "page",
      before: undefined,
      resumeId: undefined,
    },
    method: base.method,
    news,
    items,
    distribution: items.reduce<Record<string, number>>((counts, item) => {
      counts[item.industry] = (counts[item.industry] ?? 0) + 1;
      return counts;
    }, {}),
    status: "complete",
    aggregation,
    itemOrigins: selected.map((s) => ({
      newsId: s.news.id,
      analysisId: s.archiveId,
      archivedAt: archives.find((a) => a.id === s.archiveId)!.createdAt,
    })),
  };
}

export function aggregateNewsDay(baseId: string) {
  const base = get<NewsAnalysis>(baseId);
  if (!base) throw new Error("新闻分类档案不存在");
  const rows = sqlite()
    .prepare(
      "SELECT payload FROM records WHERE kind='news-analysis' AND json_extract(payload,'$.model')=? AND json_extract(payload,'$.input.cutoff')<=?",
    )
    .all(base.model, base.input.cutoff) as { payload: string }[];
  const result = mergeNewsDay(
    base,
    rows.map((row) => JSON.parse(row.payload) as NewsAnalysis),
  );
  return (
    get<NewsAnalysis>(result.id) ?? put("news-analysis", result.id, result)
  );
}
