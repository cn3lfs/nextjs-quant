import { z } from "zod";
import { dailyPerformance } from "../backtest/daily-performance";
import type { ReviewValue } from "../portfolio/trade-review";

export const admissionModes = ["history", "recent"] as const;
export const admissionEvidenceLevels = [
  "合成/受控样本",
  "本地模拟未独立核验",
  "真实账户交割单",
] as const;
export type AdmissionEvidenceLevel = (typeof admissionEvidenceLevels)[number];
export const admissionParamsSchema = z
  .object({
    targetVol: z.number().finite().positive().default(0.2),
    maxDdThreshold: z.number().finite().nonnegative().default(0.2),
    maxAlphaDdThreshold: z.number().finite().nonnegative().default(0.3),
    minFullSharpe: z.number().finite().default(0.5),
    minYearDays: z.number().int().positive().default(200),
    recentDays: z.number().int().positive().default(252),
    minHistoryDays: z.number().int().nonnegative().default(60),
    yearlyDays: z
      .number()
      .finite()
      .positive()
      .default(
        dailyPerformance({
          returns: [],
          basis: "simple",
          annualRiskFreeRate: 0,
        }).yearlyDays,
      ),
  })
  .strict();
export type AdmissionParams = z.infer<typeof admissionParamsSchema>;
export const defaultAdmissionParams = admissionParamsSchema.parse({});
export type StrategyAdmissionInput = {
  dates: readonly string[];
  strategyDaily: readonly (number | null)[];
  longDaily?: readonly (number | null)[];
  benchDaily: readonly (number | null)[];
  evidenceLevel: AdmissionEvidenceLevel;
  mode: (typeof admissionModes)[number];
  params?: Partial<AdmissionParams>;
};
const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((date) => {
    const time = Date.parse(date);
    return (
      Number.isFinite(time) &&
      new Date(time).toISOString().slice(0, 10) === date
    );
  }, "日期无效");
// §2.1 明确将非有限收益定义为 alpha 退化；它是唯一领域特判，
// 日期、长度、类型、模式和所有非有限参数仍抛错，不静默回退。
const seriesSchema = z.array(z.union([z.number(), z.nan()]).nullable());
const unavailable = (reason: string): ReviewValue => ({ value: null, reason });
const above = (v: ReviewValue, threshold: number) =>
  v.value !== null && v.value > threshold;
const below = (v: ReviewValue, threshold: number) =>
  v.value !== null && v.value < threshold;

