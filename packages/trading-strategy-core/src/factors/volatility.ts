import { atr, boll } from "../indicators.js";
import {
  periodParameter,
  positiveValue,
  ratio,
  type FactorDefinition,
} from "./model.js";

function bollFactor(line: "upper" | "mid" | "lower"): FactorDefinition {
  return {
    label: `布林${line === "upper" ? "上" : line === "lower" ? "下" : "中"}轨`,
    category: "波动",
    unit: "价格",
    description: "MA ± 倍数 × 样本标准差（分母 N−1）。",
    parameters: {
      period: periodParameter(20, 2),
      multiplier: {
        label: "标准差倍数",
        default: 2,
        min: 0,
        max: 10,
        integer: false,
      },
    },
    lookback: (p: Record<string, number>) => p.period! - 1,
    calculate: (bars, p) =>
      boll(bars, p.period!, p.multiplier!).map((v) => v[line]),
  };
}

export const volatilityFactors = {
  atr: {
    label: "真实波幅 ATR",
    category: "波动",
    unit: "价格",
    description: "完整 N 个 TR 的算术均值，非 Wilder ATR。",
    parameters: { period: periodParameter(14) },
    lookback: (p) => p.period!,
    calculate: (bars, p) => atr(bars, p.period!),
  },
  "atr-percent": {
    label: "波幅率 ATR%",
    category: "波动",
    unit: "%",
    description: "共享算术 ATR / 当前收盘价 × 100。",
    parameters: { period: periodParameter(14) },
    lookback: (p) => p.period!,
    calculate: (bars, p) =>
      atr(bars, p.period!).map((v, i) =>
        ratio(v, positiveValue(bars[i]!.close), 100),
      ),
  },
  "boll-upper": bollFactor("upper"),
  "boll-mid": bollFactor("mid"),
  "boll-lower": bollFactor("lower"),
} satisfies Record<string, FactorDefinition>;
