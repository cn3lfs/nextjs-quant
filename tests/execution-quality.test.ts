import { tradeReviewDayVwap } from "../src/lib/trade-review-vwap";
import { classifyCode } from "../src/lib/delivery-import";
import { expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ParsedFill, ParsedCashFlow } from "../src/lib/delivery-import";
import type { Bar } from "../src/lib/domain";
import {
  executionRows,
  summarizeExecution,
  reviewExecutionQuality,
  auditExecutionRows,
} from "../src/lib/execution-quality";
import { reviewTradeNav } from "../src/lib/trade-review-nav";
import {
  replayTradeReview,
  buildTradeReviewSnapshot,
} from "../src/server/trade-review-service";
import {
  exportExecutionQuality,
  pageExecutionQuality,
} from "../src/server/execution-quality-service";
import { commitDeliveryImport } from "../src/server/delivery-import-service";
import { migrate } from "../src/server/db/migrations";
import { ExecutionQualityResults } from "../src/components/execution-quality-results";
import { readSnapshot } from "../src/server/tdx";

const date = "2026-01-05";
const bar = (extra: Partial<Bar> = {}): Bar => ({
  date,
  open: 100,
  high: 110,
  low: 90,
  close: 100,
  amount: 10000,
  volume: 100,
  ...extra,
});
const fill = (extra: Partial<ParsedFill> = {}): ParsedFill => ({
  kind: "buy",
  rowIndex: 1,
  tradeDate: date,
  tradeTime: "10:00:00",
  code: "000001",
  symbol: "sz000001",
  instrument: "stock",
  name: "样本",
  price: 100,
  quantity: 1,
  amount: 100,
  fees: { commission: 0, stampTax: 0, transferFee: 0, otherFee: 0, total: 0 },
  netAmount: null,
  balanceShares: null,
  balanceCash: null,
  orderId: null,
  dealId: null,
  businessFlag: null,
  summary: "",
  fingerprintSource: "",
  anomalies: [],
  ...extra,
});
const input = (
  fills = [fill()],
  bars: Record<string, Bar[]> = { sz000001: [bar()] },
) => ({
  fills,
  bars,
  cashFlows: [] as ParsedCashFlow[],
  tradingDays: [date],
  openingCash: 1000,
});
const snapshot = (fills = [fill()]) =>
  replayTradeReview({
    version: 1,
    account: "private-account",
    trades: { fills, bars: { sz000001: [bar()] } },
    nav: { tradingDays: [date], openingCash: 100000 },
    dimensions: {},
    batches: [],
    sources: [],
    warnings: [],
    rpsPeriod: 250,
  });

it.each([
  ["buy", 101, 100, 1.01],
  ["buy", 99, -100, -0.99],
  ["sell", 101, -100, -1.01],
  ["sell", 99, 100, 0.99],
] as const)("%s at %s: signed BP and cost", (kind, price, bp, cost) => {
  // Buy: (101-100)/100*10000=100 BP; sell reverses the numerator.
  // Cost: 100/10000*101=1.01, intentionally gross-amount weighted (§3.1).
  const row = executionRows(
    [fill({ kind, price, amount: price })],
    input().bars,
  )[0]!;
  expect(row.slippageBp.value).toBeCloseTo(bp, 12);
  expect(row.slippageCost.value).toBeCloseTo(cost, 12);
});

it("uses gross-amount weighting and original fees, never the simple mean", () => {
  const rows = executionRows(
    [
      fill({ price: 101, amount: 101 }),
      fill({ price: 100, quantity: 100, amount: 10000 }),
    ],
    input().bars,
  );
  const summary = summarizeExecution(rows);
  // (100*101 + 0*10000)/(101+10000) = 10100/10101 BP; simple mean is 50 BP.
  expect(summary.averageSlippageBp.value).toBeCloseTo(10100 / 10101, 12);
  expect(summary.averageSlippageBp.value).not.toBe(50);
  expect(summary.totalCost.value).toBeCloseTo(1.01);
  expect(summary.costBp.value).toBeCloseTo(10100 / 10101, 12);
  const fees = {
    commission: 1,
    stampTax: 2,
    transferFee: 3,
    otherFee: 4,
    total: 10,
  };
  const charged = summarizeExecution(
    executionRows([fill({ fees })], input().bars),
  );
  expect(
    Object.fromEntries(
      Object.entries(charged.fees).map(([k, v]) => [k, v.value]),
    ),
  ).toEqual(fees);
  expect(charged.totalCost.value).toBe(10);
});

