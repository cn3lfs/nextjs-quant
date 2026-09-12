import { z } from "zod";
import {
  admissionParamsSchema,
  strategyAdmission,
  type StrategyAdmissionInput,
} from "~/lib/strategy-admission";
import type { ResearchDataset } from "./research-dataset";
import type { ResearchResult } from "./research-store";
import type { replayTradeReview } from "./trade-review-service";
import { researchDailyReturns } from "./period-performance-service";

export const admissionPageSchema = z.object({
  params: admissionParamsSchema.default({}),
  pageIndex: z.number().int().min(0).max(1000000).default(0),
  pageSize: z.number().int().min(1).max(100).default(10),
  sort: z
    .enum([
      "year",
      "tradingDays",
      "absReturn",
      "alphaReturn",
      "alphaMaxDrawdown",
    ])
    .default("year"),
  desc: z.boolean().default(false),
});
export type AdmissionPageInput = z.infer<typeof admissionPageSchema>;
type AdmissionSource = {
  input: Omit<StrategyAdmissionInput, "mode" | "params">;
  note: string;
};

/** 基准日收益按日历前一交易日配对，缺价不跨日、不补首日零收益。 */
export function admissionBenchmarkReturns(
  dates: readonly string[],
  calendar: readonly string[],
  bars: readonly { date: string; close: number }[],
) {
  const indices = new Map(calendar.map((date, i) => [date, i]));
  if (
    indices.size !== calendar.length ||
    calendar.some((date, i) => i > 0 && date <= calendar[i - 1]!)
  )
    throw new Error("基准交易日历必须严格升序且不重复");
  const prices = new Map(bars.map((bar) => [bar.date, bar.close]));
  if (
    prices.size !== bars.length ||
    bars.some((bar) => !Number.isFinite(bar.close) || bar.close <= 0)
  )
    throw new Error("基准价格必须唯一、正且有限");
  return dates.map((date) => {
    const index = indices.get(date);
    if (index === undefined) throw new Error("判定日期不在基准交易日历内");
    const previousDate = calendar[index - 1];
    const previous = previousDate ? prices.get(previousDate) : undefined;
    const current = prices.get(date);
    if (previous === undefined || current === undefined) return null;
    const value = current / previous - 1;
    if (!Number.isFinite(value)) throw new Error("基准日收益溢出");
    return value;
  });
}

export function tradeReviewAdmissionSource(
  snapshot: ReturnType<typeof replayTradeReview>,
  calendar: readonly string[] = snapshot.replayInput.nav.tradingDays,
): AdmissionSource {
  const dates = snapshot.nav.days.map((day) => day.date);
  return {
    input: {
      dates,
      strategyDaily: snapshot.nav.days.map((day) => day.dailyReturn.value),
      benchDaily: admissionBenchmarkReturns(
        dates,
        calendar,
        snapshot.replayInput.nav.benchmark ?? [],
      ),
      evidenceLevel: "真实账户交割单",
    },
    note: "账户日收益沿用日度 TWR，基准沿用复盘快照指数（默认沪深300）。真实账户交割单仅标记来源，不代表估值/现金流已独立核对；缺失不拼接、不补零。",
  };
}

export function researchAdmissionSource(
  result: ResearchResult,
  dataset: ResearchDataset,
  partition: "development" | "validation",
): AdmissionSource {
  const dates = dataset.calendar.filter(
    (date) =>
      date >= result.spec.start &&
      date <= result.spec.end &&
      (partition === "development"
        ? date < result.spec.validationStart
        : date >= result.spec.validationStart),
  );
  return {
    input: {
      dates,
      strategyDaily: researchDailyReturns(result, partition, dates),
      benchDaily: admissionBenchmarkReturns(
        dates,
        dataset.calendar,
        dataset.benchmark.bars,
      ),
      // 任务书 §3.4 与事实不符：E3 没有 evidenceLevel 枚举；沿用其警示口径，
      // 不从自由文本猜测“合成”或把外部条件导入视为独立核验。
      evidenceLevel: "本地模拟未独立核验",
    },
    note: `${partition === "development" ? "开发期" : "保留验证期"}独立判定；基准 ${dataset.benchmark.symbol}，来自冻结快照 ${result.datasetHash}。不拼接两期本金，不使用事件收益替代模拟净值。`,
  };
}

export function exportStrategyAdmission(
  source: AdmissionSource,
  params: AdmissionPageInput["params"],
  includeRecent: boolean,
) {
  // JSON 不能保留 NaN/Inf，拒绝导出而不是被 JSON.stringify 静默转成 null。
  if (
    [
      source.input.strategyDaily,
      source.input.longDaily ?? source.input.strategyDaily,
      source.input.benchDaily,
    ].some((series) =>
      series.some((value) => value !== null && !Number.isFinite(value)),
    )
  )
    throw new Error("日收益含 NaN/Inf，无法生成可独立重放的 JSON");
  const inputs = (
    includeRecent ? (["history", "recent"] as const) : (["history"] as const)
  ).map((mode) => ({
    ...source.input,
    mode,
    params: admissionParamsSchema.parse(params),
  }));
  return {
    version: "strategy-admission-export-1" as const,
    calibrationStatus: "未标定" as const,
    thresholdSource:
      "wbt 默认值，未针对本账户标定；自定义参数仅作观察，不代表已标定",
    note: source.note,
    inputs,
    results: inputs.map(strategyAdmission),
  };
}

export function pageStrategyAdmission(
  source: AdmissionSource,
  page: AdmissionPageInput,
  includeRecent: boolean,
) {
  const exported = exportStrategyAdmission(source, page.params, includeRecent);
  const history = exported.results.find((result) => result.mode === "history")!;
  const { yearlyMetrics, ...summary } = history;
  const sorted = [...yearlyMetrics].sort((a, b) => {
    const x = a[page.sort],
      y = b[page.sort];
    const av = typeof x === "object" ? x.value : x;
    const bv = typeof y === "object" ? y.value : y;
    if (av === null || bv === null)
      return av === bv ? a.year.localeCompare(b.year) : av === null ? 1 : -1;
    const order =
      typeof av === "number" && typeof bv === "number"
        ? av - bv
        : String(av).localeCompare(String(bv));
    return (page.desc ? -order : order) || a.year.localeCompare(b.year);
  });
  return {
    history: summary,
    recent: exported.results.find((result) => result.mode === "recent") ?? null,
    yearly: {
      rows: sorted.slice(
        page.pageIndex * page.pageSize,
        (page.pageIndex + 1) * page.pageSize,
      ),
      rowCount: sorted.length,
    },
    note: exported.note,
    thresholdSource: exported.thresholdSource,
    calibrationStatus: exported.calibrationStatus,
  };
}
