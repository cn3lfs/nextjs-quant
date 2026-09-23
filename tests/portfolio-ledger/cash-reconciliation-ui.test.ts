import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import {
  cashReconciliationPage,
  reconcileCashDays,
  type CashDaySource,
} from "../../src/lib/portfolio/cash-reconciliation";
import { CashReconciliationResults } from "../../src/components/portfolio/cash-reconciliation-results";

const source = (cash: number): CashDaySource => ({
  batchId: "evidence-batch",
  fileHash: "file-sha256",
  rowIndexes: [7],
  rows: [{ rowIndex: 7, time: "15:00:00", balanceCash: cash, netAmount: 20 }],
  order: "single-row",
  openingCash: cash - 20,
  statementCash: cash,
  reason: null,
});
const result = () =>
  reconcileCashDays({
    openingCash: 80,
    projectedDays: [
      { date: "2026-01-05", cash: 100 },
      { date: "2026-01-06", cash: 120 },
      { date: "2026-01-07", cash: null },
    ],
    evidence: {
      days: [
        { date: "2026-01-05", sources: [source(100)] },
        { date: "2026-01-06", sources: [source(125)] },
      ],
      openings: [],
      diagnostics: [],
    },
  });
const render = (data: ReturnType<typeof cashReconciliationPage>) =>
  renderToStaticMarkup(
    createElement(CashReconciliationResults, {
      data,
      table: {
        pagination: { pageIndex: data.pageIndex, pageSize: data.pageSize },
        onPaginationChange: () => {},
      },
    }),
  );

it("renders the server page with global coverage, correct difference sign and expandable provenance", () => {
  const html = render(
    cashReconciliationPage(result(), { status: "difference", pageSize: 1 }),
  );
  expect(html).toContain("全账户汇总：3 天");
  expect(html).toContain("柜台 − 推算");
  expect(html).toContain("5.00");
  expect(html).toContain("存在差异");
  expect(html).toContain("file-sha256");
  expect(html).toContain("原始行号 7");
  expect(html).toContain("查看结构化余额证据");
  expect(html).toContain("不代表流水完整");
  expect((html.match(/<tr/g) ?? []).length).toBe(2);
  expect(html).not.toContain("data-table-sort");
});

it("leaves missing cash unknown and distinguishes no matching rows from reconciled evidence", () => {
  const missing = render(
    cashReconciliationPage(result(), { status: "unavailable" }),
  );
  expect(missing).toContain("待核对");
  expect(missing).toContain("该日无柜台余额证据");
  expect(missing).toContain("—");
  const empty = render(
    cashReconciliationPage(result(), { status: "conflict" }),
  );
  expect(empty).toContain("当前筛选下没有现金核对记录");
  expect(empty).toContain("存在差异 1 天");
});

it("does not claim complete coverage when the account has no evidence", () => {
  const html = render(
    cashReconciliationPage(
      reconcileCashDays({
        evidence: { days: [], openings: [], diagnostics: [] },
        projectedDays: [],
        openingCash: null,
      }),
    ),
  );
  expect(html).toContain("证据覆盖 未知 至 未知");
  expect(html).toContain("未保留可用的批次期初余额证据");
  expect(html).toContain("最大绝对差额 — 元");
});
