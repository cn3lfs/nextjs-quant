import type { Bar } from "~/lib/domain";
import {
  adjustmentFactors,
  applyAdjustment,
  applyAdjustmentByDate,
  type AdjustFactor,
} from "./tdx-gbbq";
import type { ResearchDataset } from "./research-dataset";

export type ResearchAdjustedCoverage = {
  status: "available" | "missing";
  reason: string | null;
  factors: AdjustFactor[];
  bars: Bar[];
  minuteBars: Bar[];
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
export function prepareResearchAdjustedCoverage(
  stock: ResearchDataset["stocks"][number],
  actionCoverage: ResearchDataset["actionCoverage"],
): ResearchAdjustedCoverage {
  if (actionCoverage === "missing")
    return {
      status: "missing",
      reason: "复权来源缺失，无法生成完整历史复权覆盖",
      factors: [],
      bars: [],
      minuteBars: [],
    };
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
    return {
      status: "available",
      reason: null,
      factors,
      bars,
      minuteBars,
    };
  } catch (error) {
    return {
      status: "missing",
      reason: error instanceof Error ? error.message : "复权覆盖校验失败",
      factors: [],
      bars: [],
      minuteBars: [],
    };
  }
}
