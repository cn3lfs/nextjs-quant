import Database from "better-sqlite3";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { migrate } from "../src/server/db/migrations";
import {
  ResearchStore,
  type ResearchResult,
} from "../src/server/research-store";
import { researchPortfolio } from "../src/server/research-portfolio";
import { researchSpecSchema } from "../src/lib/strategy-research";
import {
  periodPageSchema,
  researchPeriodPage,
  researchDailyReturns,
  tradeReviewPeriodPage,
} from "../src/server/period-performance-service";
import { replayTradeReview } from "../src/server/trade-review-service";
import type { NavDay } from "../src/lib/trade-review-nav";
import { PeriodPerformanceResults } from "../src/components/period-performance-results";

const dates = [
  "2026-01-05",
  "2026-01-06",
  "2026-01-07",
  "2026-01-08",
  "2026-01-09",
];
const spec = researchSpecSchema.parse({
  strategy: "dual-breakout",
  start: dates[0],
  end: dates[4],
  validationStart: dates[2],
});
function researchResult(): ResearchResult {
  return {
    version: "strategy-research-result-1",
    spec,
    datasetHash: "fixture",
    marketEvidenceHash: "fixture",
    events: [],
    outcomes: [],
    exclusions: [],
    warnings: [],
    hash: "fixture",
    partitions: (["development", "validation"] as const).map((partition) => ({
      partition,
      events: 0,
      pending: 0,
      unavailable: 0,
      eventStatistics: {
        count: 0,
        wins: 0,
        losses: 0,
        flat: 0,
        winRate: null,
        averageWin: null,
        averageLoss: null,
        payoffRatio: null,
        expectancy: null,
        distribution: {
          minimum: null,
          p25: null,
          median: null,
          p75: null,
          maximum: null,
        },
      },
      simulation: {
        ...researchPortfolio(spec, [], dates, new Map(), () => null),
        nav: (partition === "development"
          ? dates.slice(0, 2)
          : dates.slice(2)
        ).map((date, i) => ({
          date,
          value: spec.initialCapital * (1 + (i + 1) / 10),
          cash: 0,
          stale: [],
        })),
      },
    })),
  };
}

it("research returns restart at partition capital and do not bridge stale valuation", () => {
  const result = researchResult();
  const derived = researchDailyReturns(result, "validation", dates.slice(2));
  expect(derived[0]).toBeCloseTo(0.1);
  expect(derived[1]).toBeCloseTo(1.2 / 1.1 - 1);
  expect(
    researchDailyReturns(result, "validation", dates.slice(3))[0],
  ).toBeNull();
  expect(
    researchDailyReturns(result, "validation", [dates[2]!, dates[4]!])[1],
  ).toBeNull();
  result.partitions[1]!.simulation!.nav[1]!.stale = ["sh600000"];
  expect(researchDailyReturns(result, "validation", dates.slice(2))).toEqual([
    derived[0],
    null,
    null,
  ]);
  result.partitions[1]!.simulation = null;
  expect(researchDailyReturns(result, "validation", dates.slice(2))).toEqual([
    null,
    null,
    null,
  ]);
});

it("research paging includes more than the tasks UI limit and leaves unavailable simulations null", () => {
  const db = new Database(":memory:");
  migrate(db);
  try {
    const store = new ResearchStore(db),
      result = researchResult();
    let selected = "";
    for (let i = 0; i < 105; i++) {
      const task = store.create(spec, null);
      store.finish(
        task.id,
        i === 104
          ? {
              ...result,
              partitions: result.partitions.map((p) => ({
                ...p,
                simulation: null,
              })),
            }
          : result,
      );
      selected = task.id;
    }
    // Frozen calendar is the only dataset field this read-only projection consumes.
    db.prepare("INSERT INTO records VALUES (?,?,?,?)").run(
      `${selected}:dataset`,
      "research-dataset",
      JSON.stringify({ calendar: dates }),
      0,
    );
    const page = researchPeriodPage(
      store,
      selected,
      "validation",
      periodPageSchema.parse({ pageIndex: 10, pageSize: 10 }),
    );
    expect(store.tasks()).toHaveLength(100);
    expect(page.matrix.rowCount).toBe(105);
    expect(page.matrix.rows).toHaveLength(5);
    expect(page.matrix.summary[0]).toMatchObject({
      available: 104,
      profitable: 104,
      ratio: 1,
    });
    expect(page.periods[7]!.totalReturn.value).toBeNull();
    expect(page.periods[7]!.coverage.nullDays).toBe(3);
    expect(() =>
      researchPeriodPage(
        store,
        "missing",
        "validation",
        periodPageSchema.parse({}),
      ),
    ).toThrow("尚不可得");
  } finally {
    db.close();
  }
});

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