it.each([
  { volume: 0 },
  { volume: -1 },
  { amount: 0 },
  { amount: -1 },
  { amount: Infinity },
  { volume: NaN },
])("invalid VWAP propagates to the entire replay: %j", (invalid) => {
  expect(tradeReviewDayVwap(bar(invalid)).value).toBeNull();
  const result = reviewExecutionQuality(
    input([fill(), fill({ code: "000002", symbol: "sz000002" })], {
      sz000001: [bar(invalid)],
      sz000002: [bar()],
    }),
  );
  expect(result.rows[0]!.slippageBp).toMatchObject({
    value: null,
    reason: expect.any(String),
  });
  expect(result.counterfactual).toBeNull();
  expect(result.loss.value).toBeNull();
  expect(result.loss.reason).toContain(`${date} 000001`);
  expect(result.missingVwap).toHaveLength(1);
  expect(result.summary.slippageCost.value).toBeNull();
  expect(result.summary.fees.total.value).toBe(0);
});

it("missing/duplicate dates never substitute close, and all missing trades are listed", () => {
  const result = reviewExecutionQuality(
    input([fill(), fill({ code: "000002", symbol: "sz000002" })], {
      sz000001: [bar(), bar()],
      sz000002: [bar({ date: "2026-01-06" })],
    }),
  );
  expect(result.counterfactual).toBeNull();
  expect(result.missingVwap.map((r) => r.code)).toEqual(["000001", "000002"]);
});

it("reverse repo is excluded from every numerator and denominator, including legacy prefixes", () => {
  const rows = executionRows(
    [
      fill(),
      ...["204001", "131810"].map((code) =>
        fill({
          code,
          symbol: code,
          amount: 1000000,
          fees: {
            commission: 999,
            stampTax: 0,
            transferFee: 0,
            otherFee: 0,
            total: 999,
          },
        }),
      ),
    ],
    input().bars,
  );
  expect(rows).toHaveLength(1);
  expect(summarizeExecution(rows)).toMatchObject({
    count: 1,
    amount: { value: 100 },
    fees: { total: { value: 0 } },
  });
  expect(
    reviewExecutionQuality(
      input([fill({ code: "204001", instrument: "reverseRepo" })]),
    ).loss.value,
  ).toBeNull();
});

it("R12 Shanghai hand / Shenzhen bond fixture preserves amount and has zero loss", () => {
  // Same economic quantities as tests/trade-review-market.test.ts R12 fixture.
  const fills = [
    fill({
      code: "113050",
      symbol: "sh113050",
      instrument: "convertible",
      price: 144.967,
      quantity: 10,
      amount: 14496.7,
    }),
    fill({
      code: "123001",
      symbol: "sz123001",
      instrument: "convertible",
      price: 144.967,
      quantity: 100,
      amount: 14496.7,
    }),
  ];
  const result = reviewExecutionQuality({
    ...input(fills),
    openingCash: 100000,
    bars: {
      sh113050: [bar({ close: 1449.67, amount: 144967 })],
      sz123001: [bar({ close: 144.967, amount: 14496.7 })],
    },
  });
  expect(result.rows.map((r) => r.vwap.value)).toEqual([144.967, 144.967]);
  expect(result.rows.map((r) => r.slippageBp.value)).toEqual([0, 0]);
  expect(result.loss.value).toBeCloseTo(0, 12);
  expect(result.counterfactual?.days[0]?.cash.value).toBeCloseTo(71006.6);
  const invalid = executionRows([{ ...fills[0]!, amount: 1449.67 }], {
    sh113050: [bar({ amount: 144967 })],
  });
  expect(invalid[0]?.vwap.reason).toContain("数量单位");
});

