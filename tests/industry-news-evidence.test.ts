import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Snapshot } from "../src/lib/domain";
const state = vi.hoisted(() => ({
  db: undefined as Database.Database | undefined,
}));
vi.mock("../src/server/db", () => ({ sqlite: () => state.db! }));
import { industryNewsEvidence } from "../src/server/research/industry-news-evidence";
import { contextEvidence } from "../src/server/data-sources/hithink/hithink-context";
const now = Date.parse("2026-09-08T12:00:00Z");
const source = { symbol: "sh600519" } as Snapshot;
function basic(symbol = "sh600519", industry = "食品饮料") {
  return contextEvidence(symbol, "hithink-basicinfo-query", "fixture", {
    status_code: 0,
    columns: [],
    datas: [
      {
        股票代码: `${symbol.slice(2)}.${symbol.slice(0, 2).toUpperCase()}`,
        所属申万一级行业: industry,
      },
    ],
  });
}
function add(
  id: string,
  cutoff: number,
  industry = "食品饮料",
  createdAt = cutoff + 1,
) {
  const report = {
    id,
    cutoff,
    createdAt,
    input: { industry, analysisId: "classified" },
    model: "codex:default",
    method: { version: "news-sector-1", files: [] },
    classificationMethod: { version: "fixture", files: [] },
    coverage: { selected: 1, available: 1, classified: 1, original: 1 },
    result: { summary: { text: "模型解释", citations: [1] } },
    sources: [
      {
        classification: { id: 1, industry },
        news: {
          id: 1,
          hash: "fixture",
          content: "原文",
          publishedAt: new Date(cutoff - 1000).toISOString(),
          collectedAt: null,
        },
      },
    ],
  };
  state
    .db!.prepare("INSERT INTO records VALUES (?,?,?,?)")
    .run(id, "news-sector", JSON.stringify(report), createdAt);
}
beforeEach(() => {
  state.db = new Database(":memory:");
  state.db.exec(
    "CREATE TABLE records(id TEXT PRIMARY KEY,kind TEXT,payload TEXT,updated_at INTEGER)",
  );
  vi.spyOn(Date, "now").mockReturnValue(now);
});
afterEach(() => {
  state.db?.close();
  vi.restoreAllMocks();
});
it("精确行业映射复用同一背景，证券关联保留身份hash且不认定个股受益", () => {
  add("today", now - 1000);
  add("other", now - 500, "电子");
  const [background, link] = industryNewsEvidence(source, [basic()]);
  expect(JSON.parse(background!.text).reportId).toBe("today");
  expect(JSON.parse(link!.text)).toMatchObject({
    symbol: source.symbol,
    backgroundId: background!.id,
    identity: { industry: "食品饮料" },
  });
  expect(JSON.parse(link!.text).relationship).toContain("不代表");
  const [same, another] = industryNewsEvidence(
    { ...source, symbol: "sz000858" },
    [basic("sz000858")],
  );
  expect(same).toEqual(background);
  expect(another!.id).not.toEqual(link!.id);
});
it("排除昨天、未来截止和未来生成报告，按数据截止而不是重跑时间选最新", () => {
  add("yesterday", now - 86400000);
  add("future", now + 1000);
  add("late-generation", now - 500, "食品饮料", now + 1000);
  expect(industryNewsEvidence(source, [basic()])[0]!.source).toBe(
    "行业新闻关联检查",
  );
  add("new-cutoff", now - 1000);
  add("rerun-old", now - 2000, "食品饮料", now - 10);
  expect(
    JSON.parse(industryNewsEvidence(source, [basic()])[0]!.text).reportId,
  ).toBe("new-cutoff");
});
it("拒绝历史模式、错证券、模糊行业、篡改身份及过期归属", () => {
  add("today", now - 1000);
  expect(
    industryNewsEvidence({ ...source, historicalAsOf: "2026-09-07" }, [
      basic(),
    ]),
  ).toEqual([]);
  for (const entries of [
    [],
    [basic("sz000858")],
    [basic(), basic()],
    [basic("sh600519", "食品")],
    [{ ...basic(), text: basic().text.replace("食品饮料", "电子") }],
    [
      {
        ...basic(),
        envelope: { ...basic().envelope!, fetchedAt: now - 1800000 },
      },
    ],
  ])
    expect(industryNewsEvidence(source, entries)[0]!.source).toBe(
      "行业新闻关联检查",
    );
});
it("原文发布日期晚于档案截止不能作为已知背景", () => {
  add("today", now - 1000);
  state
    .db!.prepare(
      "UPDATE records SET payload=json_set(payload,'$.sources[0].news.publishedAt',?)",
    )
    .run(new Date(now).toISOString());
  expect(industryNewsEvidence(source, [basic()])[0]!.text).toContain(
    "时点无法核验",
  );
});
