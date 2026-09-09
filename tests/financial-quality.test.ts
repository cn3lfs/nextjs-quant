import { expect, it } from "vitest";
import { financeEvidence } from "~/server/hithink-finance";
import { financialQuality } from "~/server/financial-quality";
function fixture(unit = "人民币元") {
  const years: Record<string, Record<string, number>> = {
    "20231231": { 资产总计: 100, 所有者权益合计: 50 },
    "20241231": {
      资产总计: 120,
      所有者权益合计: 60,
      营业收入: 100,
      营业成本: 60,
      净利润: 10,
      经营活动产生的现金流量净额: 12,
      流动资产合计: 60,
      流动负债合计: 30,
    },
    "20251231": {
      资产总计: 140,
      所有者权益合计: 70,
      营业收入: 150,
      营业成本: 80,
      归属于母公司所有者的净利润: 18,
      少数股东损益: 2,
      经营活动产生的现金流量净额: 25,
      流动资产合计: 90,
      流动负债合计: 30,
    },
  };
  return evidence(years, unit);
}
function evidence(
  years: Record<string, Record<string, number>>,
  unit = "人民币元",
) {
  const row: Record<string, unknown> = { 股票代码: "600519.SH" };
  const columns: { key: string; unit: string; timestamp: string }[] = [];
  for (const [timestamp, fields] of Object.entries(years))
    for (const [name, value] of Object.entries(fields)) {
      const key = `${name}[${timestamp}]`;
      row[key] = value;
      columns.push({ key, unit, timestamp });
    }
  return financeEvidence(
    "sh600519",
    { status_code: 0, datas: [row], columns },
    "fixture",
    1000,
  );
}
it("reconciles consolidated profit and calculates average-balance DuPont without inventing a full F-score", () => {
  const input = fixture(),
    before = JSON.stringify(input);
  const result = financialQuality("sh600519", [input]);
  const latest = result.annual.at(-1)!;
  expect(latest.netProfit.value).toBe(20);
  expect(latest.averageAssets.value).toBe(130);
  expect(latest.averageEquity.value).toBe(65);
  expect(latest.ratios.roe.value).toBeCloseTo(20 / 65);
  expect(latest.ratios.cashToProfit.value).toBe(1.25);
  expect(latest.ratios.reportedProfitRoa.value).toBeCloseTo(20 / 120);
  expect(latest.ratios.roe.citations).toEqual([input.id]);
  expect(result.fScore).toMatchObject({
    total: null,
    knownPoints: 4,
    knownCount: 4,
  });
  expect(result.fScore.items).toHaveLength(9);
  expect(
    result.fScore.items.find((row) => row.id === "no-equity-offering")!.point,
  ).toBeNull();
  expect(JSON.stringify(input)).toBe(before);
});
it("retains unspecified currency as a conditional ratio basis, not certified CNY", () => {
  const result = financialQuality("sh600519", [fixture("元")]);
  expect(result.annual.at(-1)!.ratios.roe).toMatchObject({
    currencyBasis: "source-yuan-unspecified",
  });
  expect(result.annual.at(-1)!.ratios.roe.value).toBeCloseTo(20 / 65);
  expect(result.annual.at(-1)!.amounts.parentProfit.currency).toBeNull();
});
it("does not replace missing minority profit with zero or cross a missing annual balance", () => {
  const result = financialQuality("sh600519", [
    evidence({
      "20231231": { 资产总计: 100, 所有者权益合计: 50 },
      "20251231": {
        资产总计: 140,
        所有者权益合计: 70,
        归属于母公司所有者的净利润: 18,
        营业收入: 150,
        经营活动产生的现金流量净额: 25,
      },
      "20250930": { 净利润: 99 },
    }),
  ]);
  const latest = result.annual.at(-1)!;
  expect(latest.netProfit.value).toBeNull();
  expect(latest.averageAssets.value).toBeNull();
  expect(latest.ratios.roe.value).toBeNull();
  expect(result.fScore.knownCount).toBe(0);
  expect(result.rejected).toHaveLength(1);
});
it("blocks contradictory profit, negative equity and zero denominators", () => {
  const result = financialQuality("sh600519", [
    evidence({
      "20241231": { 资产总计: 120, 所有者权益合计: -10 },
      "20251231": {
        资产总计: 140,
        所有者权益合计: 70,
        净利润: 30,
        归属于母公司所有者的净利润: 18,
        少数股东损益: 2,
        营业收入: 0,
        营业成本: 1,
        流动资产合计: 90,
        流动负债合计: 0,
      },
    }),
  ]);
  const latest = result.annual.at(-1)!;
  expect(latest.netProfit.value).toBeNull();
  expect(latest.netProfit.missing.join()).toContain("不一致");
  expect(latest.averageEquity.value).toBeNull();
  expect(latest.ratios.grossMargin.value).toBeNull();
  expect(latest.ratios.currentRatio.value).toBeNull();
});
it("keeps conflicting consolidated sources invalid instead of silently using components", () => {
  const first = evidence({
    "20251231": { 净利润: 30, 归属于母公司所有者的净利润: 18, 少数股东损益: 2 },
  });
  const second = evidence({ "20251231": { 净利润: 31 } });
  expect(
    financialQuality("sh600519", [first, second]).annual[0]!.netProfit.value,
  ).toBeNull();
});

it("accepts explicit provider abbreviations while preserving conflicting alias evidence", () => {
  const source = evidence({
    "20241231": { 总资产: 120, 所有者权益: 60 },
    "20251231": {
      总资产: 140,
      所有者权益: 70,
      归母净利润: 18,
      少数股东损益: 2,
      营业收入: 150,
    },
  });
  expect(
    financialQuality("sh600519", [source]).annual.at(-1)!.ratios.roe.value,
  ).toBeCloseTo(20 / 65);
  const conflict = evidence({ "20251231": { 资产总计: 141 } });
  const row = financialQuality("sh600519", [source, conflict]).annual.at(-1)!;
  expect(row.amounts.assets.value).toBeNull();
  expect(row.amounts.assets.points).toHaveLength(2);
  expect(row.ratios.roe.value).toBeNull();
});
