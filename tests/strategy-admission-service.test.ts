import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { admissionResearchFixture } from "./strategy-admission-fixture";
import {
  admissionConclusion,
  strategyAdmission,
  type StrategyAdmissionInput,
} from "../src/lib/strategy-admission";
import {
  admissionPageSchema,
  admissionBenchmarkReturns,
  tradeReviewAdmissionSource,
  researchAdmissionSource,
  pageStrategyAdmission,
  exportStrategyAdmission,
} from "../src/server/strategy-admission-service";
import { replayTradeReview } from "../src/server/trade-review-service";
import { StrategyAdmissionResults } from "../src/components/strategy-admission-results";
import { admissionCalibrationDistribution } from "../scripts/u8-calibration-distribution";

it("E3 真实计算结果接入两种模式，分区独立并保留缺失", async () => {
  const { result, dataset } = await admissionResearchFixture();
  const development = researchAdmissionSource(result, dataset, "development");
  const validation = researchAdmissionSource(result, dataset, "validation");
  expect(development.input.dates).toHaveLength(8);
  expect(validation.input.dates).toHaveLength(4);
  expect(development.input.dates.at(-1)! < validation.input.dates[0]!).toBe(
    true,
  );
  expect(validation.input.strategyDaily[0]).toBe(
    result.partitions[1]!.simulation!.nav[0]!.value /
      result.spec.initialCapital -
      1,
  );
  expect(validation.input.evidenceLevel).toBe("本地模拟未独立核验");
  const page = pageStrategyAdmission(
    development,
    admissionPageSchema.parse({}),
    true,
  );
  expect(page.history.mode).toBe("history");
  expect(page.recent!.mode).toBe("recent");
  expect(page.history.evidenceLevel).toBe(development.input.evidenceLevel);
  result.partitions[0]!.simulation = null;
  const missing = pageStrategyAdmission(
    researchAdmissionSource(result, dataset, "development"),
    admissionPageSchema.parse({}),
    true,
  );
  expect(missing.history.alphaDegenerate).toBe(true);
  expect(missing.history.isGood).toBe(false);
  expect(missing.history.coverage.strategyMissingDays).toBe(8);
});

it("账户沿用真实重放日度TWR、完整日历和基准，首日缺前价不补零", () => {
  const dates = ["2026-01-05", "2026-01-06", "2026-01-07"];
  const snapshot = replayTradeReview({
    version: 1,
    account: "synthetic",
    trades: { fills: [], cashFlows: [] },
    nav: {
      tradingDays: dates,
      openingCash: 100,
      benchmark: [
        { date: "2026-01-02", close: 100 },
        { date: dates[0]!, close: 101 },
        { date: dates[1]!, close: 99 },
        { date: dates[2]!, close: 100 },
      ],
    },
    dimensions: {},
    batches: [],
    sources: [],
    warnings: [],
    rpsPeriod: 250,
  });
  const source = tradeReviewAdmissionSource(snapshot, ["2026-01-02", ...dates]);
  expect(source.input.strategyDaily).toEqual(
    snapshot.nav.days.map((day) => day.dailyReturn.value),
  );
  expect(source.input.benchDaily).toEqual([
    101 / 100 - 1,
    99 / 101 - 1,
    100 / 99 - 1,
  ]);
  expect(source.input.evidenceLevel).toBe("真实账户交割单");
  const exported = exportStrategyAdmission(
    source,
    admissionPageSchema.parse({}).params,
    false,
  );
  expect(exported.results).toHaveLength(1);
  expect(exported.results[0]!.mode).toBe("history");
  expect(tradeReviewAdmissionSource(snapshot).input.benchDaily[0]).toBeNull();
  expect(exported).not.toHaveProperty("account");
  expect(JSON.stringify(exported)).not.toContain('"synthetic"');
});

it("基准缺中间交易日不跨越，非法价格与日历抛错", () => {
  const calendar = ["2026-01-02", "2026-01-05", "2026-01-06"];
  const bars = [
    { date: calendar[0]!, close: 100 },
    { date: calendar[2]!, close: 110 },
  ];
  expect(admissionBenchmarkReturns(calendar.slice(1), calendar, bars)).toEqual([
    null,
    null,
  ]);
  expect(() =>
    admissionBenchmarkReturns(["2027-01-01"], calendar, bars),
  ).toThrow();
  expect(() =>
    admissionBenchmarkReturns(calendar, [...calendar].reverse(), bars),
  ).toThrow();
  expect(() =>
    admissionBenchmarkReturns(calendar, calendar, [...bars, bars[0]!]),
  ).toThrow();
  expect(() =>
    admissionBenchmarkReturns(calendar, calendar, [
      { date: calendar[0]!, close: NaN },
    ]),
  ).toThrow();
});

