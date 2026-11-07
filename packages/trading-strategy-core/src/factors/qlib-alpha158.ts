// Adapted from Microsoft Qlib v0.9.7 (MIT). See THIRD_PARTY_NOTICES.md and the
// pinned loader.py / ops.py under docs/data-sources/public-factors/qlib-v0.9.7.
import type { Bar } from "../bars.js";
import {
  linearSlope,
  maSeries,
  stdSeries,
  type IndicatorValue,
} from "../indicators.js";
import {
  finiteValue,
  periodParameter,
  positiveValue,
  type FactorDefinition,
} from "./model.js";
import {
  mean,
  percentileRank,
  rolling,
  rollingCorrelation,
} from "./statistics.js";

const epsilon = 1e-12;
const revision = "da920b7f954f48ab1bb64117c976710de198373e";
const sourceUrl = `https://github.com/microsoft/qlib/blob/${revision}/qlib/contrib/data/loader.py`;
const kbarNames = [
  "KMID",
  "KLEN",
  "KMID2",
  "KUP",
  "KUP2",
  "KLOW",
  "KLOW2",
  "KSFT",
  "KSFT2",
  "OPEN0",
  "HIGH0",
  "LOW0",
] as const;
const rollingNames = [
  "ROC",
  "MA",
  "STD",
  "BETA",
  "RSQR",
  "RESI",
  "MAX",
  "MIN",
  "QTLU",
  "QTLD",
  "RANK",
  "RSV",
  "IMAX",
  "IMIN",
  "IMXD",
  "CORR",
  "CORD",
  "CNTP",
  "CNTN",
  "CNTD",
  "SUMP",
  "SUMN",
  "SUMD",
  "VMA",
  "VSTD",
  "WVMA",
  "VSUMP",
  "VSUMN",
  "VSUMD",
] as const;
type RollingName = (typeof rollingNames)[number];
type QlibName = (typeof kbarNames)[number] | RollingName;
export type QlibFactorId = `qlib-${QlibName}`;

function kbar(bars: readonly Bar[], name: (typeof kbarNames)[number]) {
  return bars.map((b) => {
    if (
      [b.open, b.high, b.low, b.close].some((v) => positiveValue(v) === null) ||
      b.high < Math.max(b.open, b.close) ||
      b.low > Math.min(b.open, b.close)
    )
      return null;
    const range = b.high - b.low,
      upper = b.high - Math.max(b.open, b.close),
      lower = Math.min(b.open, b.close) - b.low;
    switch (name) {
      case "KMID":
        return (b.close - b.open) / b.open;
      case "KLEN":
        return range / b.open;
      case "KMID2":
        return (b.close - b.open) / (range + epsilon);
      case "KUP":
        return upper / b.open;
      case "KUP2":
        return upper / (range + epsilon);
      case "KLOW":
        return lower / b.open;
      case "KLOW2":
        return lower / (range + epsilon);
      case "KSFT":
        return (2 * b.close - b.high - b.low) / b.open;
      case "KSFT2":
        return (2 * b.close - b.high - b.low) / (range + epsilon);
      case "OPEN0":
        return b.open / b.close;
      case "HIGH0":
        return b.high / b.close;
      case "LOW0":
        return b.low / b.close;
    }
  });
}