it("correctness anchor: every fill equals VWAP, including fees, balances and flow valuation", () => {
  const fees = {
    commission: 1,
    stampTax: 0,
    transferFee: 0,
    otherFee: 0,
    total: 1,
  };
  const source = input([
    fill({ netAmount: -101, balanceCash: 899, fees }),
    fill({ kind: "sell", rowIndex: 3, netAmount: 99, balanceCash: 1098, fees }),
  ]);
  source.cashFlows = [
    {
      kind: "transferIn",
      rowIndex: 2,
      flowDate: date,
      flowTime: null,
      code: null,
      name: null,
      amount: 100,
      balanceCash: null,
      summary: "",
      fingerprintSource: "",
    },
  ];
  const data = { ...source, flowValuations: { 0: 999 } };
  const before = structuredClone(data);
  const result = reviewExecutionQuality(data);
  expect(result.loss.value).toBeCloseTo(0, 14);
  expect(result.counterfactual).toEqual(reviewTradeNav(data));
  expect(data).toEqual(before);
});

it("price differences survive real netAmount and cash anchors; no forked NAV", () => {
  const source = input([
    fill({ price: 110, amount: 110, netAmount: -110, balanceCash: 890 }),
    fill({
      kind: "sell",
      rowIndex: 2,
      price: 90,
      amount: 90,
      netAmount: 90,
      balanceCash: 980,
    }),
  ]);
  const result = reviewExecutionQuality(source);
  // Actual 980/1000-1=-2%; VWAP buy/sell cancels -> 0%; loss=-2%.
  expect(result.loss.value).toBeCloseTo(-0.02, 12);
  expect(result.segments).toEqual([
    {
      start: date,
      end: date,
      actualTwr: { value: 980 / 1000 - 1, reason: null },
      counterfactualTwr: { value: 0, reason: null },
      loss: { value: 980 / 1000 - 1, reason: null },
    },
  ]);
  expect(result.terminalDifference.value).toBeNull();
  expect(result.fallbackNote).toBeNull();
  expect(result.counterfactualNonPositiveDays).toBe(0);
  expect(result.counterfactualWorstNav).toEqual({ value: 1000, date });
  expect(result.counterfactual).toEqual(
    reviewTradeNav(
      input([
        fill({ netAmount: -100, balanceCash: 900 }),
        fill({ kind: "sell", rowIndex: 2, netAmount: 100, balanceCash: 1000 }),
      ]),
    ),
  );
  expect(result.summary.averageSlippageBp.value).toBeNull();
  expect(result.unitMismatchCount).toBe(2);
  expect(result.unitMismatches.map((r) => r.convertedBp)).toEqual([1000, 1000]);
});

it("translates only supplied pre-flow valuations by the accumulated execution difference", () => {
  const source = {
    ...input([
      fill({ price: 110, amount: 110, netAmount: -110, balanceCash: 890 }),
    ]),
    cashFlows: [
      {
        kind: "transferIn",
        rowIndex: 2,
        flowDate: date,
        flowTime: null,
        code: null,
        name: null,
        amount: 100,
        balanceCash: null,
        summary: "",
        fingerprintSource: "",
      } satisfies ParsedCashFlow,
    ],
    flowValuations: { 0: 990 },
  };
  const result = reviewExecutionQuality(source);
  expect(result.counterfactual?.twr.value).toBeCloseTo(0, 12);
  expect(result.loss.value).toBeCloseTo(-0.01, 12);
  const missing = reviewExecutionQuality({
    ...source,
    flowValuations: undefined,
  });
  expect(missing.loss.value).toBeNull();
  expect(missing.counterfactual?.twr.reasons[0]?.reason).toContain(
    "缺少出入金前账户估值",
  );
});

it("different segment boundaries never produce a loss number", () => {
  const result = reviewExecutionQuality({
    ...input([fill({ price: 110, amount: 110 })]),
    openingCash: 5,
  });
  expect(result.loss.value).toBeNull();
  expect(result.loss.reason).toContain("边界不一致");
  expect(result.terminalDifference.value).toBe(-10);
  expect(result.counterfactualNonPositiveDays).toBe(0);
  expect(result.fallbackNote).not.toContain("反事实净值出现非正值");
});

