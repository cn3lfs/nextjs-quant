import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import {
  periodPageSchema,
  tradeReviewPeriodPage,
} from "../../../src/server/research/performance/period-performance-service";
import { replayTradeReview } from "../../../src/server/portfolio/trade-review-service";
import type { NavDay } from "../../../src/lib/portfolio/trade-review-nav";
import { PeriodPerformanceResults } from "../../../src/components/backtest/period-performance-results";

const dates = [
  "2026-01-05",
  "2026-01-06",
  "2026-01-07",
  "2026-01-08",
  "2026-01-09",
];
function accountPage() {
  const snapshot = replayTradeReview({
    version: 1,
    account: "fixture",
    trades: { fills: [], cashFlows: [] },
    nav: { tradingDays: dates, openingCash: 100 },
    dimensions: {},
    batches: [],
    sources: [],
    warnings: [],
    rpsPeriod: 250,
  });
  snapshot.nav.days = dates.map((date, i): NavDay => ({
    date,
    positionValues: Object.fromEntries(
      (i === 4 ? ["sh600000", "sz000001"] : ["sh600000", "sh600001"]).map(
        (symbol) => [symbol, { value: 50, reason: null }],
      ),
    ),
    positions:
      i === 4
        ? { sh600000: 100, sz000001: 100 }
        : { sh600000: 100, sh600001: 100 },
    cash: { value: 100, reason: null },
    marketValue: { value: 100, reason: null },
    reverseRepoPrincipal: { value: 0, reason: null },
    nav: { value: 200, reason: null },
    dailyReturn: { value: 0.01, reason: null },
  }));
  const calendar = ["2026-01-02", ...dates];
  snapshot.replayInput.trades.bars = {
    sh600000: calendar.map((date, i) => ({
      date,
      open: 10,
      high: 20,
      low: 10,
      close: 10 + i,
      volume: 100,
      amount: 1000,
    })),
  };
  return tradeReviewPeriodPage(snapshot, periodPageSchema.parse({}), calendar);
}

it("account uses cutoff holdings and full calendar previous close without a false missing first return", () => {
  const page = accountPage();
  expect(page.matrix.rows.map((r) => r.id)).toEqual(["sh600000", "sz000001"]);
  expect(page.matrix.rows[0]!.cells[2]!.value).toBeCloseTo(15 / 10 - 1);
  expect(page.matrix.rows[1]!.cells[0]).toMatchObject({
    value: null,
    reason: "窗口内存在缺失日收益",
  });
  expect(page.matrix.summary[0]).toMatchObject({
    available: 1,
    profitable: 1,
    ratio: 1,
  });
  expect(page.periods[7]!.totalReturn.value).toBeCloseTo(1.01 ** 5 - 1);
});

it("renders all metrics, sample flags, column denominators, and collapses the matrix", () => {
  const data = accountPage();
  const props = {
    data,
    table: {
      pagination: { pageIndex: 0, pageSize: 10 },
      sorting: [],
      onPaginationChange: () => {},
      onSortingChange: () => {},
    },
    open: true,
    onOpenChange: () => {},
  };
  const html = renderToStaticMarkup(
    createElement(PeriodPerformanceResults, props),
  );
  for (const label of [
    "分段表现",
    "回归年化收益",
    "长度调整平均回撤",
    "truncated",
    "insufficientSample",
    "盈利标的数量",
    "盈利标的比例",
    "分母 1",
    "近360交易日",
    "窗口内存在缺失日收益",
  ])
    expect(html).toContain(label);
  expect(html).not.toMatch(/#[a-f\d]{6}\b/i);
  const closed = renderToStaticMarkup(
    createElement(PeriodPerformanceResults, { ...props, open: false }),
  );
  expect(closed).not.toContain("sh600000");
  expect(closed).not.toContain("盈利标的比例");
});
