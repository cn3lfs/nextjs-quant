import { describe, it, expect } from "vitest";
import {
  classicFinancialFeatures,
  classicRanks,
  csi800ClassicFactors,
} from "../src/csi800-factors.js";
import {
  classicModelScore,
  scoreClassicWeek,
  classicPortfolioVolatility,
  classicCommonWindow,
  buildClassicSchedule,
  type ClassicWeek,
  type ClassicScoredRow,
} from "../src/csi800-composite.js";
import { csi800ForwardReturn, csi800SignalBars } from "../src/csi800-signal.js";
import type { FinancialReportSnapshot } from "trading-strategy-core/financial";
import type { Csi800Stock } from "../src/csi800-study.js";

function report(
  date: string,
  announcement: string,
  values: Record<number, number>,
  financial = false,
): FinancialReportSnapshot {
  return {
    symbol: "sh600000",
    financialCompany: financial,
    reportDate: date,
    announcementDate: announcement,
    availableFrom: announcement === "2024-10-30" ? "2024-10-31" : announcement,
    sourceFilename: "fixture",
    sourceSha256: date,
    contentSha256: date,
    recordOffset: 0,
    mappingVersion: "fixture",
    warnings: [],
    fields: Object.entries(values).map(([code, value]) => ({
      code: `FN${code}`,
      label: code,
      section: "fixture",
      slot: +code - 1,
      raw: value,
      value,
      unit: "元",
      rawUnit: "元",
      scale: 1,
      timing: "cumulative",
      status: "value",
      reason: null,
    })),
  };
}
const history = () => [
  report("2024-09-30", "2024-10-30", {
    40: 1200,
    271: 600,
    74: 900,
    75: 600,
    96: 90,
    95: 108,
    107: 120,
    63: 600,
    35: 20,
  }),
  report("2023-12-31", "2024-03-01", {
    40: 1000,
    271: 500,
    74: 1000,
    75: 700,
    96: 100,
    95: 120,
    107: 150,
  }),
  report("2023-09-30", "2023-10-30", {
    40: 1000,
    271: 500,
    74: 700,
    75: 500,
    96: 70,
    95: 84,
    107: 90,
  }),
];
function scored(): ClassicScoredRow {
  return {
    symbol: "sh600000",
    values: [],
    volatility: 0.01,
    amihud: 1,
    positiveEquity: true,
    reportDate: null,
    announcementDate: null,
    availableFrom: null,
    marketCap: 1000,
    families: {
      momentum: 0.4,
      trend: 0.4,
      reversal: 0.4,
      "low-risk": 0.4,
      quality: 0.2,
      value: 0.2,
      growth: 0.2,
      investment: 0.2,
      "balance-sheet": 0.2,
    },
  };
}
function panelWeek(
  date = "2024-11-01",
  nextDate = "2024-11-04",
  count = 210,
): ClassicWeek {
  return {
    date,
    nextDate,
    marketBudget: 1,
    rows: Array.from({ length: count }, (_, i) => ({
      symbol: `sh${600000 + i}`,
      values: csi800ClassicFactors.map(() => i),
      volatility: 0.01,
      amihud: i,
      positiveEquity: true,
      reportDate: "2024-09-30",
      announcementDate: "2024-10-30",
      availableFrom: "2024-10-31",
      marketCap: 1000,
    })),
  };
}
describe("classic CSI800 factor rules", () => {
  it("a fully invested budget can be reused despite floating-point summation", () => {
    const week = panelWeek();
    const first = buildClassicSchedule(
      [week],
      { model: "combined" },
      () => null,
    );
    expect(first.audit[0]!.exposure).toBeLessThanOrEqual(1);
    const override = new Map(first.audit.map((r) => [r.date, r.exposure]));
    expect(() =>
      buildClassicSchedule(
        [week],
        { model: "eligible-equal", budgetOverride: override },
        () => null,
      ),
    ).not.toThrow();
  });
  it("uses average ties and treats constant columns as no ranking power", () => {
    expect(classicRanks([2, 2, 4, null])).toEqual([-0.25, -0.25, 0.5, null]);
    expect(classicRanks([3, 3, 3])).toEqual([0, 0, 0]);
    expect(classicRanks([NaN, Infinity, null])).toEqual([null, null, null]);
  });
  it("calculates TTM from visible constituents and prior annual gross profitability", () => {
    const f = classicFinancialFeatures(history(), "2024-11-01")!;
    expect(f.values["roe-ttm"]).toBeCloseTo(120 / 600);
    expect(f.values["cash-quality"]).toBeCloseTo((180 - 144) / 1200);
    expect(f.values["gross-profit-assets"]).toBeCloseTo((1000 - 700) / 1000);
    expect(f.values["asset-growth"]).toBeCloseTo(0.2);
    expect(f.values["revenue-growth"]).toBeCloseTo((900 / 700 - 1) * 100);
  });
  it("announcement-day data and future reports cannot change past factors", () => {
    const h = history();
    expect(classicFinancialFeatures(h, "2024-10-30")!.reportDate).toBe(
      "2023-12-31",
    );
    expect(classicFinancialFeatures(h, "2024-10-31")!.reportDate).toBe(
      "2024-09-30",
    );
    const before = classicFinancialFeatures(h, "2024-11-01");
    h.unshift(report("2024-12-31", "2025-03-01", { 40: 1, 96: 999999 }));
    expect(classicFinancialFeatures(h, "2024-11-01")).toEqual(before);
    const missing = history().filter((r) => r.reportDate !== "2023-09-30");
    expect(
      classicFinancialFeatures(missing, "2024-11-01")!.values["roe-ttm"],
    ).toBeNull();
    expect(classicFinancialFeatures(history(), "2027-01-01")).toBeNull();
  });
  it("does not apply industrial-company cash, gross profit and leverage to banks", () => {
    const h = history().map((r) => ({ ...r, financialCompany: true }));
    const f = classicFinancialFeatures(h, "2024-11-01")!;
    expect(f.values["roe-ttm"]).toBeCloseTo(0.2);
    expect(f.values["gross-profit-assets"]).toBeNull();
    expect(f.values["cash-assets"]).toBeNull();
    expect(f.values["debt-ratio"]).toBeNull();
  });
  it("assigns technical and financial branches 50/50 regardless of column count", () => {
    const row = scored();
    expect(classicModelScore(row, "combined")).toBeCloseTo(0.3);
    row.families.quality = null;
    expect(classicModelScore(row, "combined")).toBeNull();
    row.families.quality = 0.2;
    row.positiveEquity = false;
    expect(classicModelScore(row, "value")).toBeNull();
    expect(classicModelScore(row, "technical")).toBeCloseTo(0.4);
  });
  it("enforces family coverage rather than filling missing inputs with zero", () => {
    const w = panelWeek();
    const quality = csi800ClassicFactors.flatMap((f, i) =>
      f.family === "quality" ? [i] : [],
    );
    for (const i of quality) w.rows[0]!.values[i] = null;
    expect(scoreClassicWeek(w)[0]!.families.quality).toBeNull();
    w.rows.push(w.rows[0]!);
    expect(() => scoreClassicWeek(w)).toThrow("重复");
  });
  it("computes covariance via portfolio returns, including negative correlation", () => {
    const a = Array.from({ length: 60 }, (_, i) => (i % 2 ? 0.01 : -0.01));
    const same = classicPortfolioVolatility([a, a], [0.5, 0.5])!;
    const opposite = classicPortfolioVolatility(
      [a, a.map((x) => -x)],
      [0.5, 0.5],
    )!;
    expect(same).toBeCloseTo(Math.sqrt((60 * 0.0001) / 59) * Math.sqrt(252));
    expect(opposite).toBe(0);
    expect(classicPortfolioVolatility([a.slice(1)], [1])).toBeNull();
  });
  it("starts the common window only after four consecutive coverage-qualified weeks", () => {
    const w = Array.from({ length: 4 }, (_, i) =>
      panelWeek(
        `2024-11-${String(1 + 7 * i).padStart(2, "0")}`,
        `2024-11-${String(4 + 7 * i).padStart(2, "0")}`,
      ),
    );
    expect(classicCommonWindow(w.slice(0, 3)).start).toBeNull();
    expect(classicCommonWindow(w).start).toBe("2024-11-25");
    w[1]!.rows = w[1]!.rows.slice(0, 199);
    expect(classicCommonWindow(w).start).toBeNull();
  });
  it("caps targets, leaves insufficient slots in cash and goes to cash on missing risk history", () => {
    const w = panelWeek(undefined, undefined, 2);
    const regular = buildClassicSchedule([w], { model: "combined" }, () =>
      Array(60).fill(0.01),
    );
    expect(
      Object.values(regular.allocations[0]!.weights).reduce((a, b) => a + b, 0),
    ).toBeCloseTo(0.1);
    const defensive = buildClassicSchedule(
      [w],
      { model: "combined-defensive" },
      () => null,
    );
    expect(defensive.audit[0]!.exposure).toBe(0);
    expect(defensive.audit[0]!.riskMissing).toBe(true);
  });
  it("forward labels exclude entry actions, include exit actions and never use close-based open adjustments", () => {
    const stock: Csi800Stock = {
      symbol: "sh600000",
      bars: [
        {
          date: "2024-01-02",
          open: 10,
          close: 10,
          high: 11,
          low: 9,
          amount: 1e8,
          volume: 1e7,
        },
        {
          date: "2024-01-03",
          open: 10,
          close: 99,
          high: 100,
          low: 9,
          amount: 1e8,
          volume: 1e7,
        },
        {
          date: "2024-01-04",
          open: 5,
          close: 5,
          high: 6,
          low: 4,
          amount: 1e8,
          volume: 1e7,
        },
      ],
      actions: [
        { date: "2024-01-03", dividend: 2, bonus: 0, unsupported: false },
        { date: "2024-01-04", dividend: 1, bonus: 1, unsupported: false },
      ],
    };
    expect(csi800ForwardReturn(stock, "2024-01-03", "2024-01-04")).toBeCloseTo(
      0.1,
    );
    const before = csi800SignalBars(stock)[0];
    stock.bars[2]!.close = 999;
    expect(csi800SignalBars(stock)[0]).toEqual(before);
    expect(csi800ForwardReturn(stock, "2024-01-03", "2024-01-04")).toBeCloseTo(
      0.1,
    );
  });
});
