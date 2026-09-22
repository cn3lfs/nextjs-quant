import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const state = vi.hoisted(() => ({
  records: new Map<string, unknown>(),
  model: vi.fn(),
}));
vi.mock("~/server/db", () => ({
  get: (id: string) => state.records.get(id),
  put: (_kind: string, id: string, value: unknown) =>
    state.records.set(id, value),
}));
vi.mock("~/server/research/research", () => ({
  researchModel: () => "codex:default",
  structured: state.model,
}));
import { analyzeNewsThemes, themeSources } from "~/server/news/news-themes";
import type { NewsAnalysis } from "~/server/news/news-analysis";
const id = `news-analysis-${"a".repeat(64)}`;
const claim = { text: "仅作研究", citations: [1, 2] };
const result = {
  summary: claim,
  themes: [
    {
      title: "共同事件",
      logic: claim,
      industries: ["电子", "基础化工"],
      invalidation: "后续原始公告否认关联",
    },
  ],
  background: [],
  risks: [claim],
  missing: ["缺少价格核验"],
};
let archive: NewsAnalysis;
beforeEach(async () => {
  state.records.clear();
  state.model.mockReset();
  const path = await mkdtemp(join(tmpdir(), "quant-themes-"));
  await mkdir(join(path, "news-industry-analyst"));
  await writeFile(
    join(path, "news-industry-analyst", "SKILL.md"),
    "method fixture",
  );
  vi.stubEnv("QUANT_SKILLS_DIR", path);
  archive = {
    id,
    createdAt: 1,
    model: "codex:default",
    tokens: 1,
    input: {
      cutoff: Date.parse("2026-09-08T12:00:00+08:00"),
      historical: true,
      page: 0,
      query: "",
      scope: "page",
      maxItems: 200,
    },
    method: { version: "fixture", files: [] },
    distribution: {},
    aggregation: {
      version: "news-day-1",
      day: "2026-09-08",
      archiveIds: ["original"],
      conflicts: [],
      observed: 3,
    },
    news: [1, 2, 3].map((id) => ({
      id,
      title: `新闻${id}`,
      content: "事实原文",
      hash: `${id}`,
      url: null,
      publishedAt: "2026-09-08T10:00:00+08:00",
      collectedAt: "2026-09-08T10:01:00+08:00",
    })),
    items: ["电子", "基础化工", "市场情绪面"].map((industry, i) => ({
      id: i + 1,
      industry,
      impact: "uncertain",
      reason: "待核验",
      uncertainty: "关联可能不成立",
    })),
  };
  state.records.set(id, archive);
  state.model.mockImplementation(async (_prompt, schema) => ({
    data: schema.parse(result),
    tokens: 10,
  }));
});
afterEach(() => vi.unstubAllEnvs());
it("bounds broad archives to seven ranked industries and ten newest stories per category", () => {
  const labels = [
    "电子",
    "基础化工",
    "医药生物",
    "银行",
    "建筑材料",
    "汽车",
    "电力设备",
    "机械设备",
    "煤炭",
    "市场情绪面",
  ];
  archive.news = [];
  archive.items = [];
  for (let group = 0; group < labels.length; group++) {
    for (let index = 0; index < 12; index++) {
      const newsId = group * 100 + index;
      archive.news.push({
        id: newsId,
        title: "fixture",
        content: "fixture",
        hash: `${newsId}`,
        url: null,
        publishedAt: "2026-09-08T10:00:00+08:00",
        collectedAt: "2026-09-08T10:01:00+08:00",
      });
      archive.items.push({
        id: newsId,
        industry: labels[group]!,
        impact: "uncertain",
        reason: "fixture",
        uncertainty: "fixture",
      });
    }
  }
  const selected = themeSources(archive);
  expect(selected.ranked).toHaveLength(7);
  expect(selected.sources).toHaveLength(80);
  for (const industry of [
    ...selected.ranked.map((r) => r.industry),
    "市场情绪面",
  ]) {
    const ids = selected.sources
      .filter((s) => s.classification.industry === industry)
      .map((s) => s.news.id);
    expect(ids).toHaveLength(10);
    expect(ids.every((id) => id % 100 >= 2)).toBe(true);
  }
});
it("ranks only real industries, retains evidence and caches by model and method", async () => {
  expect(themeSources(archive).ranked.map((r) => r.industry)).not.toContain(
    "市场情绪面",
  );
  const report = await analyzeNewsThemes(id);
  expect(report.sources).toHaveLength(3);
  expect(report.method.hash).toHaveLength(64);
  expect(await analyzeNewsThemes(id)).toEqual(report);
  expect(state.model).toHaveBeenCalledTimes(1);
  expect(
    (await analyzeNewsThemes(id, undefined, "claude:default")).id,
  ).not.toBe(report.id);
});
it("rejects unsupported industry links, unknown citations and future collection", async () => {
  state.model.mockImplementation(async (_p, schema) => ({
    data: schema.parse({
      ...result,
      themes: [{ ...result.themes[0], industries: ["电子", "银行"] }],
    }),
    tokens: 1,
  }));
  await expect(analyzeNewsThemes(id)).rejects.toThrow("跨行业");
  state.model.mockImplementation(async (_p, schema) => ({
    data: schema.parse({ ...result, summary: { ...claim, citations: [999] } }),
    tokens: 1,
  }));
  await expect(analyzeNewsThemes(id)).rejects.toThrow("引用");
  archive.news[0]!.collectedAt = "2026-09-08T13:00:00+08:00";
  expect(() => themeSources(archive)).toThrow("截止");
});
it("allows no cross-industry themes and does not save a cancelled late model response", async () => {
  state.model.mockImplementation(async (_p, schema) => ({
    data: schema.parse({ ...result, themes: [] }),
    tokens: 1,
  }));
  expect((await analyzeNewsThemes(id)).result.themes).toEqual([]);
  let release!: () => void;
  state.model.mockImplementation(async (_p, schema) => {
    await new Promise<void>((r) => {
      release = r;
    });
    return { data: schema.parse(result), tokens: 1 };
  });
  const controller = new AbortController();
  const pending = analyzeNewsThemes(id, controller.signal, "claude:default");
  const rejected = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  controller.abort();
  release();
  await rejected;
  expect(
    [...state.records.values()].filter(
      (v: any) => v.model === "claude:default",
    ),
  ).toHaveLength(0);
});
