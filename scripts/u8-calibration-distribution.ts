import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { format } from "prettier";
import { admissionResearchFixture } from "../tests/strategy-admission-fixture";
import { researchAdmissionSource } from "../src/server/strategy-admission-service";
import {
  strategyAdmission,
  defaultAdmissionParams,
  type StrategyAdmissionInput,
} from "../src/lib/strategy-admission";
import type { ReviewValue } from "../src/lib/trade-review";

export async function admissionCalibrationDistribution() {
  const { result, dataset } = await admissionResearchFixture();
  const inputs: StrategyAdmissionInput[] = (
    ["development", "validation"] as const
  ).flatMap((partition) => {
    const source = researchAdmissionSource(result, dataset, partition);
    return (["history", "recent"] as const).map((mode) => ({
      ...source.input,
      evidenceLevel: "合成/受控样本",
      mode,
      params: defaultAdmissionParams,
    }));
  });
  const results = inputs.map(strategyAdmission);
  const metrics: Record<string, ReviewValue[]> = {};
  const add = (key: string, value: ReviewValue) => {
    (metrics[key] ??= []).push(value);
  };
  for (const row of results) {
    if (row.mode === "history") {
      add("longAnnualVolatility", row.longAnnualVolatility);
      add("benchAnnualVolatility", row.benchAnnualVolatility);
      add("longScale", row.longScale);
      add("benchScale", row.benchScale);
      add("historyAlphaMaxDrawdown", row.historyAlphaMaxDrawdown);
      add("historyAlphaSharpe", row.historyAlphaSharpe);
      for (const year of row.yearlyMetrics) {
        add("yearlyAbsReturn", year.absReturn);
        add("yearlyAlphaReturn", year.alphaReturn);
        add("yearlyAlphaMaxDrawdown", year.alphaMaxDrawdown);
      }
    } else {
      add("recentAbsReturn", row.recentAbsReturn);
      add("recentAlphaReturn", row.recentAlphaReturn);
      add("recentAlphaMaxDrawdown", row.recentAlphaMaxDrawdown);
      add(
        "historyAlphaMaxDrawdownExclRecent",
        row.historyAlphaMaxDrawdownExclRecent,
      );
    }
  }
  const distributions = Object.fromEntries(
    Object.entries(metrics).map(([key, values]) => {
      const sorted = values
        .flatMap((v) => (v.value === null ? [] : [v.value]))
        .sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      return [
        key,
        {
          available: sorted.length,
          unavailable: values.length - sorted.length,
          min: sorted[0] ?? null,
          median: sorted.length
            ? sorted.length % 2
              ? sorted[middle]!
              : sorted[middle - 1]! / 2 + sorted[middle]! / 2
            : null,
          max: sorted.at(-1) ?? null,
          unavailableReasons: [
            ...new Set(values.flatMap((v) => (v.reason ? [v.reason] : []))),
          ],
        },
      ];
    }),
  );
  return {
    version: "u8-calibration-distribution-1",
    scope: "A 股",
    calibrationStatus: "未标定",
    thresholdDecision: "未获管理者确认；不自动调整阈值，不解除页面限制",
    source:
      "复用 tests/e3-browser-fixture.ts 与 tests/research-worker.test.ts 的合成双突破样本；tests/fixtures/breakout-valid.json + 同样10日续接；无真实账户数据",
    limitation:
      "仅开发期8日、验证期4日，两期独立，样本不代表市场分布；完整年和剔除252日近期后的历史段均不足。null 不补零，不能据此标定账户阈值。",
    datasetHash: dataset.hash,
    resultHash: result.hash,
    params: defaultAdmissionParams,
    distributions,
    inputs,
    results,
  };
}

// 固定一个可复现报告文件；显式执行覆盖该文件，无数据库、临时目录或累积档案。
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const report = await admissionCalibrationDistribution();
  const target = resolve("docs/review/u8-calibration-distribution.json");
  await writeFile(
    target,
    await format(JSON.stringify(report), { parser: "json" }),
    "utf8",
  );
  console.log(
    JSON.stringify({ target, distributions: report.distributions }, null, 2),
  );
}
