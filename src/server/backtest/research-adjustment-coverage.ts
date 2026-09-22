import type { Bar } from "~/lib/domain";
import {
  adjustmentFactors,
  applyAdjustment,
  applyAdjustmentByDate,
  applyVolumeRatios,
  applyVolumeRatiosByDate,
  deriveVolumeRatios,
  type AdjustFactor,
} from "../data-sources/tdx/tdx-gbbq";
import type { ResearchDataset } from "./research-dataset";

export type ResearchAdjustedCoverage = {
  status: "available" | "missing";
  reason: string | null;
  factors: AdjustFactor[];
  bars: Bar[];
  minuteBars: Bar[];
  /**
   * Volume comparability is a *separate* verdict from price coverage: a
   * complete price-factor prefix says nothing about whether raw volume before
   * and after a share-count change can be compared. "missing" here therefore
   * does not invalidate `bars`; only volume-reading strategies must refuse it.
   */
  volumeCoverage: "available" | "missing";
  volumeReason: string | null;
  /** The bar whose share count is the comparability basis; never "today". */
  volumeReferenceDate: string | null;
  /** Price-adjusted bars whose volume is additionally restated onto
   * `volumeReferenceDate`'s share-count basis. Empty when volumeCoverage is
   * "missing". */
  volumeAdjustedBars: Bar[];
  volumeAdjustedMinuteBars: Bar[];
};

function validBar(bar: Bar) {
  return [bar.open, bar.high, bar.low, bar.close].every(
    (value) => Number.isFinite(value) && value > 0,
  );
}

/**
 * Signal prices must have a complete, locally-derived GBBQ factor series.
 * There is deliberately no fallback to the last/current factor: an absent
 * prefix remains missing so that historical coverage cannot be invented.
 */
function missingCoverage(reason: string): ResearchAdjustedCoverage {
  return {
    status: "missing",
    reason,
    factors: [],
    bars: [],
    minuteBars: [],
    volumeCoverage: "missing",
    volumeReason: reason,
    volumeReferenceDate: null,
    volumeAdjustedBars: [],
    volumeAdjustedMinuteBars: [],
  };
}

export function prepareResearchAdjustedCoverage(
  stock: ResearchDataset["stocks"][number],
  actionCoverage: ResearchDataset["actionCoverage"],
): ResearchAdjustedCoverage {
  if (actionCoverage === "missing")
    return missingCoverage("复权来源缺失，无法生成完整历史复权覆盖");
  try {
    const factors = adjustmentFactors(stock.bars, stock.actions);
    if (
      factors.length !== stock.bars.length ||
      factors.some(
        (factor, index) =>
          factor.date !== stock.bars[index]?.date ||
          !Number.isFinite(factor.factor) ||
          factor.factor <= 0,
      )
    )
      throw new Error("复权因子缺失或未与日线逐条对齐");
    const bars = applyAdjustment(stock.bars, factors, "backward");
    if (bars.some((bar) => !validBar(bar)))
      throw new Error("复权日线含非法价格");
    const minuteBars = stock.minuteBars
      ? applyAdjustmentByDate(stock.minuteBars, factors, "backward")
      : [];
    if (minuteBars.some((bar) => !validBar(bar)))
      throw new Error("复权五分钟线含非法价格");
    // Volume comparability is derived from the raw (unadjusted) bar dates and
    // the same GBBQ events; a failure here leaves price coverage intact
    // because price adjustment and share-count restatement are independent
    // claims, and only volume-reading strategies depend on the latter.
    const volume = deriveVolumeRatios(stock.bars, stock.actions);
    const volumeAvailable = volume.status === "available";
    return {
      status: "available",
      reason: null,
      factors,
      bars,
      minuteBars,
      volumeCoverage: volume.status,
      volumeReason: volume.reason,
      volumeReferenceDate: volume.referenceDate,
      volumeAdjustedBars: volumeAvailable
        ? applyVolumeRatios(bars, volume.ratios)
        : [],
      volumeAdjustedMinuteBars:
        volumeAvailable && minuteBars.length > 0
          ? applyVolumeRatiosByDate(
              minuteBars,
              factors.map((factor) => factor.date),
              volume.ratios,
            )
          : [],
    };
  } catch (error) {
    return missingCoverage(
      error instanceof Error ? error.message : "复权覆盖校验失败",
    );
  }
}