it("W11 rejects terminal money for negative and zero NAV without relaxing TWR boundaries", () => {
  const next = "2026-01-06";
  // Actual pays 90, VWAP pays 100: with opening 5 and closing mark 90,
  // actual NAV=5, counterfactual NAV=-5. Next mark 95 makes CF NAV exactly 0.
  const source = {
    ...input([fill({ price: 90, amount: 90 })], {
      sz000001: [bar({ close: 90 }), bar({ date: next, close: 95 })],
    }),
    openingCash: 5,
    tradingDays: [date, next],
  };
  const actual = reviewTradeNav(source);
  const saved = structuredClone(actual);
  const result = reviewExecutionQuality(source, actual);
  expect(actual).toEqual(saved);
  expect(reviewTradeNav(source)).toEqual(saved);
  expect(result.loss.value).toBeNull();
  expect(result.segments).toEqual([]);
  expect(result.terminalDifference.value).toBeNull();
  expect(result.terminalDifference.reason).toBe(result.fallbackNote);
  expect(result.counterfactualNonPositiveDays).toBe(2);
  expect(result.counterfactualWorstNav).toEqual({ value: -5, date });
  expect(result.fallbackNote).toBe(
    "反事实净值出现大幅非正值（最低 -5.00 元，日期 2026-01-05），期末差不可信，执行损耗在本账户上无法用当前反事实方法计算",
  );
  const missingEnd = reviewExecutionQuality({
    ...source,
    bars: { sz000001: [bar({ close: 90 })] },
  });
  expect(missingEnd.terminalDifference.value).toBeNull();
  expect(missingEnd.counterfactualNonPositiveDays).toBe(1);
  expect(missingEnd.counterfactualWorstNav).toEqual({ value: -5, date });
  const s = { ...snapshot(), execution: result };
  const data = pageExecutionQuality(s, { account: s.account, side: "sell" });
  expect(data.terminalDifference).toEqual(result.terminalDifference);
  expect(data.counterfactualNonPositiveDays).toBe(2);
  const table = {
    pagination: { pageIndex: 0, pageSize: 10 },
    sorting: [],
    onPaginationChange: () => {},
    onSortingChange: () => {},
  };
  const html = renderToStaticMarkup(
    createElement(ExecutionQualityResults, { data, table, groupTable: table }),
  );
  expect(html).toContain(result.fallbackNote!);
  expect(html).toContain("期末总资产差（元");
  expect(html).toContain("反事实收盘净值非正 2 天");
  expect(html).not.toContain("只反映成交价格好坏");
});

it("W11 rejects zero NAV even when both return boundaries match", () => {
  const result = reviewExecutionQuality({
    ...input([fill()], { sz000001: [bar({ close: 100 })] }),
    openingCash: 0,
  });
  expect(result.counterfactualNonPositiveDays).toBe(1);
  expect(result.counterfactualWorstNav).toEqual({ value: 0, date });
  expect(result.terminalDifference.value).toBeNull();
  expect(result.terminalDifference.reason).toContain("期末差不可信");
  expect(result.loss.value).toBeNull();
  expect(result.segments).toEqual([]);
});

