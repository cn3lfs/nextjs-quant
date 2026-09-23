import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import {
  importDeliveryTable,
  type ParsedFill,
  type ParsedCashFlow,
} from "../../src/lib/research/evidence/delivery-import";
import { parseDeliveryTable } from "../../src/lib/research/evidence/delivery-table";
import { reviewTrades } from "../../src/lib/portfolio/trade-review";
import {
  reviewTradeNav,
  type TradeReviewNavInput,
} from "../../src/lib/portfolio/trade-review-nav";
import * as ordering from "../../src/lib/portfolio/trade-review-intraday-order";

const date = "2025-01-02";
const fill = (amount: number, extra: Partial<ParsedFill> = {}): ParsedFill => ({
  kind: amount < 0 ? "buy" : "sell",
  rowIndex: 0,
  tradeDate: date,
  tradeTime: "10:00:00",
  code: "000001",
  symbol: "sz000001",
  instrument: "stock",
  name: null,
  price: Math.abs(amount),
  quantity: 1,
  amount: Math.abs(amount),
  fees: { commission: 0, stampTax: 0, transferFee: 0, otherFee: 0, total: 0 },
  netAmount: amount,
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
const repo = (amount: number, extra: Partial<ParsedFill> = {}) =>
  fill(amount, {
    instrument: "reverseRepo",
    code: "131810",
    symbol: null,
    kind: amount < 0 ? "sell" : "buy",
    ...extra,
  });
const flow = (
  amount: number,
  kind: ParsedCashFlow["kind"] = "cashManagement",
): ParsedCashFlow => ({
  kind,
  rowIndex: 0,
  flowDate: date,
  flowTime: "10:00:00",
  code: null,
  name: null,
  amount,
  balanceCash: null,
  summary: "",
  fingerprintSource: "",
});
const input = (
  fills: ParsedFill[],
  cashFlows: ParsedCashFlow[] = [],
): TradeReviewNavInput => ({
  fills,
  cashFlows,
  tradingDays: ["2025-01-01", date, "2025-01-03"],
  openingCash: 50,
  bars: {},
});
function originalReplay(data: TradeReviewNavInput) {
  const spy = vi
    .spyOn(ordering, "orderTradeReviewIntraday")
    .mockImplementation((events) => [...events]);
  try {
    return reviewTradeNav(data);
  } finally {
    spy.mockRestore();
  }
}

it("moves repayment before lending: opening 50, +100 -100 -50 = 0", () => {
  const data = input([repo(-100), repo(100), fill(-50)]);
  const before = originalReplay(data);
  const after = reviewTradeNav(data);
  expect(before.replay.map((e) => e.cash)).toEqual([-50, 50, 0]);
  expect(after.replay.map((e) => e.cash)).toEqual([150, 50, 0]);
  expect(after.minimumCash.value).toBe(0);
  expect(after.days.map((d) => d.cash)).toEqual(before.days.map((d) => d.cash));
  expect(
    after.warnings.some((w) => w.includes("同日内逆回购与现金管理流入已提前")),
  ).toBe(true);
});

it.each([false, true])(
  "preserves each round, realization and cost for sellFirst=%s",
  (sellFirst) => {
    const ordinary = sellFirst ? [fill(20), fill(-30)] : [fill(-30), fill(20)];
    const data = input(
      [
        fill(-10, { tradeDate: "2025-01-01" }),
        repo(-100),
        ...ordinary,
        repo(100),
        fill(40, { tradeDate: "2025-01-03" }),
      ],
      [flow(-5), flow(5)],
    );
    const immutable = structuredClone(data);
    const before = reviewTrades({
      fills: data.fills,
      cashFlows: data.cashFlows,
    });
    const baseline = originalReplay(data);
    const after = reviewTradeNav(data);
    const ordinaryOrders = (nav: typeof after) =>
      nav.replay
        .filter(
          (e) =>
            e.originalOrder < data.fills.length &&
            data.fills[e.originalOrder]!.instrument !== "reverseRepo",
        )
        .map((e) => e.originalOrder);
    expect(ordinaryOrders(after)).toEqual(ordinaryOrders(baseline));
    // Replay the actual resulting ordinary subsequence through both cost methods.
    const beforePairs = reviewTrades({
      fills: ordinaryOrders(baseline).map((i) => data.fills[i]!),
    });
    const afterPairs = reviewTrades({
      fills: ordinaryOrders(after).map((i) => data.fills[i]!),
    });
    expect(afterPairs.movingAverage).toEqual(beforePairs.movingAverage);
    expect(afterPairs.fifo).toEqual(beforePairs.fifo);
    expect(beforePairs.movingAverage.closedRounds).toHaveLength(
      sellFirst ? 2 : 1,
    );
    expect(
      reviewTrades({ fills: data.fills, cashFlows: data.cashFlows }),
    ).toEqual(before);
    expect(data).toEqual(immutable);
    expect(after.days.map((d) => d.cash)).toEqual(
      baseline.days.map((d) => d.cash),
    );
    expect(after.replay.map((e) => e.date)).toEqual(
      baseline.replay.map((e) => e.date),
    );
  },
);

it("keeps transfers, ordinary sales and other inflows in relative order", () => {
  const data = input(
    [repo(-100), fill(20), repo(100)],
    [
      flow(10, "transferIn"),
      flow(-5, "transferOut"),
      flow(5),
      flow(2, "interest"),
      flow(-3),
    ],
  );
  expect(reviewTradeNav(data).replay.map((e) => e.originalOrder)).toEqual([
    2, 5, 0, 1, 3, 4, 6, 7,
  ]);
  expect(
    reviewTradeNav(
      input([], [flow(50, "transferIn"), flow(-100), flow(100)]),
    ).replay.map((e) => e.originalOrder),
  ).toEqual([0, 2, 1]);
});

it.each([null, 0, NaN, Infinity, -Infinity])(
  "never promotes unknown or nonpositive repo cash %s",
  (amount) => {
    const data = input([fill(-50), repo(100, { netAmount: amount })]);
    expect(reviewTradeNav(data).replay.map((e) => e.originalOrder)).toEqual([
      0, 1,
    ]);
  },
);

it("refuses to silently reuse absolute statement balances on a reordered path", () => {
  const data = input([
    repo(-100, { balanceCash: -50 }),
    repo(100, { balanceCash: 50 }),
  ]);
  expect(() => reviewTradeNav(data)).toThrow("柜台资金余额锚点");
});

it.runIf(process.env.W10_REAL_DATA === "1")(
  "measures all four real-data acceptance criteria",
  () => {
    const parse = (name: string, scope: "all" | "cashFlowsOnly") =>
      importDeliveryTable(
        parseDeliveryTable(
          readFileSync(`.test-data/statements-v2/${name}20-26.xls`),
        ),
        { scope },
      );
    const data: TradeReviewNavInput = {
      fills: parse("lishi", "all").fills,
      cashFlows: parse("duizhang", "cashFlowsOnly").cashFlows,
      tradingDays: [],
      openingCash: 0,
      bars: {},
    };
    data.tradingDays = [
      ...new Set([
        ...data.fills.map((f) => f.tradeDate),
        ...data.cashFlows.map((f) => f.flowDate),
      ]),
    ].sort();
    const saved = structuredClone(data);
    const before = originalReplay(data);
    const reviewBefore = reviewTrades({
      fills: data.fills,
      cashFlows: data.cashFlows,
    });
    const after = reviewTradeNav(data);
    const reviewAfter = reviewTrades({
      fills: data.fills,
      cashFlows: data.cashFlows,
    });
    expect(data).toEqual(saved);
    expect(reviewAfter).toEqual(reviewBefore);
    expect(reviewAfter.movingAverage.closedRounds).toHaveLength(785);
    expect(reviewAfter.movingAverage.statistics.winRate).toBe(399 / 784);
    expect(reviewAfter.movingAverage.statistics.payoffRatio).toBeCloseTo(
      0.8912012172774283,
      14,
    );
    expect(after.days.map((d) => [d.date, d.cash])).toEqual(
      before.days.map((d) => [d.date, d.cash]),
    );
    expect(before.minimumCash.value).toBeCloseTo(-126036.55, 2);
    expect(after.minimumCash.value).toBeCloseTo(-9007.25, 2);
    expect(after.minimumDate).toBe("2021-08-25");
    const summary = ["transferIn", "transferOut", "cashManagement"].map(
      (kind) => {
        const rows = after.replay
          .filter((e) => e.originalOrder >= data.fills.length)
          .map((e) => data.cashFlows[e.originalOrder - data.fills.length]!)
          .filter((f) => f.kind === kind);
        const original = saved.cashFlows.filter((f) => f.kind === kind);
        expect(rows).toHaveLength(original.length);
        const cents = (xs: typeof rows) =>
          xs.reduce((s, f) => s + Math.round(f.amount * 100), 0);
        expect(cents(rows)).toBe(cents(original));
        return { kind, count: rows.length, amount: cents(rows) / 100 };
      },
    );
    expect(summary).toEqual([
      { kind: "transferIn", count: 64, amount: 1017222.79 },
      { kind: "transferOut", count: 30, amount: -788997.34 },
      { kind: "cashManagement", count: 48, amount: 114.13 },
    ]);
    console.log(
      JSON.stringify({
        before: before.lowestKnownCash,
        after: after.lowestKnownCash,
        days: after.days.length,
        negativeEndDays: after.days.filter((d) => d.cash.value! < -0.005)
          .length,
        minimumEnd: Math.min(...after.days.map((d) => d.cash.value!)),
        maximumFloatDifference: Math.max(
          ...after.days.map((d, i) =>
            Math.abs(d.cash.value! - before.days[i]!.cash.value!),
          ),
        ),
        rounds: reviewAfter.movingAverage.closedRounds.length,
        statistics: reviewAfter.movingAverage.statistics,
        summary,
      }),
    );
  },
);
