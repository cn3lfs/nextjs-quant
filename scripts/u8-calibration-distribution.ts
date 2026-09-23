import { pathToFileURL } from "node:url";
import { isAbsolute, relative, resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { format } from "prettier";
import { admissionResearchFixture } from "../tests/strategy-admission-fixture";
import { researchAdmissionSource } from "../src/server/research/performance/strategy-admission-service";
import {
  strategyAdmission,
  defaultAdmissionParams,
  type StrategyAdmissionInput,
} from "../src/lib/strategy-facts/strategy-admission";
import type { ReviewValue } from "../src/lib/portfolio/trade-review";

type AdmissionResult = ReturnType<typeof strategyAdmission>;

/** 把一批判定结果压成每项指标的 min/中位数/max。null 不补零，单独计数并保留原因。 */
export function summarizeDistributions(results: readonly AdmissionResult[]) {
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
  return Object.fromEntries(
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
}

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
  const distributions = summarizeDistributions(results);
  return {
    version: "u8-calibration-distribution-1",
    scope: "A 股",
    calibrationStatus: "未标定",
    thresholdDecision: "未获管理者确认；不自动调整阈值，不解除页面限制",
    source:
      "复用 tests/e3-browser-fixture.ts 与 tests/research-backtest/research-worker.test.ts 的合成双突破样本；tests/fixtures/breakout-valid.json + 同样10日续接；无真实账户数据",
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

/** 从页面导出的 `strategy-admission-export-1` JSON 还原分布。
 *
 * 脚本**不连数据库**：真实账户数据由 `/trade-review` 的准入卡片导出成文件后喂进来，
 * 所以标定不需要给脚本生产库权限，也不会误改任何账户记录。
 * 导出里带完整 `inputs`，这里**重放**它们而不是采信文件里的 `results`——
 * 否则一份手改过的导出就能凭空产生一组「分布」。
 */
export async function admissionCalibrationFromExport(path: string) {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== "strategy-admission-export-1"
  )
    throw new Error(
      `${path} 不是 strategy-admission-export-1 导出；请用 /trade-review 准入卡片的「导出」按钮生成`,
    );
  const inputs = (parsed as { inputs?: unknown }).inputs;
  if (!Array.isArray(inputs) || !inputs.length)
    throw new Error(`${path} 缺少 inputs，无法重放判定`);
  const replayed = (inputs as StrategyAdmissionInput[]).map(strategyAdmission);
  return {
    version: "u8-calibration-distribution-1" as const,
    scope: "A 股",
    calibrationStatus: "未标定" as const,
    thresholdDecision:
      "本报告只给分布，不给建议阈值；阈值由管理者判断后写入 decisions.md，页面才解除限制",
    source: `重放 ${path} 的 inputs（导出自应用，未采信其中 results）`,
    evidenceLevel: [
      ...new Set(
        (inputs as StrategyAdmissionInput[]).map((i) => i.evidenceLevel),
      ),
    ],
    limitation:
      "分布只描述这一份样本；换账户、换区间或换市场都必须重新标定。BTC/贵金属/外汇的波动率量级与 A 股不同，不可沿用本组阈值。",
    params: (inputs as StrategyAdmissionInput[])[0]!.params,
    // 只输出聚合分布，不回写日收益序列：那是账户级私有数据。
    distributions: summarizeDistributions(replayed),
  };
}

// 固定一个可复现报告文件；显式执行覆盖该文件，无数据库、临时目录或累积档案。
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const argv = process.argv.slice(2);
  const arg = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const from = arg("--from");
  const fallback = "docs/review/u8-calibration-distribution.json";
  const target = resolve(arg("--out") ?? fallback);
  // 先校验落点再读账户数据：护栏放到计算之后就形同虚设。
  // 真实账户导出派生的分布不得落进被 git 跟踪的目录，那是账户私有数据。
  if (from && !arg("--out"))
    throw new Error(
      `--from 必须同时给 --out，且指向仓库外的路径；${fallback} 是合成样本报告，不能被账户数据覆盖`,
    );
  // 跨盘符时 relative() 返回绝对路径（D:\repo → C:\Users\… 得到 C:\Users\…），
  // 它不以 ".." 开头，只判前缀会把仓库外的合法路径误当成仓库内。
  const rel = relative(resolve("."), target);
  if (from && rel !== "" && !rel.startsWith("..") && !isAbsolute(rel))
    throw new Error(
      `--out 指向仓库内 (${target})，账户派生数据不进版本库；请写到仓库外，例如 %USERPROFILE%\\Documents`,
    );
  const report = from
    ? await admissionCalibrationFromExport(resolve(from))
    : await admissionCalibrationDistribution();
  await writeFile(
    target,
    await format(JSON.stringify(report), { parser: "json" }),
    "utf8",
  );
  console.log(
    JSON.stringify({ target, distributions: report.distributions }, null, 2),
  );
}
