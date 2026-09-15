import { describe, expect, it } from "vitest";
import {
  compactNumber,
  fundamentalMetrics,
  reportAnnualFactor,
  statementGroups,
  tdxDate,
  unverifiedFields,
  type FinanceSnapshot,
} from "../src/lib/tdx-fundamentals";

/**
 * 取自 2026-09-15 对 sh600519 的实网快照，金额按修正后的千元口径换算成元。
 * 这些数值同时被本地财务包 gpcw20260630.dat 佐证：
 * 未分配利润 199,683,216,000 元 ÷ 总股本 1,250,081,562.5 股 = 159.74 元/股，
 * 与财务包「每股未分配利润」槽位的 159.736 一致，说明金额已在正确量级。
 */
const finance: FinanceSnapshot = {
  totalShares: 1_250_081_562.5,
  floatShares: 1_250_081_562.5,
  stateShares: 1215,
  founderShares: 45_402_960,
  legalPersonShares: 89_389_352,
  bShares: 0,
  hShares: 0,
  employeeShares: 35.57,
  totalAssets: 309_050_784_000,
  currentAssets: 260_724_656_000,
  fixedAssets: 22_220_890_000,
  intangibleAssets: 8_578_744_000,
  inventory: 61_317_208_000,
  receivables: 570_800,
  currentLiabilities: 46_645_076_000,
  longTermLiabilities: 10_842_758_000,
  capitalReserve: 1_577_000,
  netAssets: 251_253_600_000,
  mainRevenue: 90_703_264_000,
  mainProfit: 9_473_762_000,
  operatingProfit: 61_411_288_000,
  investmentIncome: 1_013_800,
  totalProfit: 61_438_420_000,
  afterTaxProfit: 46_033_328_000,
  netProfit: 44_516_880_000,
  undistributedProfit: 199_683_216_000,
  operatingCashFlow: 70_690_752_000,
  totalCashFlow: 58_387_000_000,
  shareholders: 296_404,
  bookValuePerShare: 200.99,
  province: 22,
  industry: 471,
  updatedDate: 20260815,
  ipoDate: 20010827,
};
const price = 1272.75;
const period = "2026-06-30";

describe("协议日期", () => {
  it("只接受真实存在的日期", () => {
    expect(tdxDate(20260815)).toBe("2026-08-15");
    expect(tdxDate(20010827)).toBe("2001-08-27");
    expect(tdxDate(20260631)).toBeNull();
    expect(tdxDate(20261301)).toBeNull();
    expect(tdxDate(0)).toBeNull();
    expect(tdxDate(20260630.5)).toBeNull();
  });
});

describe("报告期年化倍数", () => {
  it("只认四个标准季末", () => {
    expect(reportAnnualFactor("2026-03-31")).toBe(4);
    expect(reportAnnualFactor("2026-06-30")).toBe(2);
    expect(reportAnnualFactor("2026-09-30")).toBeCloseTo(4 / 3, 12);
    expect(reportAnnualFactor("2026-12-31")).toBe(1);
    expect(reportAnnualFactor("2026-05-31")).toBeNull();
    expect(reportAnnualFactor(null)).toBeNull();
  });
});

