import { pathToFileURL } from "node:url";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { format } from "prettier";
import {
  strategyAdmission,
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

/** Account calibration requires an explicit exported input and an external output. */
export function calibrationPaths(
  argv: readonly string[],
  root = process.cwd(),
) {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i],
      value = argv[i + 1];
    if (
      !key ||
      !["--from", "--out"].includes(key) ||
      !value ||
      value.startsWith("--") ||
      args.has(key)
    )
      throw new Error(
        "用法：--from <账户准入导出.json> --out <仓库外分布.json>",
      );
    args.set(key, value);
  }
  if (!args.has("--from") || !args.has("--out"))
    throw new Error("必须同时指定 --from 和 --out；旧样本研究合成报告已移除");
  const from = resolve(root, args.get("--from")!);
  const target = resolve(root, args.get("--out")!);
  const rel = relative(resolve(root), target);
  if (!(isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep)))
    throw new Error("--out 必须指向仓库外，账户派生数据不进版本库");
  if (relative(from, target) === "")
    throw new Error("输出不能覆盖输入导出文件");
  return { from, target };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { from, target } = calibrationPaths(process.argv.slice(2));
  const report = await admissionCalibrationFromExport(from);
  await writeFile(
    target,
    await format(JSON.stringify(report), { parser: "json" }),
    "utf8",
  );
  console.log(
    JSON.stringify({ target, distributions: report.distributions }, null, 2),
  );
}
