import type { Bar } from "../bars.js";
import {
  finiteValue,
  periodParameter,
  positiveValue,
  ratio,
  type FactorDefinition,
} from "./model.js";
import { mean, rolling } from "./statistics.js";

const source = {
  name: "常用量价因子（本地明确口径）",
  url: "https://bigquant.com/doc/data_features.html",
  revision: "local-market-style-v1",
  originalName: "return / amount / volatility",
  notes:
    "参考公开分类独立实现；周期为根，不承诺平台值一致。成交额单位为输入元。",
};
const returns = (bars: readonly Bar[]) =>
  bars.map((bar, i) => {
    const value = ratio(
      positiveValue(bar.close),
      i ? positiveValue(bars[i - 1]!.close) : null,
    );
    return value === null ? null : value - 1;
  });
function returnStatistic(
  label: string,
  description: string,
  calculate: (values: number[]) => number | null,
): FactorDefinition {
  return {
    label,
    category: "波动",
    unit: "%",
    description,
    source,
    parameters: { period: periodParameter(20, 2) },
    lookback: (p) => p.period!,
    calculate: (bars, p) => rolling(returns(bars), p.period!, calculate),
  };
}
function centralMoment(values: number[], order: number) {
  const average = mean(values);
  return mean(values.map((v) => (v - average) ** order));
}
const amount = (bars: readonly Bar[]) =>
  bars.map((b) =>
    Number.isFinite(b.amount) && b.amount >= 0 ? b.amount : null,
  );

