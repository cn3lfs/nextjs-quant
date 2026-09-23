import { expect, it } from "vitest";
import { canslimEarnings } from "../../../../src/lib/strategy-facts/canslim-earnings";
const point = (period: string, value: number | null) => ({
  period,
  value,
  field: `fixture[${period}]`,
  reasons: [],
});
it.each([
  [1.19, 0],
  [1.2, 3],
  [1.25, 6],
  [1.5, 8],
])("C1 at EPS %s has %s points", (value, expected) => {
  const result = canslimEarnings({
    quarterlyEps: [point("20260630", value!), point("20250630", 1)],
  });
  expect(result.checks[0]).toMatchObject({
    points: expected,
    status: "computed",
  });
});
it("CAGR uses actual year span and refuses omitted loss years", () => {
  const annualEps = [
    point("20251231", 1.25 ** 4),
    point("20241231", 2),
    point("20231231", 1.5),
    point("20221231", 1.2),
    point("20211231", 1),
  ];
  expect(canslimEarnings({ annualEps }).checks[1]).toMatchObject({
    points: 6,
    value: 25,
  });
  annualEps[2]!.value = -1;
  expect(canslimEarnings({ annualEps }).checks[1]).toMatchObject({
    points: 0,
    status: "conflict",
  });
  annualEps.splice(2, 1);
  expect(canslimEarnings({ annualEps }).checks[1]?.status).toBe("conflict");
});
it("does not fall back from missing latest EPS or compare cash across years", () => {
  const result = canslimEarnings({
    quarterlyEps: [
      point("20260630", null),
      point("20260331", 2),
      point("20250331", 1),
    ],
    annualEps: [point("20251231", 1)],
    annualCashPerShare: [point("20241231", 2)],
    annualWeightedRoe: [point("20251231", 30)],
  });
  expect(result.checks.every((c) => c.status === "missing")).toBe(true);
});
it.each([
  [0.69, 0],
  [0.7, 2],
  [1, 4],
  [1.2, 5],
])("cash coverage %s scores %s", (value, expected) => {
  expect(
    canslimEarnings({
      annualEps: [point("20251231", 1)],
      annualCashPerShare: [point("20251231", value!)],
    }).checks[3]?.points,
  ).toBe(expected);
});

it.each([
  [[40, 30, 20], 7],
  [[30, 20], 5],
  [[19, 10], 3],
  [[60, 80], 3],
  [[20, 24], 3],
  [[20, 25], 0],
] as [number[], number][])("C2 series %j scores %s", (values, expected) => {
  const dates = ["20260630", "20260331", "20251231"];
  const series = values.map((value, i) => point(dates[i]!, value));
  expect(
    canslimEarnings({ quarterlyEpsGrowth: series }).checks.find(
      (c) => c.id === "C2",
    )?.points,
  ).toBe(expected);
});
it("C2 cannot bridge a missing quarter or an invalid latest value", () => {
  for (const values of [
    [point("20260630", 40), point("20251231", 20)],
    [point("20260630", null), point("20260331", 20)],
  ]) {
    expect(
      canslimEarnings({ quarterlyEpsGrowth: values }).checks.find(
        (c) => c.id === "C2",
      )?.status,
    ).toBe("missing");
  }
});
it.each([
  [30, -1, 4],
  [20, -1, 3],
  [10, -1, 1],
  [5, -1, 0],
  [-5, 10, 0],
  [30, 0, 5],
])("C3 revenue %s/profit %s scores %s", (revenue, profit, expected) => {
  expect(
    canslimEarnings({
      quarterlyRevenueGrowth: [point("20260630", revenue)],
      quarterlyProfitGrowth: [point("20260630", profit)],
    }).checks.find((c) => c.id === "C3")?.points,
  ).toBe(expected);
});
it("C3 requires profit quality evidence for the same quarter", () => {
  expect(
    canslimEarnings({
      quarterlyRevenueGrowth: [point("20260630", 30)],
      quarterlyProfitGrowth: [point("20260331", 10)],
    }).checks.find((c) => c.id === "C3")?.status,
  ).toBe("missing");
});
