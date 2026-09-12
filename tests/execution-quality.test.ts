import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ParsedFill, ParsedCashFlow } from "../src/lib/delivery-import";
import type { Bar } from "../src/lib/domain";
import {
  executionRows,
  summarizeExecution,
  reviewExecutionQuality,
} from "../src/lib/execution-quality";
import { tradeReviewDayVwap } from "../src/lib/trade-review-vwap";
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
  expect(result.counterfactual).toEqual(
    reviewTradeNav(
      input([
        fill({ netAmount: -100, balanceCash: 900 }),
        fill({ kind: "sell", rowIndex: 2, netAmount: 100, balanceCash: 1000 }),
      ]),
    ),
  );
  expect(result.summary.averageSlippageBp.value).toBeCloseTo(1000);
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
});

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
