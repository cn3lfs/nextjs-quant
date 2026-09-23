import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const state = vi.hoisted(() => ({
  records: new Map<string, unknown>(),
  model: vi.fn(),
}));
vi.mock("../../src/server/db/index", () => ({
  get: (id: string) => state.records.get(id),
  put: (_kind: string, id: string, value: unknown) =>
    state.records.set(id, value),
}));
vi.mock("../../src/server/research/research", () => ({
  researchModel: () => "codex:default",
  structured: state.model,
}));
import { analyzeNewsSector } from "../../src/server/news/news-sector";
import type { NewsAnalysis } from "../../src/server/news/news-analysis";
const input = {
  analysisId: `news-analysis-${"a".repeat(64)}`,
  industry: "电子",
};
let methodPath: string;
const claim = { text: "原文显示事件，结果待验证", citations: [60] };
const result = {
  summary: claim,
  facts: [claim],
  opportunities: [claim],
  risks: [claim],
  observations: [{ ...claim, invalidation: "后续公告否认该事件" }],
  missing: ["缺少行情核验"],
};
beforeEach(async () => {
  state.records.clear();
  state.model.mockReset();
  const root = await mkdtemp(join(tmpdir(), "quant-sector-test-"));
  vi.stubEnv("QUANT_SKILLS_DIR", root);
  await mkdir(join(root, "news-sector-analyzer"));
  methodPath = join(root, "news-sector-analyzer", "SKILL.md");
  await writeFile(methodPath, "method fixture");
  state.records.set(input.analysisId, {
    input: { cutoff: Date.parse("2026-09-08T12:00:00Z") },
    method: { version: "fixture", files: [] },
    news: Array.from({ length: 60 }, (_, i) => ({
      id: i + 1,
      title: `标题${i + 1}`,
      content: "完整新闻",
      hash: `hash-${i}`,
      publishedAt: "2026-09-08T01:00:00Z",
      collectedAt: null,
      url: null,
    })),
    items: Array.from({ length: 60 }, (_, i) => ({
      id: i + 1,
      industry: "电子",
      impact: "uncertain",
      reason: "待验证",
      uncertainty: "待核实",
    })),
  });
  state.model.mockImplementation(async (_prompt, schema) => ({
    data: schema.parse(result),
    tokens: 10,
  }));
});
afterEach(() => vi.unstubAllEnvs());
it("传递每日汇总来源与冲突范围，范围变化不复用旧报告", async () => {
  const archive = state.records.get(input.analysisId) as NewsAnalysis;
  archive.aggregation = {
    version: "news-day-1",
    day: "2026-09-08",
    archiveIds: ["source-a"],
    conflicts: [61],
    observed: 61,
  };
  const report = await analyzeNewsSector(input);
  expect(report.classificationAggregation).toEqual(archive.aggregation);
  expect(state.model.mock.calls[0]![0]).toContain("不是全日完整新闻覆盖");
  expect(state.model.mock.calls[0]![0]).toContain('"conflicts":[61]');
  archive.aggregation = {
    ...archive.aggregation,
    conflicts: [61, 62],
    observed: 62,
  };
  expect((await analyzeNewsSector(input)).id).not.toBe(report.id);
  archive.aggregation.conflicts = [60];
  await expect(analyzeNewsSector(input)).rejects.toThrow("冲突新闻");
});
it("冻结最新50条并披露覆盖，缓存包含方法版本，保留完整原文", async () => {
  const report = await analyzeNewsSector(input);
  expect(report.coverage).toEqual({
    selected: 50,
    available: 60,
    classified: 60,
    original: 60,
  });
  expect(report.sources.map((s) => s.news.id)).toEqual(
    Array.from({ length: 50 }, (_, i) => 60 - i),
  );
  expect(report.model).toBe("codex:default");
  expect(await analyzeNewsSector(input)).toEqual(report);
  expect(state.model).toHaveBeenCalledTimes(1);
  await writeFile(methodPath, "new method");
  expect((await analyzeNewsSector(input)).id).not.toBe(report.id);
});
it("拒绝未选择原文的引用和无分类行业，不存伪造结果", async () => {
  state.model.mockImplementation(async (_prompt, schema) => ({
    data: schema.parse({ ...result, summary: { ...claim, citations: [1] } }),
    tokens: 10,
  }));
  await expect(analyzeNewsSector(input)).rejects.toThrow("引用");
  expect(state.records.size).toBe(1);
  await expect(
    analyzeNewsSector({ ...input, industry: "不存在" }),
  ).rejects.toThrow("没有");
  expect(state.model).toHaveBeenCalledTimes(1);
});
it("取消后迟到模型结果不写档案", async () => {
  let release!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  state.model.mockImplementation(async (_prompt, schema) => {
    markStarted();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { data: schema.parse(result), tokens: 10 };
  });
  const controller = new AbortController();
  const pending = analyzeNewsSector(input, controller.signal);
  const rejected = expect(pending).rejects.toThrow();
  await started;
  controller.abort();
  release();
  await rejected;
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(state.records.size).toBe(1);
});
