import { beforeEach, expect, it } from "vitest";
import { sqlite, put, atomic } from "~/server/db";
import {
  readArchiveRecord,
  localFinancialHistory,
} from "~/server/db/archive-records";
import { latestRpsObservation } from "~/server/db/rps-observations";
import {
  fiveMinuteItemsPage,
  loadFiveMinuteItems,
} from "~/server/db/five-minute-imports";
import {
  strategyCenterHistory,
  newsAnalysisIdForTask,
} from "~/server/db/workflow-history";
import { visitNewsAnalyses } from "~/server/db/news-analysis-history";
import { createJob, readJob } from "~/server/db/jobs";
import { updateJob } from "~/server/jobs/jobs";

beforeEach(() => sqlite().prepare("DELETE FROM records").run());
const id = "ab000000-0000-4000-8000-000000000000";

it.each([0, 1, 200, 201, 603])(
  "keeps all %i import items through bounded pages and complete iteration",
  (count) => {
    for (let n = 0; n < count; n++)
      put(
        "tdx-import-item",
        `tdx-import-item-${id}-${String(n).padStart(4, "0")}`,
        { symbol: `s${n}`, added: 1, state: n % 2 ? "failed" : "written" },
      );
    const symbols: string[] = [];
    for (let page = 0; page < Math.max(1, Math.ceil(count / 50)); page++) {
      const result = fiveMinuteItemsPage(id, page, "");
      expect(result.total).toBe(count);
      expect(result.summary.added).toBe(count);
      expect(result.items.length).toBeLessThanOrEqual(50);
      symbols.push(...result.items.map((row) => row.symbol));
    }
    expect(symbols).toEqual(Array.from({ length: count }, (_, n) => `s${n}`));
    expect(loadFiveMinuteItems(id).map((row) => row.symbol)).toEqual(symbols);
    expect(fiveMinuteItemsPage(id, 0, "failed").total).toBe(
      Math.floor(count / 2),
    );
  },
);

it("rejects illegal query boundaries and never reads a different record kind", () => {
  put("report", "same-id", { secret: "wrong kind" });
  expect(readArchiveRecord("snapshot", "same-id")).toBeUndefined();
  expect(() => readArchiveRecord("snapshot", "")).toThrow();
  expect(() => fiveMinuteItemsPage(id, -1, "")).toThrow();
  expect(() => fiveMinuteItemsPage(id, 0, "SQL injection")).toThrow(
    "明细筛选无效",
  );
  expect(() => loadFiveMinuteItems("wrong-id")).toThrow();
});

it("stably orders bounded metadata without parsing report bodies", () => {
  for (let n = 0; n < 201; n++)
    put("local-financial-archive", `archive-${String(n).padStart(3, "0")}`, {
      symbol: `s${n}`,
      createdAt: 1,
      reports: [{ reportDate: "2025-12-31" }],
      unused: "body",
    });
  sqlite().prepare("UPDATE records SET updated_at=1").run();
  const history = localFinancialHistory("local-financial-archive");
  expect(history).toHaveLength(100);
  expect(history[0]).toEqual({
    id: "archive-200",
    symbol: "s200",
    createdAt: 1,
    reportDate: "2025-12-31",
  });
  expect(history.at(-1)?.id).toBe("archive-101");
  put("job", "strategy-b", {
    status: "completed",
    input: { type: "strategy-center", strategyId: "ma", symbol: "sh600000" },
  });
  put("job", "strategy-a", {
    status: "completed",
    input: { type: "strategy-center", strategyId: "ma", symbol: "sh600000" },
  });
  sqlite().prepare("UPDATE records SET updated_at=1").run();
  expect(strategyCenterHistory().map((row) => row.id)).toEqual([
    "strategy-b",
    "strategy-a",
  ]);
  expect(newsAnalysisIdForTask("strategy-b")).toBeNull();
});

it("finds this RPS root beyond 200 unrelated newer records and excludes future observations", () => {
  put("rps-observation", "ours", { root: "D:/fixture/ours", createdAt: 1 });
  for (let n = 0; n < 201; n++)
    put("rps-observation", `other-${n}`, {
      root: "D:/fixture/other",
      createdAt: 2,
    });
  put("rps-observation", "future", { root: "D:/fixture/ours", createdAt: 100 });
  expect(latestRpsObservation("D:/fixture/ours", 10)).toEqual({
    root: "D:/fixture/ours",
    createdAt: 1,
  });
  expect(latestRpsObservation("D:/fixture/missing", 10)).toBeNull();
});