it.runIf(
  process.env.W12_REAL_DATA === "1" || process.env.W11_REAL_DATA === "1",
)(
  "W12 real statement acceptance (supersedes contaminated W11 measurements)",
  async () => {
    const db = new Database(":memory:");
    try {
      migrate(db);
      const sourceHashes: Record<string, string> = {};
      for (const [name, scope] of [
        ["lishi", "all"],
        ["duizhang", "cashFlowsOnly"],
      ] as const) {
        const bytes = readFileSync(`.test-data/statements-v2/${name}20-26.xls`);
        sourceHashes[`${name}20-26.xls`] = createHash("sha256")
          .update(bytes)
          .digest("hex");
        commitDeliveryImport(
          bytes,
          {
            account: "w12",
            source: "generic",
            fileName: `${name}20-26.xls`,
            scope,
          },
          db,
        );
      }
      const root = "E:/new_tdx64";
      const tradingDays = (await readSnapshot(root, "sh000300", "day")).bars
        .map((b) => b.date)
        .filter((d) => d >= "2021-01-25");
      const s = await buildTradeReviewSnapshot(
        { account: "w12", tdxRoot: root, tradingDays, openingCash: 0 },
        db,
        { flowValuation: "previousClose", dimensions: { rps: {} } },
      );
      const e = s.execution;
      expect(s.trades.movingAverage.closedRounds).toHaveLength(785);
      expect(s.trades.movingAverage.statistics.winRate).toBe(399 / 784);
      expect(s.trades.movingAverage.statistics.payoffRatio).toBeCloseTo(
        0.8912012172774283,
        14,
      );
      expect(
        e.rows.filter(
          (r) =>
            r.slippageBp.value !== null && Math.abs(r.slippageBp.value) > 500,
        ),
      ).toEqual([]);
      expect(e.unitMismatchCount).toBe(e.unitMismatches.length);
      const samples = [
        ["123045", null, 10, 177.1, 175.4110710696259],
        ["588200", null, 100, 1.408, 1.403596],
        ["512100", "2026-04-08", 1, 3.132, 3.145676],
      ] as const;
      const { readTradeReviewSnapshot } =
        await import("../src/server/trade-review-market");
      const shBar = (await readTradeReviewSnapshot(root, "sh113050")).bars.find(
        (b) => b.date === "2025-07-14",
      );
      expect(shBar).toBeDefined();
      const shRow = executionRows(
        [
          fill({
            code: "113050",
            symbol: "sh113050",
            tradeDate: "2025-07-14",
            price: 144.967,
            amount: 1449.67,
          }),
        ],
        { sh113050: [shBar!] },
      )[0]!;
      expect(shRow.unitCheck.factor).toBe(10);
      expect(shRow.vwap.value).toBeCloseTo(145.4758102, 6);
      const measured = samples.map(([code, day, factor, close, vwap]) => {
        const row = e.rows.find(
          (r) =>
            r.code === code &&
            (!day || r.tradeDate === day) &&
            r.price.value === close,
        )!;
        expect(row).toBeDefined();
        expect(row.unitCheck.factor).toBe(factor);
        expect(row.unitCheck.ratio).toBeCloseTo(
          row.unitCheck.rawVwap! / close,
          10,
        );
        expect(row.vwap.value).toBeCloseTo(vwap, 5);
        return {
          date: row.tradeDate,
          code,
          price: row.price.value,
          ...row.unitCheck,
        };
      });
      expect(e.loss.value).toBeNull();
      expect(e.terminalDifference.value).toBeNull();
      const distribution = (rows: typeof e.rows) =>
        Object.fromEntries(
          [1, 10, 100, null].map((factor) => [
            String(factor),
            rows.filter((r) => r.unitCheck.factor === factor).length,
          ]),
        );
      const funds = e.rows.filter(
        (r) => classifyCode(r.code).instrument === "fund",
      );
      const measurements = {
        inputEvidence: {
          sourceHashes,
          openingCash: 0,
          flowValuation: "previousClose",
          algorithmVersion: "w12-section9-v1",
          generatedAt: new Date().toISOString(),
        },
        samples: [
          {
            code: "sh113050",
            date: "2025-07-14",
            price: 144.967,
            ...shRow.unitCheck,
          },
          ...measured,
        ],
        count: e.rows.length,
        rounds: s.trades.movingAverage.closedRounds.length,
        statistics: s.trades.movingAverage.statistics,
        summary: e.summary,
        fundSummary: summarizeExecution(funds),
        nonFundSummary: summarizeExecution(
          e.rows.filter((r) => classifyCode(r.code).instrument !== "fund"),
        ),
        distribution: distribution(e.rows),
        mismatchDistribution: distribution(
          e.rows.filter((r) => r.unitCheck.reason !== null),
        ),
        unitMismatchCount: e.unitMismatchCount,
        unitMismatches: e.unitMismatches,
        audit: auditExecutionRows(e.rows),
        missingVwap: e.missingVwap,
        counterfactualWorstNav: e.counterfactualWorstNav,
        counterfactualNonPositiveDays: e.counterfactualNonPositiveDays,
        loss: e.loss,
        terminalDifference: e.terminalDifference,
      };
      // Keep per-fill evidence in the explicitly requested local report only.
      console.log(
        "W12_MEASUREMENTS " +
          JSON.stringify({
            count: measurements.count,
            rounds: measurements.rounds,
            unitMismatchCount: measurements.unitMismatchCount,
            diagnosticCounts: e.summary.diagnosticCounts,
          }),
      );
      if (process.env.W12_REPORT_PATH)
        writeFileSync(
          process.env.W12_REPORT_PATH,
          JSON.stringify(measurements, null, 2),
        );
    } finally {
      db.close();
    }
  },
  120000,
);

