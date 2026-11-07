import { positiveValue, type FactorDefinition } from "./model.js";

function channelFactor(side: "high" | "low"): FactorDefinition {
  return {
    label: `前 N 根${side === "high" ? "最高" : "最低"}价`,
    category: "突破",
    unit: "价格",
    description:
      "严格排除当前根的价格通道；窗口含非法 OHLC 时留空，零量行情保留。",
    parameters: {
      period: {
        label: "周期（根）",
        default: 20,
        min: 1,
        max: 250,
        integer: true,
      },
    },
    lookback: (p: Record<string, number>) => p.period!,
    calculate: (bars, p) =>
      bars.map((_, i) => {
        if (i < p.period!) return null;
        const window = bars.slice(i - p.period!, i);
        if (
          window.some(
            (b) =>
              [b.open, b.high, b.low, b.close].some(
                (v) => positiveValue(v) === null,
              ) ||
              b.high < Math.max(b.open, b.close) ||
              b.low > Math.min(b.open, b.close),
          )
        )
          return null;
        const values = window.map((b) => b[side]);
        return side === "high" ? Math.max(...values) : Math.min(...values);
      }),
  };
}
export const breakoutFactors = {
  "prior-high": channelFactor("high"),
  "prior-low": channelFactor("low"),
};