it("news history iterates one snapshot, supports early stop and forbids callback writes", () => {
  for (const name of ["a", "b", "c"])
    put("news-analysis", name, {
      id: name,
      model: "fixture",
      method: { version: "1", files: [] },
    });
  sqlite().prepare("UPDATE records SET updated_at=1").run();
  const seen: string[] = [];
  visitNewsAnalyses("fixture", { version: "1", files: [] }, (archive) => {
    seen.push(archive.id);
    return false;
  });
  expect(seen).toEqual(["c"]);
  expect(() =>
    visitNewsAnalyses("fixture", { version: "1", files: [] }, () => {
      put("news-analysis", "forbidden", {});
    }),
  ).toThrow();
  expect(sqlite().pragma("query_only", { simple: true })).toBe(0);
});

const archiveId = (hex: string) => `news-analysis-${hex.repeat(64)}`;
const putArchive = (id: string, news = 1, items = 1) =>
  put("news-analysis", id, {
    id,
    news: Array.from({ length: news }, (_, n) => ({ id: n + 1 })),
    items: Array.from({ length: items }, (_, n) => ({ id: n + 1 })),
  });

it("links a news task to its recorded archive and falls back to an older completion", () => {
  const recorded = archiveId("a"),
    completed = archiveId("b");
  putArchive(recorded);
  putArchive(completed);
  put("job", "news-recorded", {
    id: "news-recorded",
    status: "cancelled",
    input: { kind: "news-analysis" },
    result: { id: completed },
    newsAnalysisId: recorded,
  });
  expect(newsAnalysisIdForTask("news-recorded")).toBe(recorded);
  put("job", "news-completed", {
    id: "news-completed",
    status: "completed",
    input: { kind: "news-analysis" },
    result: { id: completed },
  });
  expect(newsAnalysisIdForTask("news-completed")).toBe(completed);
});

it("never exposes missing, empty, unrecorded or unrelated news archives", () => {
  const emptyNews = archiveId("c"),
    emptyItems = archiveId("d"),
    wrongKind = archiveId("e");
  put("news-analysis", emptyNews, {
    id: emptyNews,
    news: [],
    items: [{ id: 1 }],
  });
  put("news-analysis", emptyItems, {
    id: emptyItems,
    news: [{ id: 1 }],
    items: [],
  });
  put("report", wrongKind, {
    id: wrongKind,
    news: [{ id: 1 }],
    items: [{ id: 1 }],
  });
  for (const [task, archived] of [
    ["news-empty-news", emptyNews],
    ["news-empty-items", emptyItems],
    ["news-wrong-kind", wrongKind],
    ["news-cleaned", archiveId("f")],
  ] as const)
    put("job", task, {
      id: task,
      status: "failed",
      input: { kind: "news-analysis" },
      newsAnalysisId: archived,
    });
  put("job", "news-failed-unlinked", {
    id: "news-failed-unlinked",
    status: "failed",
    input: { kind: "news-analysis" },
  });
  put("job", "news-other-kind", {
    id: "news-other-kind",
    status: "completed",
    input: { kind: "news-themes" },
    result: { id: archiveId("0") },
  });
  for (const task of [
    "news-empty-news",
    "news-empty-items",
    "news-wrong-kind",
    "news-cleaned",
    "news-failed-unlinked",
    "news-other-kind",
  ])
    expect(newsAnalysisIdForTask(task)).toBeNull();
});

it("rolls the archive pointer back together with the first archive write", () => {
  const now = Date.now();
  createJob({
    id: "news-atomic",
    type: "research",
    status: "running",
    progress: 0,
    createdAt: now,
    updatedAt: now,
    input: { kind: "news-analysis" },
  });
  const first = archiveId("a");
  expect(() =>
    atomic(() => {
      putArchive(first);
      updateJob("news-atomic", { newsAnalysisId: first });
      throw new Error("fixture rollback");
    }),
  ).toThrow("fixture rollback");
  expect(readJob("news-atomic")?.newsAnalysisId).toBeUndefined();
  expect(newsAnalysisIdForTask("news-atomic")).toBeNull();
  const second = archiveId("b");
  atomic(() => {
    putArchive(second);
    updateJob("news-atomic", { newsAnalysisId: second });
  });
  expect(newsAnalysisIdForTask("news-atomic")).toBe(second);
});

it("refuses a late archive pointer after a news task is terminal", () => {
  const now = Date.now();
  createJob({
    id: "news-terminal",
    type: "research",
    status: "running",
    progress: 0,
    createdAt: now,
    updatedAt: now,
    input: { kind: "news-analysis" },
  });
  const first = archiveId("a"),
    late = archiveId("b");
  updateJob("news-terminal", { newsAnalysisId: first });
  expect(readJob("news-terminal")?.newsAnalysisId).toBe(first);
  expect(
    updateJob("news-terminal", { status: "cancelled", phase: "已取消" })
      ?.status,
  ).toBe("cancelled");
  updateJob("news-terminal", { newsAnalysisId: late });
  expect(readJob("news-terminal")).toMatchObject({
    status: "cancelled",
    newsAnalysisId: first,
  });
});