it("missing fees and no trades remain unknown instead of fabricated zero totals", () => {
  const result = reviewExecutionQuality(
    input([
      fill({
        fees: {
          commission: null,
          stampTax: 0,
          transferFee: 0,
          otherFee: 0,
          total: null,
        },
      }),
    ]),
  );
  expect(result.summary.totalCost.value).toBeNull();
  expect(result.loss.value).toBeNull();
  expect(summarizeExecution([]).averageSlippageBp.value).toBeNull();
});

it("server filters, stable sorting, pages and grouped totals use the complete selection", () => {
  const s = snapshot(
    Array.from({ length: 103 }, (_, i) =>
      fill({
        rowIndex: i,
        price: i % 2 ? 101 : 100,
        amount: i % 2 ? 101 : 100,
      }),
    ),
  );
  const options = {
    account: s.account,
    pageSize: 10,
    sort: "slippageBp",
    desc: true,
    adverseOnly: true,
  };
  const first = pageExecutionQuality(s, options);
  const second = pageExecutionQuality(s, { ...options, pageIndex: 1 });
  expect(first.rowCount).toBe(51);
  expect(first.rows).toHaveLength(10);
  expect(first.rows.map((r) => r.fillIndex)).toEqual([
    1, 3, 5, 7, 9, 11, 13, 15, 17, 19,
  ]);
  expect(second.rows[0]?.fillIndex).toBe(21);
  expect(first.summary).toEqual(second.summary);
  expect(first.groups[0]?.count).toBe(51);
  expect(first.loss).toEqual(s.execution.loss);
  expect(pageExecutionQuality(s, { ...options, side: "sell" }).rowCount).toBe(
    0,
  );
  expect(
    pageExecutionQuality(s, { ...options, start: "2026-01-06" }).rowCount,
  ).toBe(0);
  expect(
    pageExecutionQuality(s, { ...options, end: "2026-01-04" }).rowCount,
  ).toBe(0);
  expect(
    pageExecutionQuality(s, { ...options, search: "无此标的" }).rowCount,
  ).toBe(0);
  expect(pageExecutionQuality(s, { ...options, minAmount: 102 }).rowCount).toBe(
    0,
  );
  expect(
    pageExecutionQuality(s, { ...options, group: "month" }).groups[0]?.id,
  ).toBe("2026-01");
  expect(
    pageExecutionQuality(s, { ...options, group: "kind" }).groups[0]?.id,
  ).toBe("buy");
  expect(() =>
    pageExecutionQuality(s, { ...options, pageSize: 101 }),
  ).toThrow();
  expect(
    exportExecutionQuality(s, { ...options, pageIndex: 99 }).split("\r\n"),
  ).toHaveLength(52);
});

it("CSV follows R2 import redaction and excludes account and raw identifiers", async () => {
  const db = new Database(":memory:");
  try {
    migrate(db);
    commitDeliveryImport(
      Buffer.from(
        "成交日期,资金账号,股东代码,证券代码,证券名称,操作,成交价格,成交数量,成交金额,发生金额\n20260105,12345678,A987654,000001,股东账号：B123456,买入,100,1,100,-100",
      ),
      {
        account: "private-account",
        source: "generic",
        fileName: "fixture.csv",
      },
      db,
    );
    const s = await buildTradeReviewSnapshot(
      { account: "private-account", tradingDays: [date], openingCash: 1000 },
      db,
      {
        dimensions: { rps: {} },
        readSnapshot: async (_root, symbol) => ({
          id: symbol,
          symbol,
          period: "day",
          source: "fixture",
          dataRoot: "fixture",
          adjustment: "none",
          createdAt: 0,
          hash: "fixture",
          bars: [bar()],
        }),
      },
    );
    const csv = exportExecutionQuality(s, { account: "private-account" });
    expect(csv).not.toMatch(
      /12345678|A987654|B123456|private-account|fingerprintSource|netAmount/,
    );
    expect(csv).toContain("000001");
    expect(csv).toContain("***");
    expect(csv).toContain("dayVwap");
  } finally {
    db.close();
  }
});