/** U8 §3.2：所有收益、波动率、回撤与夏普只委托 U1；这里只组织条件。 */
export function strategyAdmission(input: StrategyAdmissionInput) {
  const params = admissionParamsSchema.parse(
    input.params === undefined ? {} : input.params,
  );
  z.enum(admissionModes).parse(input.mode);
  z.enum(admissionEvidenceLevels).parse(input.evidenceLevel);
  z.array(dateSchema).parse(input.dates);
  if (input.dates.some((d, i) => i > 0 && d <= input.dates[i - 1]!))
    throw new Error("日期必须严格升序且不重复");
  const long =
    input.longDaily === undefined ? input.strategyDaily : input.longDaily;
  for (const series of [input.strategyDaily, long, input.benchDaily]) {
    seriesSchema.parse(series);
    if (series.length !== input.dates.length)
      throw new Error("日期与收益序列长度不一致");
  }
  const stats = (returns: readonly (number | null)[]) =>
    dailyPerformance({
      returns,
      basis: "simple",
      annualRiskFreeRate: 0,
      yearlyDays: params.yearlyDays,
    });
  const nonFinite = (series: readonly (number | null)[]) =>
    series.some((v) => v !== null && !Number.isFinite(v));
  const longVol = nonFinite(long)
    ? unavailable("多头日收益含 NaN/Inf")
    : stats(long).annualVolatility;
  const benchVol = nonFinite(input.benchDaily)
    ? unavailable("基准日收益含 NaN/Inf")
    : stats(input.benchDaily).annualVolatility;
  const hasMissing = long.includes(null) || input.benchDaily.includes(null);
  let alphaDegenerate =
    hasMissing ||
    nonFinite(input.strategyDaily) ||
    [longVol, benchVol].some(
      (v) => v.value === null || !Number.isFinite(v.value) || v.value < 1e-12,
    );
  // 全样本只求一次 scale；recent 两段绝不能各自重新缩放。
  let alpha = alphaDegenerate
    ? []
    : long.map(
        (r, i) =>
          r! * (params.targetVol / longVol.value!) -
          input.benchDaily[i]! * (params.targetVol / benchVol.value!),
      );
  alphaDegenerate ||= alpha.some((v) => !Number.isFinite(v));
  if (alphaDegenerate) alpha = [];
  const alphaReason = hasMissing
    ? "多头或基准日收益缺失，不能认定完整超额路径"
    : "alpha 退化：含 NaN/Inf、波动率不足或数值溢出";
  const window = (start: number, end: number) => {
    const absolute = input.strategyDaily.slice(start, end);
    const a = stats(alpha.slice(start, end));
    const absReturn =
      absolute.includes(null) || nonFinite(absolute)
        ? unavailable("策略日收益缺失或含 NaN/Inf")
        : stats(absolute).totalReturn;
    const alphaReturn = alphaDegenerate
      ? unavailable(alphaReason)
      : a.totalReturn;
    const alphaMaxDrawdown = alphaDegenerate
      ? unavailable(alphaReason)
      : a.maxDrawdown;
    const alphaSharpe = alphaDegenerate
      ? unavailable(alphaReason)
      : a.sharpeWbt;
    const condAbsReturnPassed = above(absReturn, 0);
    const condAlphaReturnPassed = above(alphaReturn, 0);
    const condAlphaDrawdownPassed = below(
      alphaMaxDrawdown,
      params.maxDdThreshold,
    );
    return {
      absReturn,
      alphaReturn,
      alphaMaxDrawdown,
      alphaSharpe,
      condAbsReturnPassed,
      condAlphaReturnPassed,
      condAlphaDrawdownPassed,
      returnPassed:
        condAbsReturnPassed || condAlphaReturnPassed || condAlphaDrawdownPassed,
    };
  };
  const reasons: string[] = [];
  if (alphaDegenerate) reasons.push(alphaReason);
  const common = {
    version: "strategy-admission-1" as const,
    basis: "simple" as const,
    annualRiskFreeRate: 0 as const,
    params,
    evidenceLevel: input.evidenceLevel,
    longIsStrategy:
      input.longDaily === undefined ||
      long.every((v, i) => v === input.strategyDaily[i]),
    alphaDegenerate,
    longAnnualVolatility: longVol,
    benchAnnualVolatility: benchVol,
    longScale: alphaDegenerate
      ? unavailable(alphaReason)
      : { value: params.targetVol / longVol.value!, reason: null },
    benchScale: alphaDegenerate
      ? unavailable(alphaReason)
      : { value: params.targetVol / benchVol.value!, reason: null },
    coverage: {
      observedDays: input.dates.length,
      strategyMissingDays: input.strategyDaily.filter((v) => v === null).length,
      longMissingDays: long.filter((v) => v === null).length,
      benchMissingDays: input.benchDaily.filter((v) => v === null).length,
    },
  };
  if (input.mode === "history") {
    const years = [...new Set(input.dates.map((date) => date.slice(0, 4)))];
    const yearlyMetrics = years.map((year) => {
      const start = input.dates.findIndex((date) => date.startsWith(year));
      const tradingDays = input.dates.filter((date) =>
        date.startsWith(year),
      ).length;
      const metrics = window(start, start + tradingDays);
      return {
        year,
        tradingDays,
        isCompleteYear: tradingDays >= params.minYearDays,
        ...metrics,
        yearPassed: metrics.returnPassed,
      };
    });
    const complete = yearlyMetrics.filter((year) => year.isCompleteYear);
    const full = window(0, input.dates.length);
    const condYearsPassed =
      complete.length > 0 && complete.every((year) => year.yearPassed);
    // §2.2 不对称边界：回撤等于阈值通过，Sharpe 等于阈值失败。
    const condAlphaDrawdownPassed =
      full.alphaMaxDrawdown.value !== null &&
      full.alphaMaxDrawdown.value <= params.maxAlphaDdThreshold;
    const condSharpePassed = above(full.alphaSharpe, params.minFullSharpe);
    if (!complete.length)
      reasons.push("no complete year：没有达到交易日数门槛的自然年");
    for (const year of complete.filter((year) => !year.yearPassed))
      reasons.push(`${year.year} 年收益侧三路均未通过`);
    if (!condAlphaDrawdownPassed)
      reasons.push("全样本超额最大回撤未满足 ≤ 阈值");
    if (!condSharpePassed) reasons.push("全样本超额 Sharpe 未满足 > 阈值");
    return {
      ...common,
      mode: "history" as const,
      yearlyMetrics,
      completeYearCount: complete.length,
      historyAlphaMaxDrawdown: full.alphaMaxDrawdown,
      historyAlphaSharpe: full.alphaSharpe,
      condYearsPassed,
      condAlphaDrawdownPassed,
      condSharpePassed,
      isGood:
        !alphaDegenerate &&
        condYearsPassed &&
        condAlphaDrawdownPassed &&
        condSharpePassed,
      reasons: reasons as readonly string[],
    };
  }
  const start = Math.max(0, input.dates.length - params.recentDays);
  const recent = window(start, input.dates.length);
  const historyWindowEmpty = start === 0 || start < params.minHistoryDays;
  const historyAlphaMaxDrawdownExclRecent = historyWindowEmpty
    ? unavailable("剔除近期窗口后的历史段为空或不足最少交易日")
    : window(0, start).alphaMaxDrawdown;
  const condReturnPassed = recent.returnPassed;
  const condImprovementPassed =
    recent.alphaMaxDrawdown.value !== null &&
    historyAlphaMaxDrawdownExclRecent.value !== null &&
    recent.alphaMaxDrawdown.value < historyAlphaMaxDrawdownExclRecent.value;
  if (historyWindowEmpty) reasons.push("剔除近期窗口后的历史段为空或过短");
  if (!condReturnPassed) reasons.push("近期收益侧三路均未通过");
  if (!condImprovementPassed)
    reasons.push("近期超额最大回撤未严格小于错开窗口的历史回撤");
  return {
    ...common,
    mode: "recent" as const,
    recentStartDate: input.dates[start] ?? null,
    recentEndDate: input.dates.at(-1) ?? null,
    recentActualDays: input.dates.length - start,
    recentAbsReturn: recent.absReturn,
    recentAlphaReturn: recent.alphaReturn,
    recentAlphaMaxDrawdown: recent.alphaMaxDrawdown,
    condAbsReturnPassed: recent.condAbsReturnPassed,
    condAlphaReturnPassed: recent.condAlphaReturnPassed,
    condAlphaDrawdownPassed: recent.condAlphaDrawdownPassed,
    historyAlphaMaxDrawdownExclRecent,
    historyWindowEmpty,
    condReturnPassed,
    condImprovementPassed,
    isGood:
      !alphaDegenerate &&
      !historyWindowEmpty &&
      condReturnPassed &&
      condImprovementPassed,
    reasons: reasons as readonly string[],
  };
}
export type StrategyAdmission = ReturnType<typeof strategyAdmission>;

/** 阈值口径：**行业通行值，未按本账户标定**（2026-09-12 用户决定，见 decisions.md）。
 *
 * 默认值没有改动，因为它们本身就是通行值——关键在 `minFullSharpe` 作用于
 * 波动率归一后的超额序列，那是**信息比率**而非夏普，0.5 正是 Grinold–Kahn
 * 分级里的「合格」线（0.75 很好、1.0 卓越）。在没有本账户分布的情况下
 * 调整数字只是假精确。
 *
 * 因此结论可以显示，但**必须带出处**：通行口径下的通过不等于
 * 「这套阈值适合这个账户」，更不等于策略赚钱。证据级别不是真实账户时
 * 进一步降格为「在该数据前提下」。
 */
export function admissionConclusion(
  result: Pick<StrategyAdmission, "isGood" | "evidenceLevel">,
) {
  const verdict = result.isGood ? "通过" : "未通过";
  return result.evidenceLevel === "真实账户交割单"
    ? `${verdict}（行业通行口径，未按本账户标定）`
    : `${verdict}（在该数据前提下；行业通行口径，未按本账户标定）`;
}