function rollingFeature(
  bars: readonly Bar[],
  name: RollingName,
  n: number,
): IndicatorValue[] {
  const closes = bars.map((b) => positiveValue(b.close));
  const highs = bars.map((b) => positiveValue(b.high));
  const lows = bars.map((b) => positiveValue(b.low));
  const volumes = bars.map((b) =>
    Number.isFinite(b.volume) && b.volume >= 0 ? b.volume : null,
  );
  const normalize = (values: IndicatorValue[], denominator = closes) =>
    values.map((v, i) =>
      v === null || denominator[i] == null || denominator[i] === 0
        ? null
        : finiteValue(v / denominator[i]!),
    );
  const delta = (values: IndicatorValue[]) =>
    values.map((v, i) =>
      v == null || values[i - 1] == null ? null : v - values[i - 1]!,
    );
  const closeDelta = delta(closes),
    volumeDelta = delta(volumes);
  const indexOfExtreme = (values: number[], high: boolean) =>
    values.indexOf(high ? Math.max(...values) : Math.min(...values)) + 1;
  const quantile = (values: number[], q: number) => {
    const sorted = [...values].sort((a, b) => a - b),
      position = (values.length - 1) * q,
      lower = Math.floor(position);
    return (
      sorted[lower]! +
      (sorted[Math.ceil(position)]! - sorted[lower]!) * (position - lower)
    );
  };
  switch (name) {
    case "ROC":
      return closes.map((v, i) =>
        v == null || closes[i - n] == null ? null : closes[i - n]! / v,
      );
    case "MA":
      return normalize(maSeries(closes, n));
    case "STD":
      return normalize(stdSeries(closes, n));
    case "BETA":
      return normalize(rolling(closes, n, linearSlope));
    case "RSQR":
      return rolling(closes, n, (values) => {
        const corr = rollingRegression(values).correlation;
        return corr === null ? null : corr ** 2;
      });
    case "RESI":
      return normalize(
        rolling(closes, n, (values) => rollingRegression(values).residual),
      );
    case "MAX":
      return normalize(rolling(highs, n, (values) => Math.max(...values)));
    case "MIN":
      return normalize(rolling(lows, n, (values) => Math.min(...values)));
    case "QTLU":
      return normalize(rolling(closes, n, (values) => quantile(values, 0.8)));
    case "QTLD":
      return normalize(rolling(closes, n, (values) => quantile(values, 0.2)));
    case "RANK":
      return rolling(closes, n, percentileRank);
    case "RSV": {
      const max = rolling(highs, n, (values) => Math.max(...values)),
        min = rolling(lows, n, (values) => Math.min(...values));
      return closes.map((v, i) =>
        v == null || min[i] == null || max[i] == null
          ? null
          : (v - min[i]!) / (max[i]! - min[i]! + epsilon),
      );
    }
    case "IMAX":
      return rolling(highs, n, (values) => indexOfExtreme(values, true) / n);
    case "IMIN":
      return rolling(lows, n, (values) => indexOfExtreme(values, false) / n);
    case "IMXD": {
      const max = rolling(highs, n, (values) => indexOfExtreme(values, true)),
        min = rolling(lows, n, (values) => indexOfExtreme(values, false));
      return max.map((v, i) =>
        v === null || min[i] == null ? null : (v - min[i]!) / n,
      );
    }
    case "CORR":
      return rollingCorrelation(
        closes,
        volumes.map((v) => (v === null ? null : Math.log(v + 1))),
        n,
      );
    case "CORD":
      return rollingCorrelation(
        closes.map((v, i) =>
          v === null || closes[i - 1] == null ? null : v / closes[i - 1]!,
        ),
        volumes.map((v, i) =>
          v === null || volumes[i - 1] == null || volumes[i - 1] === 0
            ? null
            : Math.log(v / volumes[i - 1]! + 1),
        ),
        n,
      );
    case "CNTP":
    case "CNTN":
    case "CNTD":
      return rolling(
        closeDelta.map((v) =>
          v === null
            ? null
            : name === "CNTP"
              ? Number(v > 0)
              : name === "CNTN"
                ? Number(v < 0)
                : Math.sign(v),
        ),
        n,
        mean,
      );
    case "SUMP":
    case "SUMN":
    case "SUMD":
    case "VSUMP":
    case "VSUMN":
    case "VSUMD": {
      const changes = name.startsWith("V") ? volumeDelta : closeDelta;
      const numerator = rolling(changes, n, (values) =>
        values.reduce(
          (sum, v) =>
            sum +
            (name.endsWith("P")
              ? Math.max(v, 0)
              : name.endsWith("N")
                ? Math.max(-v, 0)
                : v),
          0,
        ),
      );
      const denominator = rolling(changes, n, (values) =>
        values.reduce((sum, v) => sum + Math.abs(v), 0),
      );
      return numerator.map((v, i) =>
        v === null || denominator[i] == null
          ? null
          : v / (denominator[i]! + epsilon),
      );
    }
    case "VMA":
    case "VSTD":
      return normalize(
        name === "VMA" ? maSeries(volumes, n) : stdSeries(volumes, n),
        volumes.map((v) => (v === null ? null : v + epsilon)),
      );
    case "WVMA": {
      const weighted = closes.map((v, i) =>
        v === null || closes[i - 1] == null || volumes[i] == null
          ? null
          : Math.abs(v / closes[i - 1]! - 1) * volumes[i]!,
      );
      return normalize(
        stdSeries(weighted, n),
        maSeries(weighted, n).map((v) => (v === null ? null : v + epsilon)),
      );
    }
  }
}

