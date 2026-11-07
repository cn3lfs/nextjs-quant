import { ma, ema, macd } from "../indicators.js";
import {
  periodParameter,
  positiveValue,
  ratio,
  type FactorDefinition,
} from "./model.js";

function macdFactor(line: "dif" | "dea" | "macd"): FactorDefinition {
  return {
    label: `MACD ${line === "macd" ? "柱" : line.toUpperCase()}`,
    category: "趋势",
    unit: "价格",
    description: "DIF=EMA快−EMA慢，DEA=EMA(DIF)，柱=2×(DIF−DEA)。",
    parameters: {
      fast: periodParameter(12),
      slow: periodParameter(26),
      signal: periodParameter(9),
    },
    lookback: (p: Record<string, number>) => p.slow! + p.signal! - 2,
    calculate: (bars, p) =>
      macd(bars, p.fast!, p.slow!, p.signal!).map((v) => v[line]),
  };
}

export const trendFactors = {
  close: {
    label: "收盘价",
    category: "趋势",
    unit: "价格",
    description: "当前已完成行情的收盘价。",
    parameters: {},
    lookback: () => 0,
    calculate: (bars) => bars.map((b) => positiveValue(b.close)),
  },
  sma: {
    label: "简单均线 MA",
    category: "趋势",
    unit: "价格",
    description: "完整 N 根收盘价的算术均值。",
    parameters: { period: periodParameter(20) },
    lookback: (p) => p.period! - 1,
    calculate: (bars, p) => ma(bars, p.period!),
  },
  ema: {
    label: "指数均线 EMA",
    category: "趋势",
    unit: "价格",
    description: "首个有效收盘价初始化；以冻结输入为递推起点。",
    parameters: { period: periodParameter(20) },
    lookback: (p) => p.period! - 1,
    calculate: (bars, p) => ema(bars, p.period!),
  },
  bias: {
    label: "均线偏离 BIAS",
    category: "趋势",
    unit: "%",
    description: "(收盘价 / MA(N) − 1) × 100。",
    parameters: { period: periodParameter(20) },
    lookback: (p) => p.period! - 1,
    calculate: (bars, p) =>
      ma(bars, p.period!).map((v, i) => {
        const value = ratio(positiveValue(bars[i]!.close), v, 100);
        return value === null ? null : value - 100;
      }),
  },
  "macd-dif": macdFactor("dif"),
  "macd-dea": macdFactor("dea"),
  "macd-macd": macdFactor("macd"),
} satisfies Record<string, FactorDefinition>;
