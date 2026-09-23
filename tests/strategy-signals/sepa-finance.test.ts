import { expect, it } from "vitest";
import { sepaFinanceFacts } from "../../src/lib/strategy-facts/sepa-finance";
const row: Record<string, unknown> = {
  "单季度_营业收入同比增长率[20260331]": 20,
  "单季度_营业收入同比增长率[20251231]": 21,
  "单季度_归母净利润同比增长率[20260331]": 25,
  "单季度_归母净利润同比增长率[20251231]": 26,
  "单季度_归母净利润[20260331]": 15,
  "单季度_归母净利润[20250331]": 14,
  "单季度_营业收入[20260331]": 100,
  "单季度_营业收入[20250331]": 100,
  "加权净资产收益率[20251231]": 17,
};
const columns = Object.keys(row).map((key) => ({
  key,
  unit: /同比|收益率/.test(key) ? "%" : "元",
  timestamp: key.match(/\[(\d+)\]/)![1],
}));
it("aligns consecutive quarters across years and compares margin to the same quarter last year", () => {
  const facts = sepaFinanceFacts(row, columns);
  expect(facts.previousQuarter).toBe("20251231");
  expect(Object.values(facts.strictChecks)).toEqual([true, true, true, true]);
  expect(
    sepaFinanceFacts({ ...row, "单季度_归母净利润[20250331]": 15 }, columns)
      .strictChecks.margin15AndImproving,
  ).toBe(false);
});
it("requires two strict passes, enforces exact tolerance floors and retains improvement", () => {
  expect(sepaFinanceFacts(row, columns).gate).toBe("strict-pass");
  const borderline = {
    ...row,
    "单季度_营业收入同比增长率[20260331]": 16,
    "加权净资产收益率[20251231]": 13.6,
  };
  expect(sepaFinanceFacts(borderline, columns).gate).toBe("tolerant-pass");
  expect(
    sepaFinanceFacts(
      { ...borderline, "加权净资产收益率[20251231]": 13.599 },
      columns,
    ).gate,
  ).toBe("failed");
  expect(
    sepaFinanceFacts(
      { ...borderline, "单季度_归母净利润同比增长率[20260331]": 20 },
      columns,
    ).gate,
  ).toBe("failed");
  expect(
    sepaFinanceFacts({ ...row, "单季度_归母净利润[20260331]": 14 }, columns)
      .gate,
  ).toBe("failed");
  expect(
    sepaFinanceFacts({ ...row, "单季度_营业收入[20260331]": 0 }, columns).gate,
  ).toBe("incomplete");
  expect(
    sepaFinanceFacts(
      { ...row, "单季度_归母净利润同比增长率[20260331]": null },
      columns,
    ).gate,
  ).toBe("incomplete");
});
it("does not replace missing quarters with older values, zero, or cumulative growth", () => {
  const changed = {
    ...row,
    "单季度_归母净利润同比增长率[20251231]": null,
    "归母净利润同比增长率[20251231]": 100,
  };
  expect(
    sepaFinanceFacts(changed, columns).strictChecks.profitGrowthTwoQuarters25,
  ).toBeNull();
  expect(
    sepaFinanceFacts(
      { ...row, "单季度_归母净利润同比增长率[20260331]": -1 },
      columns,
    ).strictChecks.profitGrowthTwoQuarters25,
  ).toBe(false);
  expect(
    sepaFinanceFacts(
      row,
      columns.map((c) => ({ ...c, unit: "元" })),
    ).strictChecks.revenueGrowthTwoQuarters20,
  ).toBeNull();
});
