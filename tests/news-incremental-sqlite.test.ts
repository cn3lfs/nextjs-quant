import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  news: vi.fn(),
  model: vi.fn(),
  provider: "codex:default",
}));
vi.mock("../src/server/cls-news", () => ({ readClsNews: state.news }));
vi.mock("../src/server/settings", () => ({
  settings: () => ({ clsDbPath: "fixture" }),
}));
vi.mock("../src/server/research", () => ({
  researchModel: () => state.provider,
  structured: state.model,
}));
import { analyzeNews } from "../src/server/news-analysis";
import { sqlite } from "../src/server/db";
const root = mkdtempSync(join(tmpdir(), "quant-news-incremental-"));
vi.stubEnv("QUANT_DATA_DIR", root);
vi.stubEnv("QUANT_SKILLS_DIR", root);
mkdirSync(join(root, "news-industry-classifier", "references"), {
  recursive: true,
});
writeFileSync(join(root, "news-industry-classifier", "SKILL.md"), "fixture");
writeFileSync(
  join(root, "news-industry-classifier", "references", "sw-industries.md"),
  Array.from({ length: 34 }, (_, i) => `- 行业${i}：定义`).join("\n"),
);
afterAll(() => {
  sqlite().close();
  vi.unstubAllEnvs();
});
it("真实SQLite迁移旧批次后只分类新增新闻，切换模型不混用结果", async () => {
  const rows = [1, 2, 3].map((id) => ({
    id,
    title: `新闻${id}`,
    content: "原文",
    publishedAt: "2026-09-08T01:00:00Z",
    collectedAt: null,
    url: null,
    hash: `hash-${id}`,
  }));
  const submissions: number[][] = [];
  state.model.mockImplementation(async (prompt, schema) => {
    const news = JSON.parse(prompt.slice(prompt.lastIndexOf("\n新闻：") + 4));
    submissions.push(news.map((n: { id: number }) => n.id));
    return {
      tokens: 10,
      data: schema.parse({
        items: news.map((n: { id: number }) => ({
          id: n.id,
          industry: "行业0",
          impact: "uncertain",
          reason: "原文依据",
          uncertainty: "待核实",
        })),
      }),
    };
  });
  const input = { cutoff: Date.now() };
  state.news.mockReturnValue({ items: rows.slice(0, 2) });
  const first = await analyzeNews(input);
  sqlite().prepare("DELETE FROM records WHERE kind='news-item-analysis'").run();
  state.news.mockReturnValue({ items: rows });
  const next = await analyzeNews(input);
  expect(submissions).toEqual([[1, 2], [3]]);
  expect(next).toMatchObject({
    status: "complete",
    tokens: 10,
    reusedItems: 2,
  });
  expect(next.itemOrigins?.every((o) => o.analysisId === first.id)).toBe(true);
  expect(
    sqlite()
      .prepare(
        "SELECT count(*) count FROM records WHERE kind='news-item-analysis'",
      )
      .get(),
  ).toEqual({ count: 3 });
  state.news.mockReturnValue({ items: [rows[1]!] });
  expect(await analyzeNews(input)).toMatchObject({
    status: "complete",
    tokens: 0,
    reusedItems: 1,
  });
  expect(submissions).toHaveLength(2);
  state.provider = "claude:default";
  expect(await analyzeNews(input)).toMatchObject({
    model: "claude:default",
    tokens: 10,
    reusedItems: 0,
  });
  expect(submissions).toEqual([[1, 2], [3], [2]]);
});