it("UI renders four cards, direction and only the server page", () => {
  const data = pageExecutionQuality(
    snapshot(Array.from({ length: 1000 }, () => fill())),
    { account: "private-account" },
  );
  const table = {
    pagination: { pageIndex: 0, pageSize: 10 },
    sorting: [],
    onPaginationChange: () => {},
    onSortingChange: () => {},
  };
  const html = renderToStaticMarkup(
    createElement(ExecutionQualityResults, { data, table, groupTable: table }),
  );
  expect(html).toContain("正 = 不利");
  expect(html).toContain("成交额加权");
  expect(html).toContain("实际 TWR − VWAP TWR");
  expect((html.match(/<tbody/g) ?? []).length).toBe(2);
  expect((html.match(/<tr/g) ?? []).length).toBe(13); // 10 fills + 1 group + 2 headers.
});

it.each([
  ["113050", 1449.67, 1454.758102, 144.967, 10, 10],
  ["123045", 1759.99, 1754.111, 177.1, 10, 1],
  ["588200", 1.408, 140.3596, 1.408, 100, 1],
  ["513180", 0.744, 74.1593, 0.744, 100, 1],
  ["123089", 153.77, 1521.391, 153.77, 10, 1],
  ["512100", 3.132, 3.145676, 3.132, 1, 1],
  ["512100", 2.209, 219.94701, 2.209, 100, 1],
])(
  "W12 identifies %s independently of close %s",
  (code, close, raw, price, factor, quantityFactor) => {
    const row = executionRows(
      [fill({ code, symbol: code, price, amount: price * quantityFactor })],
      { [code]: [bar({ close, amount: raw * 100 })] },
    )[0]!;
    expect(row.unitCheck.ratio).toBeCloseTo(raw / price, 10);
    expect(row.unitCheck.factor).toBe(factor);
    expect(row.vwap.value).toBeCloseTo(raw / factor, 10);
    expect(Math.abs(row.slippageBp.value!)).toBeLessThan(500);
  },
);

it("W12 excludes mismatches from both weighted terms, preserves fees and exports diagnostics", () => {
  const rows = executionRows(
    [
      fill({ price: 101, amount: 101 }),
      fill({ price: 110, amount: 10000 }),
      fill({ code: "999999", symbol: "999999" }),
    ],
    { sz000001: [bar()], "999999": [bar({ amount: 30000 })] },
  );
  const sum = summarizeExecution(rows);
  expect(sum.unitMismatchCount).toBe(2);
  expect(sum.slippageCount).toBe(1);
  expect(sum.slippageAmount.value).toBe(101);
  expect(sum.averageSlippageBp.value).toBeCloseTo(100, 12);
  expect(sum.fees.total.value).toBe(0);
  expect(sum.totalCost.value).toBeNull();
  expect(rows[1]!.unitCheck.convertedBp).toBe(1000);
  expect(rows[2]!.vwap.value).toBeNull();
  expect(rows[2]!.unitCheck.factor).toBeNull();
  const s = snapshot();
  s.execution.rows = rows;
  const csv = exportExecutionQuality(s, { account: s.account });
  expect(csv).toContain("换算后BP");
  expect(csv).toContain("单位无法识别");
});

it.each([
  0.8,
  1.25,
  8,
  12.5,
  80,
  125,
  3.1622776601683795,
  0.79,
  126,
  NaN,
  Infinity,
  0,
])("W12 ratio boundary %s", (ratio) => {
  const row = executionRows([fill()], {
    sz000001: [bar({ amount: ratio * 10000 })],
  })[0]!;
  const expected = [0.8, 1.25].includes(ratio)
    ? 1
    : [8, 12.5].includes(ratio)
      ? 10
      : [80, 125].includes(ratio)
        ? 100
        : null;
  expect(row.unitCheck.factor).toBe(expected);
});

