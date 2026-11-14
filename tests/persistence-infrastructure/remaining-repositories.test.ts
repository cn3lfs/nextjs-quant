import { beforeEach, expect, it } from "vitest";
import { sqlite, put } from "~/server/db";
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
