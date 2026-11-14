import { chartColor } from "~/lib/chart/chart-theme";
import type { IndicatorName } from "~/lib/chart/chart-data";
import type { Subchart } from "~/lib/chart/chart-view";
export const colors: Record<IndicatorName, string> = {
  MA5: chartColor.series1,
  MA10: chartColor.series2,
  MA20: chartColor.series3,
  MA60: chartColor.series4,
  BOLL中: chartColor.muted,
  BOLL上: chartColor.series1,
  BOLL下: chartColor.series1,
  DIF: chartColor.series1,
  DEA: chartColor.series2,
  MACD: chartColor.up,
  K: chartColor.series1,
  D: chartColor.series2,
  J: chartColor.series3,
  RSI6: chartColor.series1,
  RSI12: chartColor.series2,
  RSI24: chartColor.series3,
  EMA1: chartColor.series1,
  EMA2: chartColor.series2,
  EMA3: chartColor.series3,
  WR1: chartColor.series1,
  WR2: chartColor.series2,
  BIAS1: chartColor.series1,
  BIAS2: chartColor.series2,
  BIAS3: chartColor.series3,
  CCI: chartColor.series1,
  OBV: chartColor.series2,
};
export const rpsColors: Record<number, string> = {
  1: chartColor.series4,
  3: chartColor.accentLight,
  5: chartColor.up,
  10: chartColor.down,
  20: chartColor.muted,
  50: chartColor.series1,
  120: chartColor.series2,
};
export const subchartOf = (name: IndicatorName): Subchart | "main" =>
  name.startsWith("MA") || name.startsWith("EMA") || name.startsWith("BOLL")
    ? "main"
    : name === "DIF" || name === "DEA" || name === "MACD"
      ? "macd"
      : name === "K" || name === "D" || name === "J"
        ? "kdj"
        : name.startsWith("RSI")
          ? "rsi"
          : name.startsWith("WR")
            ? "wr"
            : name.startsWith("BIAS")
              ? "bias"
              : name === "CCI"
                ? "cci"
                : "obv";
// Theme categorical colours, distinct from the MA/structure lines.
export const compareColors = [
  chartColor.series3,
  chartColor.series4,
  chartColor.accentLight,
] as const;