describe("派生指标", () => {
  it("按手算值输出市值、估值与盈利能力，结果落在真实量级", () => {
    const m = fundamentalMetrics(finance, price, period);
    expect(m.reportDate).toBe(period);
    expect(m.snapshotDate).toBe("2026-08-15");
    expect(m.ipoDate).toBe("2001-08-27");
    expect(m.annualFactor).toBe(2);
    // 1272.75 × 1,250,081,562.5 = 1,591,041,308,671.875（1.59 万亿，与真实市值同量级）
    expect(m.marketCap.value).toBeCloseTo(1_591_041_308_671.875, 3);
    expect(m.floatRatio.value).toBe(1);
    // 1272.75 / 200.99 = 6.3324
    expect(m.priceToBook.value).toBeCloseTo(1272.75 / 200.99, 12);
    // 44,516,880,000 / 1,250,081,562.5 = 35.6112 元；半年报年化 ×2 = 71.2223
    expect(m.reportedEps.value).toBeCloseTo(35.61117, 4);
    expect(m.annualizedEps.value).toBeCloseTo(71.22234, 4);
    // 1272.75 / 71.22234 = 17.87009
    expect(m.annualizedPe.value).toBeCloseTo(17.87009, 4);
    // 1,591,041,308,671.875 / (90,703,264,000 × 2) = 8.770585
    expect(m.priceToSales.value).toBeCloseTo(8.770585, 5);
    // 44,516,880,000 / 251,253,600,000 = 17.718%
    expect(m.reportedRoe.value).toBeCloseTo(0.17718, 5);
    // 44,516,880,000 / 90,703,264,000 = 49.08%
    expect(m.netMargin.value).toBeCloseTo(0.4908, 5);
    // (46,645,076,000 + 10,842,758,000) / 309,050,784,000 = 18.60%
    expect(m.debtRatio.value).toBeCloseTo(0.18601, 5);
    // 199,683,216,000 / 1,250,081,562.5 = 159.736，与财务包每股未分配利润一致
    expect(m.undistributedPerShare.value).toBeCloseTo(159.73615, 5);
    // 1,250,081,562.5 / 296,404 = 4217.4922
    expect(m.sharesPerHolder.value).toBeCloseTo(4217.4922, 4);
  });
  it("报告期未确定时只留空年化口径，报告期内比值仍可得", () => {
    const m = fundamentalMetrics(finance, price, null);
    expect(m.annualFactor).toBeNull();
    expect(m.annualizedEps).toEqual({
      value: null,
      reason: "报告期未确定或每股收益不可得",
    });
    expect(m.annualizedPe.value).toBeNull();
    expect(m.priceToSales.value).toBeNull();
    expect(m.reportedEps.value).toBeCloseTo(35.61117, 4);
    expect(m.reportedRoe.value).toBeCloseTo(0.17718, 5);
    expect(m.priceToBook.value).toBeCloseTo(1272.75 / 200.99, 12);
  });
  it("实时价不可得时价格相关指标留空并说明，不回退到其他价格", () => {
    const m = fundamentalMetrics(finance, null, period);
    expect(m.marketCap).toEqual({
      value: null,
      reason: "实时价或总股本不可得",
    });
    expect(m.floatMarketCap.value).toBeNull();
    expect(m.priceToBook.value).toBeNull();
    expect(m.annualizedPe.value).toBeNull();
    expect(m.priceToSales.value).toBeNull();
    expect(m.reportedEps.value).toBeCloseTo(35.61117, 4);
    expect(m.debtRatio.value).toBeCloseTo(0.18601, 5);
  });
  it("协议不给流动负债时资产负债率留空，不记 0 也不只按长期负债算", () => {
    // sz000001 实测两项均为 0；sh601398 与 sh600036 只有长期负债，
    // 相加会得到 0.05% 这种假数字，必须整体留空。
    for (const bank of [
      { currentLiabilities: 0, longTermLiabilities: 0 },
      { currentLiabilities: 0, longTermLiabilities: 288_500_000_000 },
    ])
      expect(
        fundamentalMetrics({ ...finance, ...bank }, price, period).debtRatio,
      ).toEqual({
        value: null,
        reason: "协议未提供流动负债明细或总资产不可得",
      });
    const m = fundamentalMetrics(finance, price, period);
    expect(m.debtRatio.value).toBeCloseTo(0.18601, 5);
  });
  it("亏损时年化市盈率留空而不是给出负数", () => {
    const m = fundamentalMetrics(
      { ...finance, netProfit: -20_000_000_000 },
      price,
      period,
    );
    expect(m.annualizedEps.value).toBeLessThan(0);
    expect(m.annualizedPe.value).toBeNull();
    expect(m.reportedRoe.value).toBeLessThan(0);
  });
  it("股本、净资产、总资产或股东户数为 0 时对应指标留空", () => {
    const m = fundamentalMetrics(
      {
        ...finance,
        totalShares: 0,
        floatShares: 0,
        bookValuePerShare: 0,
        shareholders: 0,
        netAssets: 0,
        totalAssets: 0,
        mainRevenue: 0,
      },
      price,
      period,
    );
    for (const metric of [
      m.marketCap,
      m.floatMarketCap,
      m.floatRatio,
      m.priceToBook,
      m.reportedEps,
      m.annualizedPe,
      m.priceToSales,
      m.reportedRoe,
      m.netMargin,
      m.debtRatio,
      m.sharesPerHolder,
      m.reservePerShare,
      m.undistributedPerShare,
    ])
      expect(metric.value).toBeNull();
  });
});

describe("字段分区", () => {
  it("报表明细只含已核对单位的金额字段", () => {
    const listed = statementGroups.flatMap((group) =>
      group.fields.map(([field]) => field),
    );
    for (const field of [
      "totalAssets",
      "netAssets",
      "netProfit",
      "mainRevenue",
      "currentLiabilities",
      "operatingCashFlow",
    ])
      expect(listed).toContain(field);
  });
  it("语义未确认的槽位单独列出，且不出现在报表明细里", () => {
    const unverified = unverifiedFields.map(([field]) => field);
    const listed = statementGroups.flatMap((group) =>
      group.fields.map(([field]) => field),
    );
    expect(unverified).toEqual([
      "stateShares",
      "legalPersonShares",
      "founderShares",
      "bShares",
      "hShares",
      "employeeShares",
    ]);
    for (const field of unverified) expect(listed).not.toContain(field);
    // 实测异常：法人股槽位远大于总股本，职工股槽位实际是每股收益
    expect(finance.legalPersonShares).toBeGreaterThan(finance.totalShares / 20);
    expect(finance.employeeShares).toBeCloseTo(35.57, 2);
  });
});

describe("数量级展示", () => {
  it("按亿、万与原值分档，不改变单位语义", () => {
    expect(compactNumber(20_000_000_000)).toBe("200.00 亿");
    expect(compactNumber(50_000)).toBe("5.00 万");
    expect(compactNumber(50_000, 0)).toBe("5 万");
    expect(compactNumber(1234)).toBe("1234.00");
    expect(compactNumber(0)).toBe("0.00");
    expect(compactNumber(0.5)).toBe("0.5000");
    expect(compactNumber(-20_000_000_000)).toBe("-200.00 亿");
    expect(compactNumber(null)).toBeNull();
    expect(compactNumber(Number.NaN)).toBeNull();
  });
});
