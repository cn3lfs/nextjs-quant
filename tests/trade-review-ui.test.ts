import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { migrate } from "../src/server/db/migrations";
import {
  previewDeliveryImport,
  commitDeliveryImport,
} from "../src/server/delivery-import-service";
import { TradeReviewPreview } from "../src/components/trade-review-import";
import {
  TradeReviewCaveats,
  TradeReviewResults,
} from "../src/components/trade-review-results";
import { replayTradeReview } from "../src/server/trade-review-service";
const dbs: Database.Database[] = [];
it("R7 页面展示连续段TWR与起止日期", () => {
  const data = replayTradeReview({
    version: 1,
    account: "合成账户",
    trades: {
      fills: [],
      cashFlows: [
        {
          kind: "interest",
          rowIndex: 1,
          flowDate: "2026-01-02",
          flowTime: "10:00:00",
          code: null,
          name: null,
          amount: 10,
          balanceCash: null,
          summary: "利息",
          fingerprintSource: "fixture",
        },
      ],
    },
    nav: { openingCash: 100, tradingDays: ["2026-01-01", "2026-01-02"] },
    dimensions: {},
    batches: [],
    sources: [],
    warnings: [],
    rpsPeriod: 250,
  });
  const html = renderToStaticMarkup(
    createElement(TradeReviewResults, {
      data: {
        ...data,
        calendar: {
          source: "合成",
          hash: "fixture",
          coverage: { start: "2026-01-01", end: "2026-01-02", count: 2 },
          start: "2026-01-01",
          end: "2026-01-02",
        },
        rounds: [],
        rowCount: 0,
        tradePoints: [],
        pointCount: 0,
        attributionCount: 0,
        monthCount: 1,
        drawdowns: [],
        drawdownCount: 0,
        attribution: [],
        excludedCashFlows: [],
        feeSources: [],
      },
      method: "movingAverage",
      onMethodChange: () => {},
      drawdownsOpen: false,
      onDrawdownsOpenChange: () => {},
      drawdownTable: {
        pagination: { pageIndex: 0, pageSize: 10 },
        sorting: [{ id: "drawdown", desc: true }],
        onPaginationChange: () => {},
        onSortingChange: () => {},
      },
      pointTable: {
        pagination: { pageIndex: 0, pageSize: 10 },
        sorting: [],
        onPaginationChange: () => {},
        onSortingChange: () => {},
      },
      attributionTable: {
        pagination: { pageIndex: 0, pageSize: 10 },
        sorting: [],
        onPaginationChange: () => {},
        onSortingChange: () => {},
      },
      pagination: { pageIndex: 0, pageSize: 20 },
      sorting: [],
      monthPagination: { pageIndex: 0, pageSize: 12 },
      onPaginationChange: () => {},
      onSortingChange: () => {},
      onMonthPaginationChange: () => {},
    }),
  );
  expect(html).toContain("分段 TWR：10.00%");
  expect(html).toContain('aria-label="回撤明细"');
  expect(html).toContain("没有回撤区间。");
  expect(html).toContain("展开查看");
  expect(html).toContain("2026-01-01");
  expect(html).toContain("2026-01-02");
});
afterEach(() => dbs.splice(0).forEach((db) => db.close()));
const options = {
  account: "合成账户",
  source: "generic",
  fileName: "合成.csv",
};
function setup() {
  const db = new Database(":memory:");
  dbs.push(db);
  migrate(db);
  return db;
}
it("renders a writable preview, unmapped columns and parser diagnostics before confirmation", () => {
  const db = setup();
  const bytes = readFileSync("tests/fixtures/delivery/eastmoney-statement.csv");
  const preview = previewDeliveryImport(bytes, options, db);
  const html = renderToStaticMarkup(
    createElement(TradeReviewPreview, {
      preview,
      busy: false,
      onConfirm: () => {},
    }),
  );
  expect(html).toContain(`将写入 ${preview.summary.new} 行`);
  expect(html).toContain("列映射结果");
  expect(html).toContain("未映射的列");
  for (const column of preview.unmapped) expect(html).toContain(column.header);
  expect(preview.diagnostics.length).toBeGreaterThan(0);
  for (const message of preview.diagnostics) expect(html).toContain(message);
  expect(html).toMatch(/<button(?![^>]* disabled="")[^>]*>确认导入<\/button>/);
  expect(html).not.toContain("888888888");
});
it("renders conflict details and disables confirmation", () => {
  const db = setup();
  const bytes = readFileSync("tests/fixtures/delivery/tdx-statement.txt");
  commitDeliveryImport(bytes, options, db);
  const preview = previewDeliveryImport(
    Buffer.from(bytes.toString().replace("19250.00", "19251.00")),
    options,
    db,
  );
  const html = renderToStaticMarkup(
    createElement(TradeReviewPreview, {
      preview,
      busy: false,
      onConfirm: () => {},
    }),
  );
  expect(preview.summary.conflict).toBe(1);
  expect(html).toContain("存在冲突，禁止导入");
  expect(html).toContain("差异字段：amount");
  expect(html).toMatch(/<button[^>]* disabled=""[^>]*>确认导入<\/button>/);
});
it("shows residual, unknown opening explanation and excluded flow amounts independently", () => {
  const html = renderToStaticMarkup(
    createElement(TradeReviewCaveats, {
      data: {
        unexplainedCashResidual: {
          value: 17554.45,
          reason: null,
          eventIndex: 0,
          date: "2026-01-05",
          rowIndex: 1,
          statementCash: 200000,
          projectedCash: 182445.55,
        },
        excludedCashFlows: [
          {
            batchId: "fixture",
            rowIndex: 2,
            reason: "失败/作废",
            cells: [],
            amount: -500,
            amountReason: null,
          },
        ],
        basis: {
          attribution: "描述性",
          prices: "未复权",
          rps: "未知",
          membership: "当前成分",
          cash: "不平账",
          openingCash: "反推",
          costMethods: "两种口径",
        },
      },
    }),
  );
  expect(html).toContain("17554.45");
  expect(html).toContain("openingUnknown");
  expect(html).toContain("开仓成本与收益留空");
  expect(html).toContain("不自动平账");
  expect(html).toContain("已排除作废流水 1 笔");
  expect(html).toContain("-500.00");
});