function rollingRegression(values: number[]) {
  const slope = linearSlope(values);
  if (slope === null) return { residual: null, correlation: null };
  const average = mean(values),
    middle = (values.length - 1) / 2;
  let variance = 0,
    xVariance = 0;
  for (let i = 0; i < values.length; i++) {
    variance += (values[i]! - average) ** 2;
    xVariance += (i - middle) ** 2;
  }
  return {
    residual: finiteValue(values.at(-1)! - (average + slope * middle)),
    correlation:
      variance === 0
        ? null
        : finiteValue(slope * Math.sqrt(xVariance / variance)),
  };
}

const needsPrevious = new Set<RollingName>([
  "ROC",
  "CORD",
  "CNTP",
  "CNTN",
  "CNTD",
  "SUMP",
  "SUMN",
  "SUMD",
  "WVMA",
  "VSUMP",
  "VSUMN",
  "VSUMD",
]);
export const qlibFactors = {} as Record<QlibFactorId, FactorDefinition>;
for (const name of [...kbarNames, ...rollingNames]) {
  const isRolling = (rollingNames as readonly string[]).includes(name);
  qlibFactors[`qlib-${name}`] = {
    label: `Qlib ${name}`,
    category: [
      "VMA",
      "VSTD",
      "WVMA",
      "VSUMP",
      "VSUMN",
      "VSUMD",
      "CORR",
      "CORD",
    ].includes(name)
      ? "量价"
      : ["STD", "KLEN"].includes(name)
        ? "波动"
        : "动量",
    unit: "比例",
    description: `Alpha158 ${name} 原生特征；无百分比放大。完整窗口才输出，原始日频，五分钟运行属于按根迁移。`,
    source: {
      name: "Microsoft Qlib Alpha158",
      url: sourceUrl,
      revision,
      originalName: name,
      notes:
        "完整窗口/缺失从严；不是 Qlib 的 min_periods=1 早期填值。VWAP0 未接入，未以价格代理。",
    },
    parameters: isRolling ? { period: periodParameter(20, 2) } : {},
    lookback: (p) =>
      isRolling
        ? p.period! - 1 + Number(needsPrevious.has(name as RollingName))
        : 0,
    calculate: (bars, p) =>
      isRolling
        ? rollingFeature(bars, name as RollingName, p.period!)
        : kbar(bars, name as (typeof kbarNames)[number]),
  };
}
/** The standard 158-column set has one unavailable field: VWAP0. */
export const qlibAlpha158Variants = [
  ...kbarNames.map((name) => ({
    name,
    spec: { id: `qlib-${name}` as QlibFactorId },
  })),
  ...rollingNames.flatMap((name) =>
    [5, 10, 20, 30, 60].map((period) => ({
      name: `${name}${period}`,
      spec: { id: `qlib-${name}` as QlibFactorId, parameters: { period } },
    })),
  ),
];
