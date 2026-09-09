import { expect, it } from "vitest";
import {
  pageScreenResults,
  exportScreenResults,
  type StoredScreenResult,
} from "../src/server/screen-results";
import type { Candidate } from "../src/lib/domain";
import { defaultStrategy, type Job } from "../src/lib/domain";
import { securityDisplayName } from "../src/lib/security-display";
it("sorts the entire filtered pool before pagination without changing archived order", () => {
  const rows = Array.from(
    { length: 123 },
    (_, i) =>
      ({
        symbol: `sh${600000 + i}`,
        name: i % 2 ? "甲组" : "乙组",
        metrics: { change: i, volumeRatio: 123 - i, close: i, score: i },
        snapshotId: `s-${i}`,
      }) as Candidate,
  );
  const result = { candidates: rows, errors: [], total: rows.length };
  const before = structuredClone(result);
  const page = (
    page: number,
    sort: "change" | "volumeRatio" | "symbol" | "original",
    direction: "asc" | "desc",
    query = "",
  ) =>
    pageScreenResults(result, {
      page,
      sort,
      direction,
      query,
      excludedPage: 0,
      errorPage: 0,
    });
  const sorted = [0, 1, 2].flatMap((p) => page(p, "change", "desc").candidates);
  expect(sorted.map((c) => c.symbol)).toEqual(
    [...rows].reverse().map((c) => c.symbol),
  );
  expect(page(0, "change", "asc").candidates[0]).toEqual(rows[0]);
  expect(page(0, "volumeRatio", "desc").candidates[0]).toEqual(rows[0]);
  expect(page(0, "symbol", "desc").candidates[0]).toEqual(rows[122]);
  expect(page(0, "change", "desc", "甲组").candidates[0]).toEqual(rows[121]);
  expect(page(0, "original", "desc").candidates).toEqual(rows.slice(0, 50));
  expect(result).toEqual(before);
});
it("breaks metric ties by code and keeps missing or nonfinite values last in either direction", () => {
  const rows = [
    { symbol: "sh600003", metrics: { score: NaN } },
    { symbol: "sh600002", metrics: { score: 2 } },
    { symbol: "sh600001", metrics: { score: 2 } },
    { symbol: "sh600004", metrics: {} },
  ] as Candidate[];
  for (const direction of ["asc", "desc"] as const) {
    const page = pageScreenResults(
      {
        candidates: rows.map((c) => ({ ...c, name: c.symbol })),
        errors: [],
        total: 4,
      },
      {
        page: 0,
        query: "",
        excludedPage: 0,
        errorPage: 0,
        sort: "score",
        direction,
      },
    );
    expect(page.candidates.map((c) => c.symbol)).toEqual([
      "sh600001",
      "sh600002",
      "sh600003",
      "sh600004",
    ]);
  }
});
it("finds both current and archived names without replacing stored evidence", () => {
  const row = {
    symbol: "sh600519",
    name: "归档旧名",
    snapshotId: "original",
    metrics: { close: 123 },
  } as Candidate;
  const result = { candidates: [row], errors: [], total: 1 };
  const before = structuredClone(result),
    names = { sh600519: "主档新名" };
  for (const query of ["主档新名", "归档旧名", "sh600519"]) {
    expect(
      pageScreenResults(
        result,
        { query, page: 0, excludedPage: 0, errorPage: 0 },
        names,
      ).candidates,
    ).toEqual([row]);
  }
  expect(securityDisplayName(row.symbol, names, row.name)).toBe("主档新名");
  expect(securityDisplayName(row.symbol, {}, row.symbol)).toBe("名称待补全");
  expect(result).toEqual(before);
});

it("full export includes every row and original parameters without internal snapshots or extra inputs", () => {
  const rows = Array.from(
    { length: 123 },
    (_, i) => ({ symbol: `sh${600000 + i}`, name: `证券${i}` }) as Candidate,
  );
  const job: Job = {
    id: "screen-fixture",
    type: "screen",
    status: "completed",
    progress: 100,
    createdAt: 1,
    updatedAt: 2,
    input: {
      strategy: defaultStrategy,
      period: "day",
      symbols: rows.map((row) => row.symbol),
      root: "fixture",
      apiKey: "not-for-export",
    },
    result: {
      candidates: rows,
      total: 369,
      excluded: rows.map((row) => ({ symbol: row.symbol, reason: "旧行情" })),
      errors: rows.map((row) => ({ symbol: row.symbol, error: "读取失败" })),
      snapshots: ["internal"],
    },
  };
  const exported = exportScreenResults(job);
  expect(exported.candidates).toHaveLength(123);
  expect(exported.excluded).toHaveLength(123);
  expect(exported.errors).toHaveLength(123);
  expect(exported.parameters.strategy).toEqual(defaultStrategy);
  expect(exported.parameters.symbols).toHaveLength(123);
  expect(exported.parameters).not.toHaveProperty("apiKey");
  expect(exported).not.toHaveProperty("snapshots");
  expect(exported.warnings[0]).toContain("旧任务");
  expect(() => exportScreenResults({ ...job, status: "running" })).toThrow(
    "已完成",
  );
});

it("pages every category without truncating totals or exposing stored snapshots", () => {
  const rows = Array.from({ length: 123 }, (_, i) => ({
    symbol: `sh${String(i).padStart(6, "0")}`,
    name: `证券${i}`,
  }));
  const stored = {
    candidates: rows as Candidate[],
    excluded: rows.map((row) => ({ ...row, reason: "旧行情" })),
    errors: rows.map((row) => ({ symbol: row.symbol, error: "读取失败" })),
    total: 369,
    snapshots: ["large-private-snapshot"],
  };
  const results = [0, 1, 2].map((page) =>
    pageScreenResults(stored, {
      page,
      excludedPage: page,
      errorPage: page,
      query: "",
    }),
  );
  for (const key of ["candidates", "excluded", "errors"] as const) {
    expect(results.map((result) => result[key].length)).toEqual([50, 50, 23]);
    expect(
      results.flatMap((result) => result[key].map((row) => row.symbol)),
    ).toEqual(rows.map((row) => row.symbol));
  }
  expect(results[0]).toMatchObject({
    count: 123,
    candidateTotal: 123,
    errorTotal: 123,
    excludedTotal: 123,
  });
  expect(results[0]).not.toHaveProperty("snapshots");
});
it("searches all candidates before paging and supports legacy results", () => {
  const stored: StoredScreenResult = {
    candidates: [{ symbol: "sh600519", name: "贵州茅台" } as Candidate],
    errors: [],
    total: 1,
  };
  const query = (text: string) =>
    pageScreenResults(stored, {
      page: 0,
      excludedPage: 0,
      errorPage: 0,
      query: text,
    });
  expect(query(" 茅台 ").count).toBe(1);
  expect(query("SH600519").count).toBe(1);
  expect(query("不存在")).toMatchObject({
    count: 0,
    candidateTotal: 1,
    excludedTotal: 0,
    excluded: [],
  });
});
