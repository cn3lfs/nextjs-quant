import { expect, it } from "vitest";
import assert from "node:assert/strict";
import { cashWorkspaceFixture } from "../helpers/cash-workspace-fixture";
import {
  cashWorkspacePage,
  cashWorkspaceDate,
  cashWorkspaceRows,
  cashWorkspaceOpening,
  cashWorkspaceDiagnostics,
} from "../../src/lib/portfolio/cash-workspace";
import { cashReconciliationPage } from "../../src/lib/portfolio/cash-reconciliation";
import { reconcileCashDays } from "../../src/lib/portfolio/cash-reconciliation";

it("keeps unknown projected cash distinct from zero and detects a zero-fill negative control", () => {
  const evidence = cashWorkspaceFixture(1).days[0]!.evidence;
  const date = "2026-01-01";
  const result = reconcileCashDays({
    openingCash: null,
    projectedDays: [{ date, cash: null }],
    evidence: {
      days: [{ date, sources: evidence }],
      openings: [],
      diagnostics: [],
    },
  });
  const page = cashWorkspacePage(result);
  expect(page.rows[0]).toMatchObject({
    projectedCash: null,
    difference: null,
    status: "unavailable",
  });
  const old = cashReconciliationPage(result).rows.map(
    ({ evidence, ...day }) => ({ ...day, sourceCount: evidence.length }),
  );
  assert.deepEqual(page.rows, old);
  const incorrectlyFilled = page.rows.map((day) => ({
    ...day,
    projectedCash: day.projectedCash ?? 0,
  }));
  expect(() => assert.deepEqual(incorrectlyFilled, old)).toThrow();
});

it("keeps all 10000 dates and exact old amounts/statuses across 500 bounded pages", () => {
  const result = cashWorkspaceFixture(10000, 20000);
  const before = JSON.stringify(result);
  const found = [];
  for (let pageIndex = 0; pageIndex < 500; pageIndex++) {
    const selected = cashWorkspacePage(result, { pageIndex });
    expect(Buffer.byteLength(JSON.stringify(selected))).toBeLessThanOrEqual(
      65536,
    );
    expect(selected.summary).toEqual(result.summary);
    found.push(...selected.rows);
  }
  expect(found).toEqual(
    [...result.days].reverse().map(({ evidence, ...day }) => ({
      ...day,
      sourceCount: evidence.length,
    })),
  );
  expect(new Set(found.map((day) => day.date)).size).toBe(10000);
  expect(JSON.stringify(result)).toBe(before);
  // Known violating old response proves this size guard detects eager evidence.
  expect(
    Buffer.byteLength(JSON.stringify(cashReconciliationPage(result))),
  ).toBeGreaterThan(65536);
});

it("filters display only, validates dates, clamps pages and sorts missing last with stable dates", () => {
  const result = cashWorkspaceFixture(12);
  const date = result.days[5]!.date;
  const selected = cashWorkspacePage(result, {
    start: date,
    end: date,
    status: "difference",
    pageIndex: 100,
  });
  expect(selected.total).toBe(1);
  expect(selected.pageIndex).toBe(0);
  expect(selected.rows[0]).toMatchObject({
    date,
    projectedCash: 105,
    difference: 0.01,
  });
  expect(selected.summary.days).toBe(12);
  expect(() => cashWorkspacePage(result, { start: "2026-02-30" })).toThrow();
  expect(() =>
    cashWorkspacePage(result, { start: "2026-02-02", end: "2026-02-01" }),
  ).toThrow();
  for (const desc of [false, true]) {
    const rows = cashWorkspacePage(result, {
      order: { id: "difference", desc },
    }).rows;
    expect(rows.at(-1)?.difference).toBeNull();
    expect(
      rows.filter((day) => day.difference === 0).map((day) => day.date),
    ).toEqual([8, 4, 0].map((i) => result.days[i]!.date));
  }
  expect(
    cashWorkspacePage(result, {
      status: "matched",
      start: "2026-01-01",
      pageIndex: 5,
    }),
  ).toMatchObject({ rows: [], total: 0, pageIndex: 0 });
});

it.each([1, 20, 1000])(
  "pages all %i sources and 20000 evidence rows without truncating or embedding them",
  (sourceCount) => {
    const result = cashWorkspaceFixture(1, 20000);
    const first = result.days[0]!;
    first.evidence = Array.from({ length: sourceCount }, (_, i) => ({
      ...first.evidence[0]!,
      batchId: `source-${i}`,
    }));
    const sources = [];
    for (
      let pageIndex = 0;
      pageIndex < Math.ceil(sourceCount / 20);
      pageIndex++
    )
      sources.push(
        ...cashWorkspaceDate(result, first.date, { pageIndex }).sources.rows,
      );
    expect(sources.map((source) => source.batchId)).toEqual(
      first.evidence.map((source) => source.batchId),
    );
    expect(sources[0]).not.toHaveProperty("rows");
    expect(sources[0]).not.toHaveProperty("rowIndexes");
    const rows = [];
    for (let pageIndex = 0; pageIndex < 1000; pageIndex++)
      rows.push(
        ...cashWorkspaceRows(result, first.date, "source-0", { pageIndex })
          .rows,
      );
    expect(rows).toEqual(first.evidence[0]!.rows);
    expect(() => cashWorkspaceRows(result, first.date, "gone")).toThrow(
      "来源已不存在",
    );
    expect(() => cashWorkspaceDate(result, "2026-01-01")).toThrow(
      "日期已不存在",
    );
  },
);

it("preserves unknown opening and all diagnostics independently", () => {
  const result = cashWorkspaceFixture(0);
  result.opening.cash = null;
  result.diagnostics = Array.from({ length: 21 }, (_, i) => ({
    batchId: `source-${i}`,
    rowIndex: null,
    reason: "缺失",
  }));
  expect(cashWorkspaceOpening(result)).toMatchObject({
    cash: null,
    rows: [],
    total: 0,
  });
  expect(cashWorkspaceDiagnostics(result, { pageIndex: 1 })).toMatchObject({
    total: 21,
    rows: [result.diagnostics[20]],
  });
  expect(cashWorkspacePage(result)).toMatchObject({
    rows: [],
    summary: { days: 0 },
    diagnosticCount: 21,
  });
});
