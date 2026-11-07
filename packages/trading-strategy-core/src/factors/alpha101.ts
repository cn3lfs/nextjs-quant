/** Independent TS implementations of the single-security OHLCV-only subset.
 * Source: Kakushadze, 101 Formulaic Alphas, Appendix A, arXiv:1601.00991v3.
 * No JoinQuant code or platform values are copied. Cross-sectional rank, VWAP,
 * industry and cap dependent formulas require separate inputs and are excluded.
 */
import type { Bar } from "../bars.js";
import { maSeries, type IndicatorValue } from "../indicators.js";
import { finiteValue, positiveValue, type FactorDefinition } from "./model.js";
import { percentileRank, rolling, rollingCorrelation } from "./statistics.js";

const alphaNumbers = [
  6, 9, 12, 23, 24, 26, 35, 46, 49, 51, 53, 54, 101,
] as const;
type AlphaNumber = (typeof alphaNumbers)[number];
export type Alpha101Id = `alpha101-${AlphaNumber}`;
const lookbacks: Record<AlphaNumber, number> = {
  6: 9,
  9: 5,
  12: 1,
  23: 19,
  24: 199,
  26: 10,
  35: 32,
  46: 20,
  49: 20,
  51: 20,
  53: 9,
  54: 0,
  101: 0,
};
const descriptions: Record<AlphaNumber, string> = {
  6: "开盘价与成交量 10 根相关系数取负。",
  9: "连续同向价格变化保持方向，否则反转单根变化。",
  12: "成交量变化方向 × 单根价格变化取负。",
  23: "最高价高于 20 根均高时，取两根最高价变化的负值，否则为零。",
  24: "100 根均线变化率不超过 0.05 时取相对百根最低收盘价的反转，否则取三根变化反转。",
  26: "量与高价的 5 根时序排名相关性，取最近 3 根最大值的负数。",
  35: "成交量、价格位置和单根收益的时序排名乘积。",
  46: "20/10 根价格斜率变化分段反转，固定阈值 0.25。",
  49: "20/10 根价格斜率变化分段反转，固定阈值 −0.1。",
  51: "20/10 根价格斜率变化分段反转，固定阈值 −0.05。",
  53: "收盘位置不平衡比例的 9 根变化取负；收盘等于最低价时留空。",
  54: "低价相对收盘的价差与开收盘五次幂的组合。",
  101: "(收盘−开盘)/(最高−最低+0.001)。",
};

function calculate(
  bars: readonly Bar[],
  number: AlphaNumber,
): IndicatorValue[] {
  const c = bars.map((b) => positiveValue(b.close)),
    o = bars.map((b) => positiveValue(b.open));
  const h = bars.map((b) => positiveValue(b.high)),
    l = bars.map((b) => positiveValue(b.low));
  const v = bars.map((b) =>
    Number.isFinite(b.volume) && b.volume >= 0 ? b.volume : null,
  );
  const delta = (values: IndicatorValue[], n: number) =>
    values.map((x, i) =>
      x === null || values[i - n] == null
        ? null
        : finiteValue(x - values[i - n]!),
    );
  const dc = delta(c, 1);
  const rank = (values: IndicatorValue[], n: number) =>
    rolling(values, n, percentileRank);
  switch (number) {
    case 6:
      return rollingCorrelation(o, v, 10).map((x) => (x === null ? null : -x));
    case 9: {
      const min = rolling(dc, 5, (values) => Math.min(...values)),
        max = rolling(dc, 5, (values) => Math.max(...values));
      return dc.map((x, i) =>
        x === null || min[i] == null || max[i] == null
          ? null
          : min[i]! > 0 || max[i]! < 0
            ? x
            : -x,
      );
    }
    case 12: {
      const dv = delta(v, 1);
      return dc.map((x, i) =>
        x === null || dv[i] == null ? null : -Math.sign(dv[i]!) * x,
      );
    }
    case 23: {
      const average = maSeries(h, 20),
        change = delta(h, 2);
      return h.map((x, i) =>
        x === null || average[i] == null
          ? null
          : average[i]! < x
            ? change[i] === null
              ? null
              : -change[i]!
            : 0,
      );
    }
    case 24: {
      const averageChange = delta(maSeries(c, 100), 100),
        min = rolling(c, 100, (values) => Math.min(...values)),
        change = delta(c, 3);
      return c.map((x, i) =>
        x === null ||
        averageChange[i] == null ||
        c[i - 100] == null ||
        min[i] == null
          ? null
          : averageChange[i]! / c[i - 100]! <= 0.05
            ? -(x - min[i]!)
            : change[i] === null
              ? null
              : -change[i]!,
      );
    }
    case 26:
      return rolling(
        rollingCorrelation(rank(v, 5), rank(h, 5), 5),
        3,
        (values) => -Math.max(...values),
      );
    case 35: {
      const volumeRank = rank(v, 32);
      const priceRank = rank(
        c.map((x, i) =>
          x === null || h[i] == null || l[i] == null ? null : x + h[i]! - l[i]!,
        ),
        16,
      );
      const returnRank = rank(
        c.map((x, i) =>
          x === null || c[i - 1] == null ? null : x / c[i - 1]! - 1,
        ),
        32,
      );
      return volumeRank.map((x, i) =>
        x === null || priceRank[i] == null || returnRank[i] == null
          ? null
          : x * (1 - priceRank[i]!) * (1 - returnRank[i]!),
      );
    }
    case 46:
    case 49:
    case 51:
      return c.map((x, i) => {
        if (
          x === null ||
          c[i - 20] == null ||
          c[i - 10] == null ||
          dc[i] == null
        )
          return null;
        const change = (c[i - 20]! - c[i - 10]!) / 10 - (c[i - 10]! - x) / 10;
        if (number === 46) return change > 0.25 ? -1 : change < 0 ? 1 : -dc[i]!;
        return change < (number === 49 ? -0.1 : -0.05) ? 1 : -dc[i]!;
      });
    case 53: {
      const position = c.map((x, i) =>
        x === null || l[i] == null || h[i] == null || x === l[i]
          ? null
          : (x - l[i]! - (h[i]! - x)) / (x - l[i]!),
      );
      return delta(position, 9).map((x) => (x === null ? null : -x));
    }
    case 54:
      return c.map((x, i) =>
        x === null ||
        o[i] == null ||
        l[i] == null ||
        h[i] == null ||
        l[i] === h[i]
          ? null
          : -((l[i]! - x) / (l[i]! - h[i]!)) * (o[i]! / x) ** 5,
      );
    case 101:
      return c.map((x, i) =>
        x === null || o[i] == null || h[i] == null || l[i] == null
          ? null
          : (x - o[i]!) / (h[i]! - l[i]! + 0.001),
      );
  }
}
export const alpha101Factors = {} as Record<Alpha101Id, FactorDefinition>;
for (const number of alphaNumbers) {
  alpha101Factors[`alpha101-${number}`] = {
    label: `Alpha101 #${String(number).padStart(3, "0")}`,
    category: "量价",
    unit: "指数",
    description: descriptions[number],
    parameters: {},
    lookback: () => lookbacks[number],
    source: {
      name: "WorldQuant 101 Formulaic Alphas",
      url: "https://arxiv.org/abs/1601.00991v3",
      revision: "v3",
      originalName: `Alpha#${number}`,
      notes:
        "独立公式复现，原始日频；五分钟为按根变体。时序排名采用平均名次/N，完整窗口；未与聚宽付费 API 核对。",
    },
    calculate: (bars) => calculate(bars, number),
  };
}