it("年度分页在服务端排序，汇总与完整重放导出不随翻页变化", () => {
  const source = {
    note: "受控分页样本",
    input: {
      dates: [
        "2023-01-02",
        "2023-01-03",
        "2024-01-02",
        "2024-01-03",
        "2025-01-02",
        "2025-01-03",
      ],
      strategyDaily: [0.01, -0.02, 0.03, -0.01, 0.02, 0.04],
      benchDaily: [-0.01, 0.01, -0.01, 0.01, -0.02, 0.01],
      evidenceLevel: "合成/受控样本" as const,
    },
  };
  const pageInput = admissionPageSchema.parse({
    params: { minYearDays: 2 },
    sort: "year",
    desc: true,
    pageSize: 1,
    pageIndex: 1,
  });
  const page = pageStrategyAdmission(source, pageInput, true);
  expect(page.yearly.rowCount).toBe(3);
  expect(page.yearly.rows.map((y) => y.year)).toEqual(["2024"]);
  expect(page.history).not.toHaveProperty("yearlyMetrics");
  expect(page.history).toEqual(
    pageStrategyAdmission(source, { ...pageInput, pageIndex: 0 }, true).history,
  );
  const exportData = exportStrategyAdmission(source, pageInput.params, true);
  const serialized = JSON.parse(
    JSON.stringify(exportData),
  ) as typeof exportData;
  expect(
    serialized.inputs.map((input) =>
      strategyAdmission(input as StrategyAdmissionInput),
    ),
  ).toEqual(serialized.results);
  expect(
    serialized.results[0]!.mode === "history" &&
      serialized.results[0]!.yearlyMetrics,
  ).toHaveLength(3);
  const changed = pageStrategyAdmission(
    source,
    { ...pageInput, params: { ...pageInput.params, minYearDays: 3 } },
    true,
  );
  expect(changed.history.completeYearCount).toBe(0);
  expect(changed.history.params.minYearDays).toBe(3);
  expect(() =>
    exportStrategyAdmission(
      {
        ...source,
        input: { ...source.input, benchDaily: [NaN, 0, 0, 0, 0, 0] },
      },
      pageInput.params,
      true,
    ),
  ).toThrow("无法生成可独立重放");
});

it("结论带出处，可信度同字号，指标条件和参数仍可查看", async () => {
  const { result, dataset } = await admissionResearchFixture();
  const data = pageStrategyAdmission(
    researchAdmissionSource(result, dataset, "development"),
    admissionPageSchema.parse({}),
    true,
  );
  // 结论已按行业通行口径解封，但出处必须始终贴在结论旁，不能只显示「通过」。
  data.history.isGood = true;
  data.recent!.isGood = true;
  const html = renderToStaticMarkup(
    createElement(StrategyAdmissionResults, {
      data,
      table: {
        pagination: { pageIndex: 0, pageSize: 10 },
        sorting: [],
        onPaginationChange: () => {},
        onSortingChange: () => {},
      },
    }),
  );
  // 结论可见，但「未按本账户标定」必须同行贴住，不允许裸露一个「通过」。
  expect(html).toContain(
    "history：通过（在该数据前提下；行业通行口径，未按本账户标定）",
  );
  expect(html).toContain(
    "recent：通过（在该数据前提下；行业通行口径，未按本账户标定）",
  );
  expect(html).toContain("未按本账户标定");
  expect(html).toContain("Grinold–Kahn");
  expect(html).toContain("不能当作账户业绩判定");
  expect(html).toContain("condSharpePassed");
  expect(html).toContain("minYearDays");
  expect(html).not.toContain("isGood");
  expect(html).toMatch(
    /<p class="text-base font-medium">history：通过（在该数据前提下；行业通行口径，未按本账户标定） · 数据可信度：本地模拟未独立核验<\/p>/,
  );
  // 真实账户去掉「在该数据前提下」，但出处标注一个字都不能少。
  expect(
    admissionConclusion({ isGood: true, evidenceLevel: "真实账户交割单" }),
  ).toBe("通过（行业通行口径，未按本账户标定）");
  expect(
    admissionConclusion({ isGood: false, evidenceLevel: "真实账户交割单" }),
  ).toBe("未通过（行业通行口径，未按本账户标定）");
});

it("既有合成样本标定分布输出 min/中位数/max，缺失保留原因而非零", async () => {
  const report = await admissionCalibrationDistribution();
  expect(report.scope).toBe("A 股");
  expect(report.calibrationStatus).toBe("未标定"); // 合成分布报告本身仍未标定，与页面阈值口径无关
  expect(report.inputs).toHaveLength(4);
  expect(report.results.every((r) => r.evidenceLevel === "合成/受控样本")).toBe(
    true,
  );
  expect(report.distributions.longAnnualVolatility!.available).toBe(2);
  for (const d of Object.values(report.distributions)) {
    expect(d).toHaveProperty("min");
    expect(d).toHaveProperty("median");
    expect(d).toHaveProperty("max");
    if (d.available) {
      expect(d.min!).toBeLessThanOrEqual(d.median!);
      expect(d.median!).toBeLessThanOrEqual(d.max!);
    }
  }
  expect(report.distributions.historyAlphaMaxDrawdownExclRecent).toMatchObject({
    available: 0,
    unavailable: 2,
    min: null,
    median: null,
    max: null,
  });
  expect(
    report.distributions.historyAlphaMaxDrawdownExclRecent!.unavailableReasons
      .length,
  ).toBeGreaterThan(0);
  expect(report.inputs.map(strategyAdmission)).toEqual(report.results);
});