it("P0-B distinguishes unavailable evidence from threshold exclusion and keeps both mean denominators explicit", () => {
  const rows = executionRows(
    [
      fill({ price: 101, amount: 101 }),
      fill({ price: 100, amount: 10000 }),
      fill({ price: 110, amount: 110 }),
      fill({ code: "000002", symbol: "sz000002", amount: 200 }),
      fill({ code: "000003", symbol: "sz000003", amount: 300 }),
      fill({ code: "123045", symbol: "sz123045", amount: 1 }),
      fill({ price: 0 }),
    ],
    {
      sz000001: [bar()],
      sz000003: [bar({ amount: 30000 })],
      sz123045: [bar()],
    },
  );
  expect(rows.map((row) => row.diagnostic.category)).toEqual([
    "valid",
    "valid",
    "thresholdExceeded",
    "benchmarkUnavailable",
    "unitUnidentified",
    "quantityUnverified",
    "priceInvalid",
  ]);
  const summary = summarizeExecution(rows);
  expect(summary.arithmeticMeanBp.value).toBe(50);
  expect(summary.validBpCount).toBe(2);
  expect(summary.weightedCount).toBe(2);
  expect(summary.weightedAmount.value).toBe(10101);
  expect(summary.excludedCount).toBe(5);
  expect(summary.excludedAmount.value).toBe(711);
  expect(summary.countCoverage.value).toBe(2 / 7);
  expect(summary.amountCoverage.value).toBe(10101 / 10812);
  // Existing strict aggregate still refuses a number when a required BP is missing.
  expect(summary.averageSlippageBp.value).toBeNull();
  const audit = auditExecutionRows(rows);
  expect(audit).toHaveLength(5);
  expect(audit[0]).toMatchObject({
    rootCause: "unresolved",
    factor: 1,
    convertedBp: 1000,
  });
  expect(JSON.stringify(audit)).not.toContain("private-account");
});

it("P0-B separates missing amount from valid BP and never invents coverage on empty input", () => {
  const rows = executionRows(
    [fill({ price: 101, amount: 0 }), fill()],
    input().bars,
  );
  const summary = summarizeExecution(rows);
  expect(summary.arithmeticMeanBp.value).toBe(50);
  expect(summary.validBpCount).toBe(2);
  expect(summary.weightedCount).toBe(1);
  expect(summary.countCoverage.value).toBe(1);
  expect(summary.amountCoverage.value).toBeNull();
  expect(summary.averageSlippageBp.value).toBeNull();
  expect(summary.excludedAmount.value).toBeNull();
  expect(summarizeExecution([]).countCoverage.value).toBeNull();
  expect(summarizeExecution([]).arithmeticMeanBp.value).toBeNull();
});

it("P0-B keeps the 500 BP policy boundary and does not remove threshold rows from counterfactual input", () => {
  const reviewed = reviewExecutionQuality(
    input([fill({ price: 105 }), fill({ price: 105.01 })]),
  );
  expect(reviewed.rows.map((row) => row.diagnostic.category)).toEqual([
    "valid",
    "thresholdExceeded",
  ]);
  expect(reviewed.rows[0]!.slippageBp.value).toBe(500);
  expect(reviewed.rows[1]!.slippageBp.value).toBeNull();
  expect(reviewed.rows[1]!.vwap.value).toBe(100);
  expect(reviewed.counterfactual).not.toBeNull();
  expect(reviewed.missingVwap).toEqual([]);
});

it("P0-B diagnostic filters share pagination, group and export scope without changing the account replay", () => {
  const s = snapshot([fill(), fill({ price: 110 }), fill({ price: 111 })]);
  const query = {
    account: s.account,
    diagnostic: "thresholdExceeded",
    pageSize: 1,
    pageIndex: 1,
  };
  const page = pageExecutionQuality(s, query);
  expect(page.rowCount).toBe(2);
  expect(page.rows).toHaveLength(1);
  expect(page.summary.count).toBe(2);
  expect(page.summary.diagnosticCounts.thresholdExceeded).toBe(2);
  expect(page.groups[0]!.count).toBe(2);
  expect(page.loss).toEqual(s.execution.loss);
  const csv = exportExecutionQuality(s, query);
  expect(csv.split("\r\n")).toHaveLength(3);
  expect(csv).toContain("thresholdExceeded");
  expect(csv).toContain("非实际节省费用");
});

it.each([0, NaN, 1.408, 140.8, 14080])(
  "W12 factor does not depend on close %s",
  (close) => {
    const row = executionRows([fill({ price: 1.408 })], {
      sz000001: [bar({ close, amount: 140.3596 * 100 })],
    })[0]!;
    expect(row.unitCheck.factor).toBe(100);
    expect(row.vwap.value).toBeCloseTo(1.403596, 10);
  },
);
