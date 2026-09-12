import { expect, it } from "vitest";
import type { ParsedFill } from "../src/lib/delivery-import";
import { reviewTrades, type ReviewRound } from "../src/lib/trade-review";
import { keyTrades } from "../src/lib/key-trades";
const fill = (
  kind: "buy" | "sell",
  date: string,
  price: number,
  quantity: number,
  fee: number | null = 1,
  extra: Partial<ParsedFill> = {},
): ParsedFill => ({
  kind,
  tradeDate: date,
  tradeTime: null,
  rowIndex: 0,
  code: "000001",
  symbol: "sz000001",
  instrument: "stock",
  name: null,
  price,
  quantity,
  amount: price * quantity,
  fees: {
    commission: fee,
    stampTax: 0,
    transferFee: 0,
    otherFee: 0,
    total: fee,
  },
  netAmount:
    fee === null
      ? null
      : kind === "buy"
        ? -price * quantity - fee
        : price * quantity - fee,
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

function round(
  security: string,
  quantity: number,
  exitPrice: number,
): ReviewRound {
  return {
    ...reviewTrades({
      fills: [
        fill("buy", "2025-12-31", 10, quantity, 0),
        fill("sell", "2026-01-05", exitPrice, quantity, 0),
      ],
    }).movingAverage.closedRounds[0]!,
    security,
  };
}
it("跨年按平仓年，金额与收益率榜第一名不同", () => {
  // 小仓 10 * (20-10) = 100 元 / 100%；大仓 1000 * (10.5-10) = 500 元 / 5%。
  const small = round("small", 10, 20),
    large = round("large", 1000, 10.5);
  const result = keyTrades([small, large], 1);
  expect(result.years.map((y) => y.year)).toEqual(["2026"]);
  expect(result.years[0]!.amount.highest.map((r) => r.security)).toEqual([
    "large",
  ]);
  expect(result.years[0]!.returnRate.highest.map((r) => r.security)).toEqual([
    "small",
  ]);
  expect(result.years[0]!.amount.lowest[0]!.security).toBe("small");
  expect(result.years[0]!.returnRate.lowest[0]!.security).toBe("large");
  expect(small.netProfit.value).toBe(100);
  expect(large.netProfit.value).toBe(500);
});
it("未平仓优先单独计数，缺任一指标排除并保留原因", () => {
  const valid = round("valid", 10, 11);
  const result = keyTrades([
    valid,
    {
      ...valid,
      closingDate: null,
      netProfit: { value: null, reason: "未平仓" },
    },
    { ...valid, netProfit: { value: null, reason: "费用缺失" } },
    { ...valid, netReturn: { value: null, reason: "成本未知" } },
  ]);
  expect(result.openCount).toBe(1);
  expect(result.missingCount).toBe(2);
  expect(result.missingReasons).toEqual([
    { reason: "净收益金额：费用缺失", count: 1 },
    { reason: "净收益率：成本未知", count: 1 },
  ]);
  expect(result.years[0]!.count).toBe(1);
});
it("默认 N=3 不补行；空输入与非法 N", () => {
  const result = keyTrades([round("only", 10, 11)]);
  expect(result.n).toBe(3);
  for (const ranking of [
    result.years[0]!.amount,
    result.years[0]!.returnRate,
  ]) {
    expect(ranking.highest).toHaveLength(1);
    expect(ranking.lowest).toHaveLength(1);
  }
  expect(keyTrades([]).years).toEqual([]);
  for (const n of [0, 1.5, 21, NaN])
    expect(() => keyTrades([], n)).toThrow("N 必须");
});
it("部分成交本来就只生成一个回合，同日独立回合不再合并", () => {
  const fills = [
    fill("buy", "2026-01-05", 10, 100, 0),
    fill("sell", "2026-01-06", 11, 40, 0),
    fill("sell", "2026-01-07", 12, 60, 0),
  ];
  for (const method of ["movingAverage", "fifo"] as const) {
    const rounds = reviewTrades({ fills })[method].closedRounds;
    expect(rounds).toHaveLength(1);
    expect(rounds[0]!.realizations).toHaveLength(2);
    expect(keyTrades(rounds).years[0]!.amount.highest[0]!.netProfit.value).toBe(
      160,
    );
  }
  const sameDay = reviewTrades({
    fills: [
      fill("buy", "2026-01-05", 10, 10, 0),
      fill("sell", "2026-01-05", 11, 10, 0),
      fill("buy", "2026-01-05", 10, 20, 0),
      fill("sell", "2026-01-05", 12, 20, 0),
    ],
  }).movingAverage.closedRounds;
  expect(sameDay).toHaveLength(2);
  expect(
    keyTrades(sameDay).years[0]!.amount.highest.map((r) => r.netProfit.value),
  ).toEqual([40, 10]);
});
it("头尾保留零值与负值、年份倒序、同值稳定且不修改输入", () => {
  const rounds = [
    round("zero", 10, 10),
    round("loss", 10, 9),
    round("tie", 10, 10),
    { ...round("old", 10, 11), closingDate: "2025-12-31" },
  ];
  const before = structuredClone(rounds);
  const result = keyTrades(rounds, 2);
  expect(result.years.map((y) => y.year)).toEqual(["2026", "2025"]);
  expect(result.years[0]!.amount.highest.map((r) => r.security)).toEqual([
    "zero",
    "tie",
  ]);
  expect(result.years[0]!.amount.lowest.map((r) => r.security)).toEqual([
    "loss",
    "zero",
  ]);
  expect(rounds).toEqual(before);
});
