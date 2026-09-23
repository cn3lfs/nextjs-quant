import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseDeliveryTable } from "../../src/lib/research/evidence/delivery-table";
import { importDeliveryTable } from "../../src/lib/research/evidence/delivery-import";
import { reviewTrades, type ReviewRound } from "../../src/lib/portfolio/trade-review";
import { reviewAttribution } from "../../src/lib/portfolio/trade-review-attribution";

const parsed = importDeliveryTable(
  parseDeliveryTable(
    readFileSync("tests/fixtures/delivery/ths-statement.html"),
  ),
);
const base = reviewTrades(parsed).movingAverage.closedRounds[0]!;
const round = (profit: number, days = 1): ReviewRound => ({
  ...base,
  netProfit: { value: profit, reason: null },
  netReturn: { value: profit / 100, reason: null },
  holdingTradingDays: { value: days, reason: null },
});
const group = (
  result: ReturnType<typeof reviewAttribution>,
  dimension: string,
) => result.groups.find((g) => g.dimension === dimension)!;

it("hand calculated core statistics, small samples retain details; threshold uses valid rounds", () => {
  const r = reviewAttribution([round(20), round(-10), round(0)]);
  const item = group(r, "security").items[0]!;
  // Gains 20 / losses 10 = 2; net 10; returns (0.2 - 0.1 + 0)/3.
  expect(item.netProfitTotal).toBe(10);
  expect(item.statistics.profitFactor.value).toBe(2);
  expect(item.statistics.winRate).toBeCloseTo(1 / 3);
  expect(item.sampleCount).toBe(3);
  expect(item.warning).toBe("样本不足，不稳定");
  expect(item.rounds).toHaveLength(3);
  expect(
    group(
      reviewAttribution(Array.from({ length: 5 }, () => round(1))),
      "security",
    ).items[0]!.warning,
  ).toBeNull();
  const unknown = {
    ...base,
    openingUnknown: true,
    netProfit: { value: null, reason: "未知" },
    netReturn: { value: null, reason: "未知" },
  };
  expect(
    group(reviewAttribution([unknown]), "security").items[0],
  ).toMatchObject({
    sampleCount: 0,
    netProfitTotal: null,
    warning: "样本不足，不稳定",
  });
});

it("missing dimensions stay unknown and overlapping concepts deduplicate within each group", () => {
  const result = reviewAttribution([base], {
    concepts: { [base.security]: ["A", "B", "A"] },
  });
  for (const dimension of ["rps", "industry", "position"])
    expect(group(result, dimension).items[0]!.name).toBe("未知");
  expect(group(result, "concept")).toMatchObject({
    overlapping: true,
    sampleNote: "样本可重叠，组间不可相加或当作独立样本",
  });
  expect(group(result, "concept").items.map((g) => g.roundIndices)).toEqual([
    [0],
    [0],
  ]);
  expect(result.description).toContain("不等同因子分析");
});

it.each([
  [0, "0 日（当日）"],
  [1, "1 日"],
  [2, "2-5 日"],
  [5, "2-5 日"],
  [6, "6-20 日"],
  [20, "6-20 日"],
  [21, "21-60 日"],
  [60, "21-60 日"],
  [61, "60 日以上"],
  [-1, "未知"],
])("holding boundary %s", (days, label) => {
  expect(
    group(reviewAttribution([round(1, days as number)]), "holdingPeriod")
      .items[0]!.name,
  ).toBe(label);
});
it.each([
  [0, "<70"],
  [69.99, "<70"],
  [70, "70-90"],
  [89.99, "70-90"],
  [90, "≥90"],
  [100, "≥90"],
  [101, "未知"],
  [null, "未知"],
])("RPS boundary %s", (n, label) => {
  const result = reviewAttribution([base], {
    rps: { [base.security]: { [base.openingDate!]: n as number | null } },
  });
  expect(group(result, "rps").items[0]!.name).toBe(label);
});
it.each([
  [0, "<10%"],
  [0.099, "<10%"],
  [0.1, "10%-25%"],
  [0.249, "10%-25%"],
  [0.25, "25%-50%"],
  [0.499, "25%-50%"],
  [0.5, "≥50%"],
  [1, "≥50%"],
  [1.1, "未知"],
])("position boundary %s", (n, label) => {
  expect(
    group(
      reviewAttribution([base], { positionFractions: { 0: n as number } }),
      "position",
    ).items[0]!.name,
  ).toBe(label);
});
it("weekday, instruments and cost-method isolation", () => {
  expect(group(reviewAttribution([base]), "weekday").items[0]!.name).toBe(
    "星期一",
  );
  for (const [instrument, label] of [
    ["stock", "股票"],
    ["fund", "ETF"],
    ["convertible", "可转债"],
  ] as const)
    expect(
      group(reviewAttribution([{ ...base, instrument }]), "instrument")
        .items[0]!.name,
    ).toBe(label);
  expect(() =>
    reviewAttribution([base, { ...base, costMethod: "fifo" }]),
  ).toThrow("不同成本口径");
});
