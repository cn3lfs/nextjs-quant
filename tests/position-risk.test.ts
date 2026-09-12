import { expect, it } from "vitest";
import type { ParsedFill } from "../src/lib/delivery-import";
import { reviewTradeNav, type NavDay } from "../src/lib/trade-review-nav";
import {
  positionRisk,
  positionRiskMetrics,
  positionRiskCurveSegments,
} from "../src/lib/position-risk";
const d = (n: number) => `2026-01-${String(n).padStart(2, "0")}`;
const fill = (
  date: string,
  kind: "buy" | "sell",
  price: number,
  quantity = 1,
  extra: Partial<ParsedFill> = {},
): ParsedFill => ({
  kind,
  rowIndex: 0,
  tradeDate: date,
  tradeTime: "10:00:00",
  code: "000001",
  symbol: "sz000001",
  instrument: "stock",
  name: null,
  price,
  quantity,
  amount: price * quantity,
  fees: { commission: 0, stampTax: 0, transferFee: 0, otherFee: 0, total: 0 },
  netAmount: (kind === "buy" ? -1 : 1) * price * quantity,
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

const valued = (amounts: number[], nav = 100): NavDay => ({
  date: d(1),
  cash: { value: nav - amounts.reduce((a, b) => a + b, 0), reason: null },
  positions: Object.fromEntries(amounts.map((_, i) => [String(i), 1])),
  positionValues: Object.fromEntries(
    amounts.map((value, i) => [String(i), { value, reason: null }]),
  ),
  marketValue: { value: amounts.reduce((a, b) => a + b, 0), reason: null },
  reverseRepoPrincipal: { value: 0, reason: null },
  nav: { value: nav, reason: null },
  dailyReturn: { value: 0, reason: null },
});
it("三标的手算全部指标，两个等权与单只锚点", () => {
  // 市值 10/20/30，总资产100：敞口.6、最大.3、HHI=.01+.04+.09=.14；持仓HHI=(1+4+9)/36=14/36，等效36/14。
  const row = positionRisk([valued([10, 20, 30])])[0]!;
  for (const [key, expected] of Object.entries({
    grossExposure: 0.6,
    maxSingleWeight: 0.3,
    herfindahl: 0.14,
    herfindahlInvested: 14 / 36,
    effectivePositions: 36 / 14,
  }))
    expect(
      row[key as (typeof positionRiskMetrics)[number][0]].value,
    ).toBeCloseTo(expected, 14);
  expect(row.positionCount).toBe(3);
  for (const n of [1, 8]) {
    const p = positionRisk([valued(Array(n).fill(100 / n))])[0]!;
    expect(p.herfindahl.value).toBe(1 / n);
    expect(p.herfindahlInvested.value).toBe(1 / n);
    expect(p.effectivePositions.value).toBe(n);
  }
});
it("90%现金不掩盖已投资部分的单一集中", () => {
  const p = positionRisk([valued([10])])[0]!;
  expect(p.herfindahl.value).toBeCloseTo(0.01, 15);
  expect(p.herfindahlInvested.value).toBe(1);
  expect(p.effectivePositions.value).toBe(1);
});
it("真实净值入口的未到期逆回购只进分母且到期保持本金路径", () => {
  const result = reviewTradeNav({
    openingCash: 2000,
    cashFlows: [],
    tradingDays: [d(1), d(2)],
    fills: [
      fill(d(1), "buy", 100),
      fill(d(1), "sell", 1, 1, {
        code: "204001",
        symbol: "sh204001",
        instrument: "reverseRepo",
        netAmount: -1000,
      }),
      fill(d(2), "sell", 1, 1, {
        code: "204001",
        symbol: "sh204001",
        instrument: "reverseRepo",
        netAmount: 1001,
      }),
    ],
    bars: {
      sz000001: [
        { date: d(1), close: 100 },
        { date: d(2), close: 110 },
      ],
    },
  });
  expect(
    result.days.map((p) => [
      p.marketValue.value,
      p.nav.value,
      p.reverseRepoPrincipal.value,
    ]),
  ).toEqual([
    [100, 2000, 1000],
    [110, 2011, 0],
  ]);
  expect(result.days[0]!.positionValues).toEqual({
    sz000001: { value: 100, reason: null },
  });
  const p = positionRisk(result.days)[0]!;
  expect(p.positionCount).toBe(1);
  expect(p.grossExposure.value).toBe(0.05);
  expect(p.herfindahl.value).toBeCloseTo(0.0025, 15);
  expect(p.herfindahlInvested.value).toBe(1);
});
it("任一缺行情则整体空，不能拿其余标的估算", () => {
  const result = reviewTradeNav({
    openingCash: 100,
    cashFlows: [],
    tradingDays: [d(1), d(2)],
    fills: [
      fill(d(1), "buy", 10),
      fill(d(1), "buy", 20, 1, { code: "000002", symbol: "sz000002" }),
    ],
    bars: {
      sz000001: [
        { date: d(1), close: 10 },
        { date: d(2), close: 11 },
      ],
      sz000002: [{ date: d(2), close: 21 }],
    },
  });
  expect(result.days[0]!.positionValues.sz000002!.value).toBeNull();
  expect(result.days[0]!.positionValues.sz000002!.reason).toContain("sz000002");
  const rows = positionRisk(result.days);
  for (const [key] of positionRiskMetrics) {
    expect(rows[0]![key].value).toBeNull();
    expect(rows[0]![key].reason).toContain("sz000002");
    expect(rows[1]![key].value).not.toBeNull();
  }
  expect(rows[0]!.positionCount).toBe(2);
});
it("空仓、非正净值、缺现金与未知股份都不补零", () => {
  const empty = positionRisk([valued([])])[0]!;
  expect(empty.positionCount).toBe(0);
  for (const [key] of positionRiskMetrics)
    expect(empty[key]).toEqual({ value: null, reason: "空仓日，集中度无定义" });
  for (const nav of [0, -1, NaN])
    for (const [key] of positionRiskMetrics)
      expect(positionRisk([valued([10], nav)])[0]![key].value).toBeNull();
  const day = valued([10]);
  day.nav = { value: null, reason: "现金流水不完整" };
  expect(positionRisk([day])[0]!.effectivePositions).toEqual({
    value: null,
    reason: "现金流水不完整",
  });
  day.nav = { value: 100, reason: null };
  day.positionValues["0"] = { value: null, reason: "股份未知" };
  for (const [key] of positionRiskMetrics)
    expect(positionRisk([day])[0]![key]).toEqual({
      value: null,
      reason: "股份未知",
    });
});
it("曲线首尾与内部缺口不桥接", () => {
  const points = [null, 1, null, 2, 3, null].map((value, i) => ({
    date: d(i + 1),
    effectivePositions: value,
    maxSingleWeight: value,
  }));
  for (const key of ["effectivePositions", "maxSingleWeight"] as const)
    expect(positionRiskCurveSegments(points, key)).toEqual([
      [{ date: d(2), value: 1 }],
      [
        { date: d(4), value: 2 },
        { date: d(5), value: 3 },
      ],
    ]);
});
