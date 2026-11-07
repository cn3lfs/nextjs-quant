import type { Bar } from "../bars.js";
import { maSeries, obv } from "../indicators.js";
import { periodParameter, ratio, type FactorDefinition } from "./model.js";

function relativeVolume(bars: readonly Bar[], period: number) {
  const volumes = bars.map((b) =>
    Number.isFinite(b.volume) && b.volume >= 0 ? b.volume : null,
  );
  const average = maSeries(volumes, period);
  return volumes.map((v, i) => ratio(v, average[i - 1] ?? null));
}

export const volumeFactors = {
  "volume-ratio": {
    label: "相对成交量",
    category: "量价",
    unit: "倍",
    description:
      "当前成交量 / 此前 N 根平均量；按连续行情计根，零量保留，基准为零留空。不是分时量比。",
    parameters: { period: periodParameter(5) },
    lookback: (p) => p.period!,
    calculate: (bars, p) => {
      return relativeVolume(bars, p.period!);
    },
  },
  obv: {
    label: "能量潮 OBV",
    category: "量价",
    unit: "成交量",
    description: "按收盘涨跌累计原始成交量；无效或零量中断片段，冻结起点为零。",
    parameters: {},
    lookback: () => 1,
    calculate: (bars) => obv(bars),
  },
  "volume-ma": {
    label: "成交量均线",
    category: "量价",
    unit: "成交量",
    description: "连续 N 根成交量的算术均值；零量保留，非法量留空。",
    parameters: { period: periodParameter(5) },
    lookback: (p) => p.period! - 1,
    calculate: (bars, p) =>
      maSeries(
        bars.map((b) =>
          Number.isFinite(b.volume) && b.volume >= 0 ? b.volume : null,
        ),
        p.period!,
      ),
  },
} satisfies Record<string, FactorDefinition>;
