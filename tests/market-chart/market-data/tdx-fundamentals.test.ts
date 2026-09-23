import { describe, expect, it } from "vitest";
import {
  compactNumber,
  fundamentalMetrics,
  reportAnnualFactor,
  statementGroups,
  tdxDate,
  unverifiedFields,
  type ReportFields,
} from "../../../src/lib/market/tdx-fundamentals";

/**
 * sh600519 的 2026 中报，取自本地财务包 gpcw20260630.dat（金额单位为元）。
 * 自洽校验：净资产 251,253,600,000 ÷ 总股本 1,250,081,562.5 = 200.98977 元/股，
 * 与财务包给出的归母每股净资产 200.99 在 float32 精度内相符，说明量级与口径都对。
 * 注意两者并非同一口径：茅台没有少数股东权益才恰好相等，银行与券商会明显不同。
 */
const report: ReportFields = {
  totalAssets: 309_050_784_000,
  currentAssets: 260_724_656_000,
  fixedAssets: 22_220_890_000,
  intangibleAssets: 8_578_744_000,
  inventory: 61_317_208_000,
  receivables: 570_895.0625,
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
  shareholders: 296_404,
  totalShares: 1_250_081_562.5,
  bookValuePerShare: 200.99,
};
const reportDate = "2026-06-30";
const price = 1272.75;
const latestShares = {
  totalShares: 1_250_081_562.5,
  floatShares: 1_250_081_562.5,
};
const metricsOf = (
  overrides: Partial<Parameters<typeof fundamentalMetrics>[0]> = {},
) =>
  fundamentalMetrics({ report, reportDate, latestShares, price, ...overrides });

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
  it("按手算值输出估值与盈利能力，结果落在真实量级", () => {
    const m = metricsOf();
    expect(m.reportDate).toBe(reportDate);
    expect(m.annualFactor).toBe(2);
    expect(m.sharesBasis).toBe("latest");
    // 1272.75 × 1,250,081,562.5 = 1,591,041,308,671.875（1.59 万亿）
    expect(m.marketCap.value).toBeCloseTo(1_591_041_308_671.875, 3);
    expect(m.floatRatio.value).toBe(1);
    // 每股净资产取财务包的归母口径，不由净资产除股本自算
    expect(m.bookValuePerShare.value).toBe(200.99);
    // 1272.75 / 200.99 = 6.3324046
    expect(m.priceToBook.value).toBeCloseTo(1272.75 / 200.99, 10);
    // 44,516,880,000 / 1,250,081,562.5 = 35.61117；半年报年化 ×2 = 71.22234
    expect(m.reportedEps.value).toBeCloseTo(35.61117, 4);
    expect(m.annualizedEps.value).toBeCloseTo(71.22234, 4);
    expect(m.annualizedPe.value).toBeCloseTo(17.87009, 4);
    expect(m.priceToSales.value).toBeCloseTo(8.770585, 5);
    // 44,516,880,000 / 251,253,600,000 = 17.718%
    expect(m.reportedRoe.value).toBeCloseTo(0.17718, 5);
    // 44,516,880,000 / 90,703,264,000 = 49.08%
    expect(m.netMargin.value).toBeCloseTo(0.4908, 5);
    // (46,645,076,000 + 10,842,758,000) / 309,050,784,000 = 18.60%
    expect(m.debtRatio.value).toBeCloseTo(0.18601, 5);
    expect(m.undistributedPerShare.value).toBeCloseTo(159.73615, 5);
    expect(m.sharesPerHolder.value).toBeCloseTo(4217.4922, 4);
  });
  it("实时快照未到达时市值退回报告期末股本并标注口径，流通口径留空", () => {
    const m = metricsOf({ latestShares: null });
    expect(m.sharesBasis).toBe("report");
    // 报告期末股本与最新股本相同，市值不变；口径标注变了
    expect(m.marketCap.value).toBeCloseTo(1_591_041_308_671.875, 3);
    expect(m.floatMarketCap).toEqual({
      value: null,
      reason: "实时价不可得，或流通股本要等实时快照",
    });
    expect(m.floatRatio).toEqual({
      value: null,
      reason: "流通占比要等实时快照",
    });
    // 不依赖快照的口径全部照常
    expect(m.priceToBook.value).toBeCloseTo(1272.75 / 200.99, 10);
    expect(m.reportedEps.value).toBeCloseTo(35.61117, 4);
    expect(m.debtRatio.value).toBeCloseTo(0.18601, 5);
  });
  it("每股指标用报告期末股本，不因最新股本变动而改变", () => {
    // 报告期后增发一倍：市值翻倍，但每股收益与每股净资产必须不变
    const m = metricsOf({
      latestShares: { totalShares: 2_500_163_125, floatShares: 2_500_163_125 },
    });
    expect(m.marketCap.value).toBeCloseTo(2 * 1_591_041_308_671.875, 3);
    expect(m.reportedEps.value).toBeCloseTo(35.61117, 4);
    expect(m.bookValuePerShare.value).toBe(200.99);
    expect(m.undistributedPerShare.value).toBeCloseTo(159.73615, 5);
  });
  it("报告期不是标准季末时只留空年化口径", () => {
    const m = metricsOf({ reportDate: "2026-05-31" });
    expect(m.annualFactor).toBeNull();
    expect(m.annualizedEps).toEqual({
      value: null,
      reason: "报告期不是标准季末或每股收益不可得",
    });
    expect(m.annualizedPe.value).toBeNull();
    expect(m.priceToSales.value).toBeNull();
    expect(m.reportedEps.value).toBeCloseTo(35.61117, 4);
    expect(m.reportedRoe.value).toBeCloseTo(0.17718, 5);
  });
  it("实时价不可得时价格相关指标留空并说明，不回退到其他价格", () => {
    const m = metricsOf({ price: null });
    expect(m.marketCap).toEqual({
      value: null,
      reason: "实时价或总股本不可得",
    });
    expect(m.priceToBook.value).toBeNull();
    expect(m.annualizedPe.value).toBeNull();
    expect(m.priceToSales.value).toBeNull();
    // 与价格无关的口径仍然可得
    expect(m.reportedEps.value).toBeCloseTo(35.61117, 4);
    expect(m.bookValuePerShare.value).toBe(200.99);
  });
  it("每股净资产取归母口径，不由净资产除总股本自算", () => {
    /*
     * sz000001 实测：归母每股净资产 24.13，而股东权益合计 ÷ 总股本 = 28.25。
     * 自算会把银行与券商的每股净资产抬高、市净率压低（0.49 → 0.42），
     * 与市场通用的归母口径不一致。
     */
    const bank = {
      ...report,
      bookValuePerShare: 24.13,
      netAssets: 548_214_016_000,
      totalShares: 19_405_918_750,
    };
    const m = metricsOf({ report: bank, price: 11.82, latestShares: null });
    expect(m.bookValuePerShare.value).toBe(24.13);
    expect(bank.netAssets / bank.totalShares).toBeCloseTo(28.25, 2);
    // 11.82 / 24.13 = 0.4899；若改用自算的 28.25 会得到 0.4184
    expect(m.priceToBook.value).toBeCloseTo(0.489847, 5);
    expect(m.priceToBook.value).not.toBeCloseTo(11.82 / 28.25, 4);
  });
  it("没有流动负债明细时资产负债率留空，不记 0 也不只按长期负债算", () => {
    // sz000001 两项均为 0；sh601398 与 sh600036 只有长期负债，
    // 相加会得到 0.05% 这种假数字，必须整体留空。
    for (const bank of [
      { currentLiabilities: 0, longTermLiabilities: 0 },
      { currentLiabilities: 0, longTermLiabilities: 288_500_000_000 },
    ])
      expect(metricsOf({ report: { ...report, ...bank } }).debtRatio).toEqual({
        value: null,
        reason: "财务包未提供流动负债明细或总资产不可得",
      });
    expect(metricsOf().debtRatio.value).toBeCloseTo(0.18601, 5);
  });
  it("亏损时年化市盈率留空而不是给出负数", () => {
    const m = metricsOf({
      report: { ...report, netProfit: -20_000_000_000 },
    });
    expect(m.annualizedEps.value).toBeLessThan(0);
    expect(m.annualizedPe.value).toBeNull();
    expect(m.reportedRoe.value).toBeLessThan(0);
  });
  it("股本、净资产、总资产或股东户数为 0 时对应指标留空", () => {
    const m = metricsOf({
      report: {
        ...report,
        totalShares: 0,
        netAssets: 0,
        totalAssets: 0,
        mainRevenue: 0,
        shareholders: 0,
        bookValuePerShare: 0,
      },
      latestShares: null,
    });
    for (const metric of [
      m.marketCap,
      m.floatMarketCap,
      m.floatRatio,
      m.bookValuePerShare,
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
    expect(m.sharesBasis).toBeNull();
  });
});

describe("字段分区", () => {
  it("报表明细全部来自本地财务包字段", () => {
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
    // 本地财务包没有对应槽位的字段不得出现在明细里
    expect(listed).not.toContain("totalCashFlow");
  });
  it("语义未确认的槽位只来自协议快照，且不混进报表明细", () => {
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
