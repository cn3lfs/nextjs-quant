import { expect, it } from "vitest";
import { mergeNewsDay } from "~/server/news/news-day";
import {
  newsAnalysisInput,
  newsAnalysisView,
  type NewsAnalysis,
} from "~/server/news/news-analysis";
const cutoff = Date.parse("2026-09-08T12:00:00+08:00");
function archive(id: string, ids: number[]): NewsAnalysis {
  return {
    id,
    createdAt: cutoff,
    model: "codex:default",
    tokens: 100,
    input: newsAnalysisInput.parse({ cutoff }),
    method: { version: "fixture", files: [] },
    status: "complete",
    news: ids.map((id) => ({
      id,
      title: `新闻${id}`,
      content: "原文",
      publishedAt: "2026-09-08T10:00:00+08:00",
      collectedAt: "2026-09-08T10:01:00+08:00",
      url: null,
      hash: `hash-${id}`,
    })),
    items: ids.map((id) => ({
      id,
      industry: "基础化工",
      impact: "neutral",
      reason: "证据",
      uncertainty: "待验证",
    })),
    distribution: { 基础化工: ids.length },
  };
}
it("merges batches without double counting, retains origins and never advertises another query page", () => {
  const a = archive("a", [1, 2]),
    b = archive("b", [2, 3]);
  const merged = mergeNewsDay(a, [b, a], cutoff);
  expect(merged.items.map((i) => i.id)).toEqual([3, 2, 1]);
  expect(merged.tokens).toBe(0);
  expect(merged.distribution).toEqual({ 基础化工: 3 });
  expect(merged.itemOrigins).toHaveLength(3);
  expect(merged.aggregation?.archiveIds).toEqual(["a", "b"]);
  expect(mergeNewsDay(a, [a, b], cutoff).id).toBe(merged.id);
  expect(newsAnalysisView(merged).nextInput).toBeUndefined();
});
it("isolates conflicting classifications instead of selecting an arbitrary winner", () => {
  const a = archive("a", [1, 2]),
    b = archive("b", [2]);
  b.items[0]!.industry = "电子";
  const merged = mergeNewsDay(a, [a, b], cutoff);
  expect(merged.items.map((i) => i.id)).toEqual([1]);
  expect(merged.aggregation).toMatchObject({ conflicts: [2], observed: 2 });
});
it("excludes other models, later cutoff contexts, yesterday, uncollected and future sources", () => {
  const a = archive("a", [1, 2, 3, 4]);
  a.news[1]!.publishedAt = "2026-09-07T23:00:00+08:00";
  a.news[2]!.collectedAt = null;
  a.news[3]!.collectedAt = "2026-09-08T13:00:00+08:00";
  const paid = { ...archive("paid", [5]), model: "deepseek-chat" };
  const future = archive("future", [6]);
  future.input.cutoff = cutoff + 1;
  expect(
    mergeNewsDay(a, [a, paid, future], cutoff).items.map((i) => i.id),
  ).toEqual([1]);
});
