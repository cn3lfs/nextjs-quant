import { expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import {
  pageRollingPerformance,
  rollingPageSchema,
  tradeReviewRollingPage,
  researchRollingPage,
} from "../src/server/research/performance/rolling-performance-service";
import { rollingPerformance } from "../src/lib/rolling-performance";
import { replayTradeReview } from "../src/server/portfolio/trade-review-service";
import { RollingPerformanceResults } from "../src/components/rolling-performance-results";
import type {
  ResearchStore,
  ResearchResult,
} from "../src/server/backtest/research-store";
import type { ResearchDataset } from "../src/server/backtest/research-dataset";
import { researchSpecSchema } from "../src/lib/strategy-research";

vi.mock("../src/components/chart", () => ({
  RollingPerformanceChart: () =>
    createElement("div", { role: "img", "aria-label": "滚动绩效曲线" }),
}));
const dates = Array.from(
  { length: 1800 },
  (_, i) => new Date(Date.UTC(2020, 0, i + 1)),
)
  .filter((d) => d.getUTCDay() !== 0 && d.getUTCDay() !== 6)
  .slice(0, 1265)
  .map((d) => d.toISOString().slice(0, 10));
const input = {
  dates,
  tradingDays: dates,
  returns: dates.map((_, i) => (i % 7 === 0 ? null : ((i % 5) - 2) / 100)),
};

it("1265 days return only one server-sorted page of 17 metrics and stable compact curves", () => {
  const page = rollingPageSchema.parse({});
  const first = pageRollingPerformance(input, page, "fixture");
  const second = pageRollingPerformance(
    input,
    { ...page, pageIndex: 1 },
    "fixture",
  );
  expect(first.rowCount).toBe(1206);
  expect(first.rows).toHaveLength(10);
  expect(second.rows[0]!.endDate).toBe(dates[1254]);
  expect(first.rows[0]!.endDate).toBe(dates[1264]);
  expect(first.curve).toEqual(second.curve);
  expect(first.curve[0]).toMatchObject({ endDate: dates[59] });
  expect(Object.keys(first.curve[0]!)).toEqual([
    "endDate",
    "insufficientCoverage",
    "sharpeWbt",
    "maxDrawdown",
    "annualReturn",
  ]);
  expect(
    pageRollingPerformance(input, { ...page, pageIndex: 120 }, "fixture").rows,
  ).toHaveLength(6);
  expect(
    pageRollingPerformance(input, { ...page, pageIndex: 121 }, "fixture").rows,
  ).toEqual([]);
  const sorted = pageRollingPerformance(
    input,
    { ...page, sort: "annualReturn", desc: false },
    "fixture",
  );
  const expected = rollingPerformance(input).sort(
    (a, b) =>
      a.annualReturn.value! - b.annualReturn.value! ||
      a.endDate.localeCompare(b.endDate),
  );
  expect(sorted.rows).toEqual(expected.slice(0, 10));
  const html = renderToStaticMarkup(
    createElement(RollingPerformanceResults, {
      data: first,
      table: {
        pagination: { pageIndex: 0, pageSize: 10 },
        sorting: [{ id: "endDate", desc: true }],
        onPaginationChange: () => {},
        onSortingChange: () => {},
      },
    }),
  );
  expect(html.match(/<tr[ >]/g)).toHaveLength(11);
  expect(html).toContain("60%");
  expect(html).toContain("1206");
  expect(html).not.toContain(dates[100]!);
});

it("null sort values remain last in both directions and ties use dates", () => {
  for (const desc of [true, false]) {
    const data = pageRollingPerformance(
      {
        dates: dates.slice(0, 3),
        tradingDays: dates,
        returns: [null, 0.1, 0.1],
      },
      rollingPageSchema.parse({ window: 1, sort: "totalReturn", desc }),
      "",
    );
    expect(data.rows.map((r) => r.endDate)).toEqual([
      dates[1],
      dates[2],
      dates[0],
    ]);
  }
  expect(() => rollingPageSchema.parse({ sort: "injected" })).toThrow();
  expect(() => rollingPageSchema.parse({ pageSize: 101 })).toThrow();
  expect(() => rollingPageSchema.parse({ pageIndex: -1 })).toThrow();
  expect(() =>
    pageRollingPerformance(
      input,
      rollingPageSchema.parse({ window: 3, minPeriods: 4 }),
      "",
    ),
  ).toThrow();
});

it("account adapter forwards TWR nulls and the supplied calendar", () => {
  const snapshot = replayTradeReview({
    version: 1,
    account: "fixture",
    trades: { fills: [], cashFlows: [] },
    nav: { tradingDays: dates.slice(0, 3), openingCash: 100 },
    dimensions: {},
    batches: [],
    sources: [],
    warnings: [],
    rpsPeriod: 250,
  });
  snapshot.nav.days = [0, 2].map((i) => ({
    date: dates[i]!,
    positionValues: {},
    positions: {},
    cash: { value: 100, reason: null },
    marketValue: { value: 0, reason: null },
    reverseRepoPrincipal: { value: 0, reason: null },
    nav: { value: 100, reason: null },
    dailyReturn: {
      value: i === 0 ? 0.1 : null,
      reason: i === 0 ? null : "缺失",
    },
  }));
  const data = tradeReviewRollingPage(
    snapshot,
    rollingPageSchema.parse({ window: 3 }),
    dates,
  );
  expect(data.rows[0]!.coverage).toEqual({
    observedDays: 3,
    availableDays: 1,
    nullDays: 2,
    zeroReturnDays: 0,
  });
  expect(data.rows[0]!.insufficientCoverage).toBe(true);
  const html = renderToStaticMarkup(
    createElement(RollingPerformanceResults, {
      data,
      table: {
        pagination: { pageIndex: 0, pageSize: 10 },
        sorting: [],
        onPaginationChange: () => {},
        onSortingChange: () => {},
      },
    }),
  );
  expect(html).toContain("insufficientCoverage：覆盖不足");
});

it("research uses frozen partition dates without bridging independent capital or stale prices", () => {
  const spec = researchSpecSchema.parse({
    strategy: "dual-breakout",
    start: dates[0],
    end: dates[5],
    validationStart: dates[3],
  });
  // 只提供适配器消费的字段；测试不触碰数据库或迁移。
  const result = {
    spec,
    partitions: ["development", "validation"].map((partition, j) => ({
      partition,
      simulation: {
        nav: dates.slice(j * 3, j * 3 + 3).map((date, i) => ({
          date,
          value: spec.initialCapital * (1 + (i + 1) / 10),
          cash: 0,
          stale: i === 1 ? ["sh600000"] : [],
        })),
      },
    })),
  } as ResearchResult;
  const store = {
    result: () => result,
    dataset: () => ({ calendar: dates }) as ResearchDataset,
  } as unknown as ResearchStore;
  for (const partition of ["development", "validation"] as const) {
    const data = researchRollingPage(
      store,
      "fixture",
      partition,
      rollingPageSchema.parse({ window: 3 }),
    );
    expect(data.rows[0]!.totalReturn.value).toBeCloseTo(0.1);
    expect(data.rows[0]!.coverage.nullDays).toBe(2);
    expect(data.rows[0]!.startDate).toBe(
      dates[partition === "development" ? 0 : 3],
    );
  }
  expect(() =>
    researchRollingPage(
      { result: () => null, dataset: () => null } as unknown as ResearchStore,
      "missing",
      "validation",
      rollingPageSchema.parse({}),
    ),
  ).toThrow("尚不可得");
});

it("both containers wire rolling separately from the existing U2/U6/U8 paths", () => {
  const trade = readFileSync(
    "src/components/trade-review-container.tsx",
    "utf8",
  );
  const research = readFileSync(
    "src/components/strategy-research-controls.tsx",
    "utf8",
  );
  for (const source of [trade, research])
    expect(source).toContain("<RollingPerformanceContainer");
  expect(trade).toContain("utils.tradeReviewRollingPerformance.invalidate()");
  expect(research).toContain(
    "utils.strategyResearchRollingPerformance.invalidate()",
  );
  const container = readFileSync(
    "src/components/rolling-performance-container.tsx",
    "utf8",
  );
  expect(container).toContain("api.tradeReviewRollingPerformance.useQuery");
  expect(container).toContain(
    "api.strategyResearchRollingPerformance.useQuery",
  );
  expect(container).toContain("...pagination");
  expect(container).toContain("resetPage()");
});