export const marketStyleFactors = {
  "return-volatility": returnStatistic(
    "收益波动率",
    "N 根简单收益率的样本标准差 ×100；不年化，需 N+1 个收盘价。",
    (v) => Math.sqrt((centralMoment(v, 2) * v.length) / (v.length - 1)) * 100,
  ),
  "downside-deviation": returnStatistic(
    "下行偏差",
    "sqrt(mean(min(收益率,0)²)) ×100，分母为完整 N 根，横盘为0；不年化。",
    (v) => Math.sqrt(mean(v.map((r) => Math.min(r, 0) ** 2))) * 100,
  ),
  "return-skewness": {
    ...returnStatistic(
      "收益偏度",
      "总体三阶中心矩 / 总体方差^1.5；常量序列无定义，留空。",
      (v) => {
        const variance = centralMoment(v, 2);
        return variance > 0 ? centralMoment(v, 3) / variance ** 1.5 : null;
      },
    ),
    unit: "指数",
  },
  "return-kurtosis": {
    ...returnStatistic(
      "收益超额峰度",
      "总体四阶中心矩 / 总体方差² −3；常量序列留空，无小样本校正。",
      (v) => {
        const variance = centralMoment(v, 2);
        return variance > 0 ? centralMoment(v, 4) / variance ** 2 - 3 : null;
      },
    ),
    unit: "指数",
  },
  "maximum-return": returnStatistic(
    "窗口最大单根收益",
    "完整 N 根简单收益率最大值 ×100。",
    (v) => Math.max(...v) * 100,
  ),
  "minimum-return": returnStatistic(
    "窗口最小单根收益",
    "完整 N 根简单收益率最小值 ×100。",
    (v) => Math.min(...v) * 100,
  ),
  "up-frequency": returnStatistic(
    "上涨频率",
    "完整 N 根中简单收益率严格大于0的占比 ×100；平盘计入分母。",
    (v) => (v.filter((r) => r > 0).length / v.length) * 100,
  ),
  "skip-momentum": {
    label: "剔除近期动量",
    category: "动量",
    unit: "%",
    description:
      "(close[t−skip]/close[t−period]−1) ×100；默认250/20是日线近似12−1月动量，不是多空组合收益。",
    source: {
      ...source,
      url: "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/Data_Library/det_mom_factor.html",
      originalName: "prior (2-12) return",
      notes:
        "参考跳过最近月份的思路，使用显式交易根数近似，非French原始组合因子。",
    },
    parameters: {
      period: periodParameter(250, 2),
      skip: { ...periodParameter(20), label: "剔除近期根数", min: 0 },
    },
    lookback: (p) => p.period!,
    calculate: (bars, p) =>
      bars.map((_, i) => {
        const start = bars[i - p.period!],
          end = bars[i - p.skip!];
        const value = ratio(
          end ? positiveValue(end.close) : null,
          start ? positiveValue(start.close) : null,
          100,
        );
        return value === null ? null : value - 100;
      }),
  },
  "short-reversal": {
    label: "短期反转",
    category: "动量",
    unit: "%",
    description: "−(close[t]/close[t−N]−1) ×100，收益取负，不代表已验证有效。",
    source,
    parameters: { period: periodParameter(5) },
    lookback: (p) => p.period!,
    calculate: (bars, p) =>
      bars.map((b, i) => {
        const previous = bars[i - p.period!];
        const value = ratio(
          positiveValue(b.close),
          previous ? positiveValue(previous.close) : null,
          100,
        );
        return value === null ? null : 100 - value;
      }),
  },
  "intrabar-return": {
    label: "根内涨跌幅",
    category: "动量",
    unit: "%",
    description: "(收盘/开盘−1) ×100；日线时为日内收益。",
    source,
    parameters: {},
    lookback: () => 0,
    calculate: (bars) =>
      bars.map((b) => {
        const v = ratio(positiveValue(b.close), positiveValue(b.open), 100);
        return v === null ? null : v - 100;
      }),
  },
  "opening-gap": {
    label: "开盘相对前收盘",
    category: "动量",
    unit: "%",
    description: "(本根开盘/前根收盘−1) ×100；只有日线时可称隔夜收益。",
    source,
    parameters: {},
    lookback: () => 1,
    calculate: (bars) =>
      bars.map((b, i) => {
        const v = ratio(
          positiveValue(b.open),
          i ? positiveValue(bars[i - 1]!.close) : null,
          100,
        );
        return v === null ? null : v - 100;
      }),
  },
  "bar-amplitude": {
    label: "前收盘基准振幅",
    category: "波动",
    unit: "%",
    description: "(最高−最低)/前收盘 ×100；无效高低价留空。",
    source,
    parameters: {},
    lookback: () => 1,
    calculate: (bars) =>
      bars.map((b, i) =>
        ratio(
          b.high >= b.low && b.low > 0 ? finiteValue(b.high - b.low) : null,
          i ? positiveValue(bars[i - 1]!.close) : null,
          100,
        ),
      ),
  },
  "high-distance": {
    label: "距窗口收盘高点",
    category: "突破",
    unit: "%",
    description:
      "(当前收盘/含当前 N 根最高收盘−1) ×100；历史高点只用窗口内收盘。",
    source,
    parameters: { period: periodParameter(250) },
    lookback: (p) => p.period! - 1,
    calculate: (bars, p) =>
      rolling(
        bars.map((b) => positiveValue(b.close)),
        p.period!,
        (v) => (v.at(-1)! / Math.max(...v) - 1) * 100,
      ),
  },
  "window-drawdown": {
    label: "窗口最大回撤",
    category: "波动",
    unit: "%",
    description:
      "含当前 N 根收盘路径中最大峰谷跌幅，正百分数；窗口前高点不参与。",
    source,
    parameters: { period: periodParameter(20, 2) },
    lookback: (p) => p.period! - 1,
    calculate: (bars, p) =>
      rolling(
        bars.map((b) => positiveValue(b.close)),
        p.period!,
        (v) => {
          let peak = v[0]!,
            drawdown = 0;
          for (const close of v) {
            peak = Math.max(peak, close);
            drawdown = Math.max(drawdown, 1 - close / peak);
          }
          return drawdown * 100;
        },
      ),
  },
  amount: {
    label: "成交额",
    category: "量价",
    unit: "元",
    description: "输入成交额，保留真实零额；非法或负值留空。",
    source,
    parameters: {},
    lookback: () => 0,
    calculate: amount,
  },
  "amount-ma": {
    label: "平均成交额",
    category: "量价",
    unit: "元",
    description: "含当前 N 根成交额算术均值；完整窗口，零额参与。",
    source,
    parameters: { period: periodParameter(20) },
    lookback: (p) => p.period! - 1,
    calculate: (bars, p) => rolling(amount(bars), p.period!, mean),
  },
  "amount-ratio": {
    label: "相对成交额",
    category: "量价",
    unit: "倍",
    description: "当前成交额/前 N 根平均成交额，排除当前根；零分母留空。",
    source,
    parameters: { period: periodParameter(5) },
    lookback: (p) => p.period!,
    calculate: (bars, p) => {
      const values = amount(bars),
        average = rolling(values, p.period!, mean);
      return values.map((v, i) => ratio(v, average[i - 1] ?? null));
    },
  },
  "amihud-illiquidity": {
    label: "Amihud 非流动性",
    category: "量价",
    unit: "指数",
    description:
      "mean(|简单收益率|/成交额元) ×10^8；完整N根，零额留空。五分钟为按根变体，非日频原值。",
    source: {
      ...source,
      url: "https://doi.org/10.1016/S1386-4181(01)00024-6",
      originalName: "Amihud (2002) ILLIQ",
      notes: "独立实现，人民币成交额，显示乘10^8，非美元原尺度。",
    },
    parameters: { period: periodParameter(20) },
    lookback: (p) => p.period!,
    calculate: (bars, p) => {
      const r = returns(bars);
      return rolling(
        r.map((v, i) =>
          ratio(
            v === null ? null : Math.abs(v),
            positiveValue(bars[i]!.amount),
            1e8,
          ),
        ),
        p.period!,
        mean,
      );
    },
  },
} satisfies Record<string, FactorDefinition>;
