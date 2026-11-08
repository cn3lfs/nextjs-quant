import {
  createPerformanceReport,
  queryPerformanceReport,
  type PerformanceReportSelection,
  type PerformancePoint,
} from "quant-performance";
import type { MaBaselineArchive } from "../backtest/ma-baseline-work";

/** Reconstruct the passive price comparison only from this experiment's frozen bars. */
export function archivePerformancePoints(
  archive: MaBaselineArchive,
): PerformancePoint[] {
  const equity = archive.result.equity;
  const bars = archive.inputSnapshot?.bars;
  if (!bars?.length) return equity.map((point) => ({ ...point }));
  const daily = new Map<string, { open: number; close: number }>();
  let previousBar = "";
  for (const bar of bars) {
    const day = bar.date.slice(0, 10);
    if (day < archive.result.input.start || day > archive.result.input.end)
      continue;
    if (
      bar.date <= previousBar ||
      !Number.isFinite(bar.open) ||
      bar.open <= 0 ||
      !Number.isFinite(bar.close) ||
      bar.close <= 0
    )
      throw new Error("冻结持有对照行情无效或日期重复");
    previousBar = bar.date;
    const row = daily.get(day);
    daily.set(day, { open: row?.open ?? bar.open, close: bar.close });
  }
  if (
    [...daily.keys()].join(",") !== equity.map((point) => point.date).join(",")
  )
    throw new Error("冻结持有对照与日净值日期不一致，不能取交集计算");
  let previousClose = daily.values().next().value?.open ?? 0;
  return equity.map((point) => {
    const close = daily.get(point.date)!.close;
    const benchmarkReturn = close / previousClose - 1;
    previousClose = close;
    return { ...point, benchmarkReturn };
  });
}

export function exportPerformanceEvaluation(archive: MaBaselineArchive) {
  const points = archivePerformancePoints(archive);
  const initial = archive.result.input.initial;
  return {
    ...createPerformanceReport(initial, points),
    basis: {
      yearlyDays: 252,
      annualRiskFreeRate: 0.02,
      standardDeviation: "sample" as const,
      benchmark: "同标的价格持有对照（不含费用、分红）",
      dataHash: archive.manifest.dataHash,
      quality: archive.result.quality,
    },
  };
}

export function queryPerformanceEvaluation(
  archive: MaBaselineArchive,
  input: PerformanceReportSelection,
) {
  const points = archivePerformancePoints(archive);
  return queryPerformanceReport(archive.result.input.initial, points, input);
}
