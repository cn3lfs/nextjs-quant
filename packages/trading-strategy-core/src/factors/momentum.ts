import { rsi, kdj } from "../indicators.js";
import {
  periodParameter,
  positiveValue,
  ratio,
  type FactorDefinition,
} from "./model.js";

function kdjFactor(line: "k" | "d" | "j"): FactorDefinition {
  return {
    label: `KDJ ${line.toUpperCase()}`,
    category: "动量",
    unit: "指数",
    description: "复用共享 KDJ，无人工 50 初值；零振幅保持递推状态。",
    parameters: {
      period: periodParameter(9),
      k: periodParameter(3),
      d: periodParameter(3),
    },
    lookback: (p: Record<string, number>) => p.period! - 1,
    calculate: (bars, p) =>
      kdj(bars, p.period!, p.k!, p.d!).map((v) => v[line]),
  };
}

export const momentumFactors = {
  roc: {
    label: "区间涨跌幅 ROC",
    category: "动量",
    unit: "%",
    description: "(当前收盘价 / N 根以前收盘价 − 1) × 100。",
    parameters: { period: periodParameter(20) },
    lookback: (p) => p.period!,
    calculate: (bars, p) =>
      bars.map((b, i) => {
        const previous = bars[i - p.period!];
        const value = ratio(
          positiveValue(b.close),
          previous ? positiveValue(previous.close) : null,
          100,
        );
        return value === null ? null : value - 100;
      }),
  },
  rsi: {
    label: "相对强弱 RSI",
    category: "动量",
    unit: "指数",
    description: "复用通达信 Wilder 平滑；首个价差初始化，横盘 0/0 留空。",
    parameters: { period: periodParameter(14) },
    lookback: (p) => p.period!,
    calculate: (bars, p) =>
      rsi(bars, [p.period!, p.period!, p.period!]).map((v) => v.rsi6),
  },
  "kdj-k": kdjFactor("k"),
  "kdj-d": kdjFactor("d"),
  "kdj-j": kdjFactor("j"),
} satisfies Record<string, FactorDefinition>;
