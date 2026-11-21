import type { Bar } from "trading-strategy-core/bars";
import {
  atr,
  boll,
  confirmedExtrema,
  dmi,
  ema,
  ichimoku,
  ma,
  macd,
  rsi,
  supertrend,
  williamsR,
  type ConfirmedExtremum,
  type IndicatorValue,
} from "trading-strategy-core/indicators";
import {
  causalAlternatingPivots,
  clampScore,
  computeRewardMultiple,
  isValidBarRange,
  isValidOhlcvBar,
  makeGeometryLine,
  priorVolumeRatio,
} from "./helpers.js";
import type {
  PreparedTheoryFamilyScreener,
  TheoryFamilyScreenerFactory,
  TheoryGeometryLine,
  TheoryScreenContext,
  TheoryScreenMatch,
  TheoryScreenerMethodSpec,
} from "./types.js";

export const trendBreakoutSpecs: readonly TheoryScreenerMethodSpec[] = [
  {
    id: "f02-dow-swing-break",
    theoryId: "F02.09",
    family: "trend-breakout",
    label: "道氏高低点结构突破",
    direction: "long",
    warmupBars: 35,
    description:
      "确认的抬高低点与抬高高点构成上升结构后，收盘突破最近确认高点。",
  },
  {
    id: "f02-support-rejection",
    theoryId: "F02.04",
    family: "trend-breakout",
    label: "确认支撑带拒绝下破",
    direction: "long",
    warmupBars: 35,
    description: "两个相邻确认摆动低点构成水平支撑带，回踩不破后阳线收复前高。",
  },
  {
    id: "f02-trendline-break",
    theoryId: "F02.05",
    family: "trend-breakout",
    label: "下降趋势线突破",
    direction: "long",
    warmupBars: 35,
    description: "两个依次降低的确认高点连成下降趋势线，收盘首次站上趋势线。",
  },
  {
    id: "f02-livermore-pivotal",
    theoryId: "F02.07",
    family: "trend-breakout",
    label: "Livermore 关键点领涨突破",
    direction: "long",
    warmupBars: 60,
    description: "相对强度领先且多次测试的关键点阻力被放量收复。",
  },
  {
    id: "f02-weinstein-stage2",
    theoryId: "F02.08",
    family: "trend-breakout",
    label: "Weinstein 二阶段转强突破",
    direction: "long",
    warmupBars: 155,
    description: "150 日均线上行且前期窄幅筑底，放量突破底部箱体上沿。",
  },
  {
    id: "f03-ma-pullback-reclaim",
    theoryId: "F03.05",
    family: "trend-breakout",
    label: "均线多头回踩收复",
    direction: "long",
    warmupBars: 65,
    description: "EMA20 上穿并守住 MA60 的多头排列中，回踩 EMA20 后收复前高。",
  },
  {
    id: "f03-macd-zero-accel",
    theoryId: "F03.06",
    family: "trend-breakout",
    label: "MACD 零轴上金叉与空中加油",
    direction: "long",
    warmupBars: 40,
    description: "零轴上方 DIF 上穿 DEA，或柱体缩量后再放大并突破前高。",
  },
  {
    id: "f03-dmi-supertrend",
    theoryId: "F03.09",
    family: "trend-breakout",
    label: "DMI 与 Supertrend 趋势共振",
    direction: "long",
    warmupBars: 35,
    description: "Supertrend 转多、+DI 高于 -DI 且 ADX 上行时突破前高。",
  },
  {
    id: "f03-ichimoku-break",
    theoryId: "F03.10",
    family: "trend-breakout",
    label: "一目均衡三役好转突破",
    direction: "long",
    warmupBars: 60,
    description: "转换线高于基准线、收盘站上云层且迟行线确认转强。",
  },
  {
    id: "f03-triple-screen-daily",
    theoryId: "F03.11",
    family: "trend-breakout",
    label: "Elder 三重滤网日线触发",
    direction: "long",
    warmupBars: 65,
    description: "周线潮汐向上、日线振荡指标超卖后回升，并突破前一根高点。",
  },
  {
    id: "f03-adaptive-trend-cross",
    theoryId: "F03.13",
    family: "trend-breakout",
    label: "KAMA 自适应均线突破",
    direction: "long",
    warmupBars: 35,
    description: "KAMA(10) 拐头向上时，收盘同时站上自适应均线与五日前高。",
  },
  {
    id: "f04-turtle-donchian",
    theoryId: "F04.02",
    family: "trend-breakout",
    label: "海龟 Donchian 通道突破",
    direction: "long",
    warmupBars: 25,
    description: "收盘突破 20 日 Donchian 上轨，以 10 日下轨与 2ATR 共同止损。",
  },
  {
    id: "f04-ttm-squeeze",
    theoryId: "F04.04",
    family: "trend-breakout",
    label: "BB/KC 波动挤压释放突破",
    direction: "long",
    warmupBars: 30,
    description: "布林带连续收于 Keltner 通道内形成挤压后，向上突破挤压箱体。",
  },
  {
    id: "f04-nr7-inside-break",
    theoryId: "F04.07",
    family: "trend-breakout",
    label: "NR7 窄幅与内包线突破",
    direction: "long",
    warmupBars: 65,
    description: "上升趋势中出现 NR7 或内包线收缩，次日突破触发上沿。",
  },
];

type MacdPoint = {
  dif: IndicatorValue;
  dea: IndicatorValue;
  macd: IndicatorValue;
};
type DmiPoint = {
  plus: IndicatorValue;
  minus: IndicatorValue;
  adx: IndicatorValue;
};
type SupertrendPoint = { bullish: boolean; value: number } | null;
type CloudPoint = {
  conversion: IndicatorValue;
  base: IndicatorValue;
  upper: IndicatorValue;
  lower: IndicatorValue;
};
type BollPoint = {
  mid: IndicatorValue;
  upper: IndicatorValue;
  lower: IndicatorValue;
};

type Series = {
  context: TheoryScreenContext;
  bars: readonly Bar[];
  extrema: ConfirmedExtremum[];
  ma20: IndicatorValue[];
  ma60: IndicatorValue[];
  ma150: IndicatorValue[];
  ema20: IndicatorValue[];
  atr14: IndicatorValue[];
  atr20: IndicatorValue[];
  macd: MacdPoint[];
  rsi14: IndicatorValue[];
  williams14: IndicatorValue[];
  dmi14: DmiPoint[];
  supertrend10: SupertrendPoint[];
  cloud: CloudPoint[];
  boll20: BollPoint[];
  kama10: IndicatorValue[];
  benchmarkCloseByDate: Map<string, number> | null;
};

/** Null-safe read of a precomputed indicator series. */
function valueAt(
  series: readonly IndicatorValue[],
  index: number,
): number | null {
  const value = series[index];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function price(value: number): string {
  return value.toFixed(2);
}

function ratio(bars: readonly Bar[], index: number): number | null {
  return priorVolumeRatio(bars, index);
}

/** Kaufman adaptive moving average: efficiency ratio scales a fast/slow EMA
 * blend. 冻结契约的 indicators 未导出 KAMA，故按标准 ER/SC 定义在本地实现；
 * 首个完整 n 窗口以收盘价播种，全部状态只依赖过去。 */
function kamaSeries(bars: readonly Bar[], n = 10): IndicatorValue[] {
  const fast = 2 / 3;
  const slow = 2 / 31;
  const result: IndicatorValue[] = Array(bars.length).fill(null);
  let previous: number | null = null;
  for (let i = 0; i < bars.length; i++) {
    const close = bars[i]!.close;
    if (!Number.isFinite(close) || close <= 0) {
      previous = null;
      continue;
    }
    if (i < n) continue;
    const anchor = bars[i - n]!.close;
    if (!Number.isFinite(anchor) || anchor <= 0) {
      previous = null;
      continue;
    }
    let volatility = 0;
    let valid = true;
    for (let k = i - n + 1; k <= i; k++) {
      const current = bars[k]!.close;
      const prior = bars[k - 1]!.close;
      if (
        !Number.isFinite(current) ||
        !Number.isFinite(prior) ||
        current <= 0 ||
        prior <= 0
      ) {
        valid = false;
        break;
      }
      volatility += Math.abs(current - prior);
    }
    if (!valid || volatility === 0) {
      previous = null;
      continue;
    }
    const efficiency = Math.abs(close - anchor) / volatility;
    const smoothing = (efficiency * (fast - slow) + slow) ** 2;
    previous =
      previous === null ? close : previous + smoothing * (close - previous);
    result[i] = previous;
  }
  return result;
}

function prepareSeries(context: TheoryScreenContext): Series {
  const bars = context.bars;
  const rsiTriple = rsi(bars, [14, 14, 14]);
  return {
    context,
    bars,
    extrema: confirmedExtrema(bars).extrema,
    ma20: ma(bars, 20),
    ma60: ma(bars, 60),
    ma150: ma(bars, 150),
    ema20: ema(bars, 20),
    atr14: atr(bars, 14),
    atr20: atr(bars, 20),
    macd: macd(bars),
    // 核心 RSI 只暴露 6/12/24，这里用三组 14 周期取得 RSI14。
    rsi14: rsiTriple.map((point) => point.rsi6),
    williams14: williamsR(bars, 14),
    dmi14: dmi(bars, 14),
    supertrend10: supertrend(bars, 10, 3),
    cloud: ichimoku(bars),
    boll20: boll(bars, 20, 2),
    kama10: kamaSeries(bars, 10),
    benchmarkCloseByDate: context.benchmarkBars?.length
      ? new Map(context.benchmarkBars.map((bar) => [bar.date, bar.close]))
      : null,
  };
}

function horizontal(
  series: Series,
  label: string,
  kind: TheoryGeometryLine["kind"],
  start: number,
  end: number,
  level: number,
  style: TheoryGeometryLine["style"] = "dashed",
): TheoryGeometryLine {
  return makeGeometryLine(series.bars, label, kind, style, [
    { index: start, price: level },
    { index: end, price: level },
  ]);
}

function priceScore(
  volumeRatio: number | null,
  rewardMultiple: number,
  base: number,
): number {
  let score = base;
  if (volumeRatio !== null && volumeRatio >= 1.5) score += 0.5;
  if (rewardMultiple >= 3) score += 0.5;
  return clampScore(score);
}

function buildLongMatch(
  series: Series,
  index: number,
  spec: TheoryScreenerMethodSpec,
  draft: {
    pivotPrice: number | null;
    stopPrice: number;
    targetPrice: number;
    volumeRatio: number | null;
    baseScore: number;
    summary: string;
    lines: TheoryGeometryLine[];
  },
): TheoryScreenMatch | null {
  const bar = series.bars[index]!;
  const { close } = bar;
  const { stopPrice } = draft;
  if (!(stopPrice < close)) return null;

  const targetPrice =
    draft.targetPrice <= close
      ? close + 2 * (close - stopPrice)
      : draft.targetPrice;
  const rewardMultiple = computeRewardMultiple(
    "long",
    close,
    stopPrice,
    targetPrice,
  );
  if (rewardMultiple === null || !Number.isFinite(rewardMultiple)) return null;

  return {
    family: "trend-breakout",
    methodId: spec.id,
    theoryId: spec.theoryId,
    label: spec.label,
    direction: "long",
    index,
    date: bar.date,
    close,
    pivotPrice: draft.pivotPrice,
    stopPrice,
    targetPrice,
    rewardMultiple,
    volumeRatio: draft.volumeRatio,
    score: priceScore(draft.volumeRatio, rewardMultiple, draft.baseScore),
    summary: draft.summary,
    geometry: { lines: draft.lines },
  };
}

/** Common causal/evaluable preconditions for every method in this family. */
function usable(series: Series, index: number): boolean {
  return (
    index >= 1 &&
    isValidOhlcvBar(series.bars[index]) &&
    isValidOhlcvBar(series.bars[index - 1])
  );
}

function pivots(series: Series, index: number, lookback: number) {
  return causalAlternatingPivots(series.extrema, series.bars, index, lookback);
}

function lastHighPivots(series: Series, index: number, lookback: number) {
  return pivots(series, index, lookback).filter((p) => p.kind === "high");
}

/** F02.09 道氏结构：确认的 L1 -> H1 -> L2 -> H2 依次抬高，突破 H2。 */
function dowSwingBreak(series: Series, i: number) {
  const bars = series.bars;
  const bar = bars[i]!;
  const prev = bars[i - 1]!;
  const chain = pivots(series, i, 90);
  if (chain.length < 4) return null;
  const [l1, h1, l2, h2] = chain.slice(-4) as [
    ConfirmedExtremum,
    ConfirmedExtremum,
    ConfirmedExtremum,
    ConfirmedExtremum,
  ];
  if (
    l1.kind !== "low" ||
    h1.kind !== "high" ||
    l2.kind !== "low" ||
    h2.kind !== "high"
  )
    return null;
  if (!(l2.price > l1.price && h2.price > h1.price)) return null;
  if (i < h2.index + 3 || i - (h2.index + 3) > 15) return null;
  if (!(bar.close > h2.price && prev.close <= h2.price)) return null;
  if (bar.low <= l2.price) return null;
  for (let k = h2.index + 1; k < i; k++) {
    if (!isValidOhlcvBar(bars[k]) || bars[k]!.low <= l2.price) return null;
  }
  const stopPrice = l2.price;
  const targetPrice = h2.price + (h2.price - l1.price);
  return buildLongMatch(series, i, trendBreakoutSpecs[0]!, {
    pivotPrice: h2.price,
    stopPrice,
    targetPrice,
    volumeRatio: ratio(bars, i),
    baseScore: 3.5,
    summary: `道氏结构 ${price(l1.price)}→${price(h1.price)}→${price(l2.price)}→${price(h2.price)} 依次抬高，收盘 ${price(bar.close)} 突破前高 ${price(h2.price)}`,
    lines: [
      makeGeometryLine(bars, "结构轮廓", "outline", "solid", [
        { index: l1.index, price: l1.price },
        { index: h1.index, price: h1.price },
        { index: l2.index, price: l2.price },
        { index: h2.index, price: h2.price },
        { index: i, price: bar.close },
      ]),
      horizontal(series, "颈线", "neckline", h2.index, i, h2.price),
    ],
  });
}

/** F02.04 水平支撑带：两个相近确认低点，回踩不破后阳线反包。 */
function supportRejection(series: Series, i: number) {
  const bars = series.bars;
  const bar = bars[i]!;
  const prev = bars[i - 1]!;
  if (i < 4) return null;
  const ma60 = valueAt(series.ma60, i);
  const priorMa60 = valueAt(series.ma60, i - 1);
  if (ma60 === null || priorMa60 === null || ma60 < priorMa60) return null;
  const lows = pivots(series, i, 80).filter(
    (p) => p.kind === "low" && p.index >= i - 80 && p.index <= i - 4,
  );
  let lowA: ConfirmedExtremum | null = null;
  let lowB: ConfirmedExtremum | null = null;
  for (let b = lows.length - 1; b >= 1 && lowB === null; b--) {
    const candidate = lows[b]!;
    for (let a = b - 1; a >= 0; a--) {
      const earlier = lows[a]!;
      if (
        Math.abs(earlier.price - candidate.price) / candidate.price <=
        0.015
      ) {
        lowA = earlier;
        lowB = candidate;
        break;
      }
    }
  }
  if (!lowA || !lowB) return null;
  const support = (lowA.price + lowB.price) / 2;
  const tested = [i - 1, i].some((k) => {
    const candidate = bars[k];
    return (
      !!candidate &&
      isValidOhlcvBar(candidate) &&
      candidate.low <= support * 1.015 &&
      candidate.low >= support * 0.98
    );
  });
  if (!tested) return null;
  if (!(
    bar.close > bar.open &&
    bar.close > prev.high &&
    bar.close > support * 1.01
  ))
    return null;
  const atr14 = valueAt(series.atr14, i) ?? 0;
  const stopPrice = Math.min(bar.low, prev.low, support * 0.98) - 0.1 * atr14;
  const targetPrice = bar.close + 2.5 * (bar.close - stopPrice);
  return buildLongMatch(series, i, trendBreakoutSpecs[1]!, {
    pivotPrice: prev.high,
    stopPrice,
    targetPrice,
    volumeRatio: ratio(bars, i),
    baseScore: 3,
    summary: `支撑带 ${price(support)} 两次确认，回踩不破后收盘 ${price(bar.close)} 反包前高 ${price(prev.high)}`,
    lines: [
      horizontal(series, "支撑带", "lower", lowA.index, i, support, "solid"),
    ],
  });
}

/** F02.05 下降趋势线：H1、H2 依次降低，收盘首次站上外推趋势线。 */
function trendlineBreak(series: Series, i: number) {
  const bars = series.bars;
  const bar = bars[i]!;
  const prev = bars[i - 1]!;
  if (!isValidOhlcvBar(prev)) return null;
  const chain = pivots(series, i, 90);
  for (let j = chain.length - 1; j >= 2; j--) {
    const h2 = chain[j]!;
    const low = chain[j - 1]!;
    const h1 = chain[j - 2]!;
    if (h2.kind !== "high" || low.kind !== "low" || h1.kind !== "high")
      continue;
    if (h2.index - h1.index < 5) continue;
    if (!(h2.price < h1.price * 0.985)) continue;
    if (!(low.index > h1.index && low.index < h2.index)) continue;
    if (!(low.price < Math.min(h1.price, h2.price))) continue;
    if (i < h2.index + 3 || i - (h2.index + 3) > 15) continue;
    const slope = (h2.price - h1.price) / (h2.index - h1.index);
    const lineAt = (k: number) => h1.price + slope * (k - h1.index);
    const level = lineAt(i);
    if (!(level > low.price)) continue;
    if (!(bar.close > level && prev.close <= lineAt(i - 1))) continue;
    const stopPrice = low.price;
    const targetPrice = bar.close + (h1.price - low.price);
    return buildLongMatch(series, i, trendBreakoutSpecs[2]!, {
      pivotPrice: level,
      stopPrice,
      targetPrice,
      volumeRatio: ratio(bars, i),
      baseScore: 3,
      summary: `下降趋势线 ${price(h1.price)}→${price(h2.price)} 于 ${price(level)} 被收盘 ${price(bar.close)} 突破，前低 ${price(low.price)} 为止损`,
      lines: [
        makeGeometryLine(bars, "下降趋势线", "upper", "dashed", [
          { index: h1.index, price: h1.price },
          { index: i, price: level },
        ]),
        horizontal(series, "前低", "lower", low.index, i, low.price),
      ],
    });
  }
  return null;
}

/** F02.07 Livermore 关键点：相对强度领先，多次测试的关键阻力被放量收复。 */
function livermorePivotal(series: Series, i: number) {
  const bars = series.bars;
  const bar = bars[i]!;
  const prev = bars[i - 1]!;
  if (i < 35) return null;
  const anchor = bars[i - 20];
  const ma60 = valueAt(series.ma60, i);
  if (!anchor || ma60 === null || !(anchor.close > 0)) return null;
  const stockReturn = (bar.close - anchor.close) / anchor.close;
  if (!(stockReturn > 0)) return null;
  let leading = false;
  const benchmark = series.benchmarkCloseByDate;
  if (benchmark) {
    const now = benchmark.get(bar.date);
    const then = benchmark.get(anchor.date);
    if (now !== undefined && then !== undefined && then > 0)
      leading = stockReturn > (now - then) / then;
  }
  if (!leading) {
    const rps20 = series.context.rpsAt?.(i)?.rps20;
    if (typeof rps20 === "number" && Number.isFinite(rps20))
      leading = rps20 >= 75;
    else leading = bar.close > ma60 * 1.05;
  }
  if (!leading) return null;
  const highs = lastHighPivots(series, i, 120).filter(
    (p) => p.index >= i - 35 && p.index <= i - 4,
  );
  if (highs.length === 0) return null;
  const pivotalHigh = Math.max(...highs.map((p) => p.price));
  // “被测试并守住”按 2% 容差内的多次确认高点计数，一次触顶不算关键点。
  const touches = highs.filter((p) => p.price >= pivotalHigh * 0.98);
  if (touches.length < 2) return null;
  const lastTouch = touches.at(-1)!;
  if (lastTouch.index >= i - 1) return null;
  // 反应必须浅：回撤低点相对当时的 MA20 未偏离 10% 以上（不深跌破均线）。
  let shallow = true;
  for (let k = lastTouch.index + 1; k <= i - 1; k++) {
    const low = bars[k]?.low;
    const mid = valueAt(series.ma20, k);
    if (low === undefined || mid === null || !(low >= mid * 0.9)) {
      shallow = false;
      break;
    }
  }
  if (!shallow) return null;
  const volumeRatio = ratio(bars, i);
  if (volumeRatio === null || volumeRatio < 1.4) return null;
  if (!(bar.close > pivotalHigh && prev.close <= pivotalHigh)) return null;
  const ma20 = valueAt(series.ma20, i);
  const stopPrice = Math.max(ma20 ?? pivotalHigh * 0.93, pivotalHigh * 0.93);
  if (!(stopPrice < bar.close)) return null;
  const targetPrice = pivotalHigh + 2.5 * (pivotalHigh - stopPrice);
  return buildLongMatch(series, i, trendBreakoutSpecs[3]!, {
    pivotPrice: pivotalHigh,
    stopPrice,
    targetPrice,
    volumeRatio,
    baseScore: 4,
    summary: `关键点 ${price(pivotalHigh)} 经 ${touches.length} 次测试后放量 ${price(volumeRatio)} 倍收复，20 日涨幅 ${(stockReturn * 100).toFixed(1)}%`,
    lines: [
      horizontal(
        series,
        "关键点阻力",
        "upper",
        touches[0]!.index,
        i,
        pivotalHigh,
      ),
      horizontal(series, "MA20 支撑", "lower", i - 20, i, ma20 ?? stopPrice),
    ],
  });
}

/** F02.08 Weinstein 二阶段：MA150 上行、30 日窄幅筑底后放量突破。 */
function weinsteinStage2(series: Series, i: number) {
  const bars = series.bars;
  const bar = bars[i]!;
  const prev = bars[i - 1]!;
  if (i < 30) return null;
  const ma150 = valueAt(series.ma150, i);
  const ma150Past = valueAt(series.ma150, i - 15);
  if (ma150 === null || ma150Past === null || !(ma150 > ma150Past)) return null;
  if (!isValidBarRange(bars, i - 30, i - 1)) return null;
  let baseHigh = -Infinity;
  let baseLow = Infinity;
  for (let k = i - 30; k <= i - 1; k++) {
    baseHigh = Math.max(baseHigh, bars[k]!.high);
    baseLow = Math.min(baseLow, bars[k]!.low);
  }
  if (!(baseHigh > 0) || !((baseHigh - baseLow) / baseHigh <= 0.18))
    return null;
  const volumeRatio = ratio(bars, i);
  if (volumeRatio === null || volumeRatio < 1.4) return null;
  if (!(bar.close > baseHigh && bar.close > ma150 && prev.close <= baseHigh))
    return null;
  const stopPrice = Math.min(ma150, baseLow);
  if (!(stopPrice < bar.close)) return null;
  const targetPrice = baseHigh + 2.5 * (baseHigh - stopPrice);
  return buildLongMatch(series, i, trendBreakoutSpecs[4]!, {
    pivotPrice: baseHigh,
    stopPrice,
    targetPrice,
    volumeRatio,
    baseScore: 4,
    summary: `MA150 ${price(ma150)} 上行，30 日箱体 ${price(baseLow)}–${price(baseHigh)} 被放量 ${price(volumeRatio)} 倍突破`,
    lines: [
      horizontal(series, "箱体上沿", "upper", i - 30, i, baseHigh, "solid"),
      horizontal(series, "箱体下沿", "lower", i - 30, i, baseLow, "solid"),
    ],
  });
}

/** F03.05 多头排列中回踩 EMA20 后收复前高。 */
function maPullbackReclaim(series: Series, i: number) {
  const bars = series.bars;
  const bar = bars[i]!;
  const prev = bars[i - 1]!;
  if (i < 10) return null;
  const ema20 = valueAt(series.ema20, i);
  const prevEma20 = valueAt(series.ema20, i - 1);
  const ma60 = valueAt(series.ma60, i);
  const prevMa60 = valueAt(series.ma60, i - 1);
  const ma60Past = valueAt(series.ma60, i - 10);
  if (
    ema20 === null ||
    prevEma20 === null ||
    ma60 === null ||
    prevMa60 === null ||
    ma60Past === null
  )
    return null;
  if (!(ema20 > ma60 && ma60 > ma60Past)) return null;
  const pulledBack = prev.close <= prevEma20 * 1.005 || prev.low <= prevEma20;
  if (!pulledBack || !(prev.close > prevMa60)) return null;
  if (!(bar.close > ema20 && bar.close > prev.high)) return null;
  const stopPrice = Math.min(bar.low, prev.low, ma60);
  if (!(stopPrice < bar.close)) return null;
  const targetPrice = bar.close + 2.5 * (bar.close - stopPrice);
  return buildLongMatch(series, i, trendBreakoutSpecs[5]!, {
    pivotPrice: prev.high,
    stopPrice,
    targetPrice,
    volumeRatio: ratio(bars, i),
    baseScore: 3,
    summary: `EMA20 ${price(ema20)} 之上多头排列，回踩后收盘 ${price(bar.close)} 收复前高 ${price(prev.high)}`,
    lines: [
      makeGeometryLine(bars, "EMA20", "upper", "solid", [
        { index: i - 10, price: valueAt(series.ema20, i - 10) ?? ema20 },
        { index: i, price: ema20 },
      ]),
      makeGeometryLine(bars, "MA60", "lower", "solid", [
        { index: i - 10, price: ma60Past },
        { index: i, price: ma60 },
      ]),
    ],
  });
}

/** F03.06 零轴上方 DIF 上穿 DEA，或柱体二次放大突破前高。 */
function macdZeroAccel(series: Series, i: number) {
  const bars = series.bars;
  const bar = bars[i]!;
  const prev = bars[i - 1]!;
  if (i < 3) return null;
  const point = series.macd[i];
  const prior = series.macd[i - 1];
  const ma60 = valueAt(series.ma60, i);
  if (!point || !prior || ma60 === null) return null;
  const { dif, dea, macd: hist } = point;
  const { dif: prevDif, dea: prevDea } = prior;
  if (
    typeof dif !== "number" ||
    typeof dea !== "number" ||
    typeof hist !== "number" ||
    typeof prevDif !== "number" ||
    typeof prevDea !== "number"
  )
    return null;
  if (!(dif > 0 && dea >= -0.02 * bar.close && bar.close > ma60)) return null;
  const goldenCross = prevDif <= prevDea && dif > dea;
  const earlier = series.macd[i - 2];
  const histEarlier = earlier?.macd;
  const histPrior = series.macd[i - 1]?.macd;
  const refuel =
    typeof histEarlier === "number" &&
    typeof histPrior === "number" &&
    histEarlier > histPrior &&
    histPrior > 0 &&
    hist > histPrior * 1.25 &&
    bar.close > prev.high;
  if (!goldenCross && !refuel) return null;
  const ma20 = valueAt(series.ma20, i);
  const stopPrice = Math.min(bar.low, prev.low, ma20 ?? bar.low);
  if (!(stopPrice < bar.close)) return null;
  const targetPrice = bar.close + 2.5 * (bar.close - stopPrice);
  return buildLongMatch(series, i, trendBreakoutSpecs[6]!, {
    pivotPrice: prev.high,
    stopPrice,
    targetPrice,
    volumeRatio: ratio(bars, i),
    baseScore: 3,
    summary: goldenCross
      ? `零轴上方 DIF ${price(dif)} 上穿 DEA ${price(dea)}，收盘 ${price(bar.close)} 站上 MA60`
      : `MACD 柱体由 ${price(histPrior!)} 放大至 ${price(hist)}，收盘突破前高 ${price(prev.high)}`,
    lines: [
      horizontal(series, "前高触发", "upper", i - 1, i, prev.high),
      horizontal(series, "MA20 支撑", "lower", i - 10, i, ma20 ?? stopPrice),
    ],
  });
}

/** F03.09 Supertrend 与 DMI 同向共振时突破前高。 */
function dmiSupertrend(series: Series, i: number) {
  const bars = series.bars;
  const bar = bars[i]!;
  const prev = bars[i - 1]!;
  const st = series.supertrend10[i];
  const prevSt = series.supertrend10[i - 1];
  const point = series.dmi14[i];
  const prior = series.dmi14[i - 1];
  if (!st || !prevSt || !point || !prior) return null;
  const { plus, minus, adx } = point;
  const prevPlus = prior.plus;
  const prevMinus = prior.minus;
  const prevAdx = prior.adx;
  if (
    typeof plus !== "number" ||
    typeof minus !== "number" ||
    typeof adx !== "number" ||
    typeof prevPlus !== "number" ||
    typeof prevMinus !== "number" ||
    typeof prevAdx !== "number"
  )
    return null;
  const flipped = st.bullish && !prevSt.bullish;
  const bullish = st.bullish && bar.close > st.value;
  if (!flipped && !bullish) return null;
  if (!(plus > minus && adx >= 20 && adx > prevAdx)) return null;
  if (!(bar.close > prev.high)) return null;
  if (!(prev.close <= prevSt.value || prevPlus <= prevMinus)) return null;
  const stopPrice = st.value;
  if (!(stopPrice < bar.close)) return null;
  const targetPrice = bar.close + 2.5 * (bar.close - stopPrice);
  return buildLongMatch(series, i, trendBreakoutSpecs[7]!, {
    pivotPrice: prev.high,
    stopPrice,
    targetPrice,
    volumeRatio: ratio(bars, i),
    baseScore: 3,
    summary: `Supertrend 转多 ${price(st.value)}，+DI ${price(plus)} > -DI ${price(minus)} 且 ADX ${price(adx)} 上行`,
    lines: [
      horizontal(series, "突破位", "upper", i - 1, i, prev.high),
      makeGeometryLine(bars, "Supertrend", "lower", "dashed", [
        { index: i - 5, price: series.supertrend10[i - 5]?.value ?? st.value },
        { index: i, price: st.value },
      ]),
    ],
  });
}

/** F03.10 一目均衡：转换线高于基准线、站上云层、迟行线确认。 */
function ichimokuBreak(series: Series, i: number) {
  const bars = series.bars;
  const bar = bars[i]!;
  const prev = bars[i - 1]!;
  if (i < 26) return null;
  const cloud = series.cloud[i];
  const prior = series.cloud[i - 1];
  const chikou = bars[i - 26];
  if (!cloud || !prior || !chikou) return null;
  const conversion = cloud.conversion;
  const base = cloud.base;
  const cloudTop = cloud.upper;
  const cloudBottom = cloud.lower;
  if (
    typeof conversion !== "number" ||
    typeof base !== "number" ||
    typeof cloudTop !== "number" ||
    typeof cloudBottom !== "number"
  )
    return null;
  if (!(conversion > base && bar.close > cloudTop && bar.close > chikou.close))
    return null;
  const priorCloudTop = prior.upper;
  const priorConversion = prior.conversion;
  const priorBase = prior.base;
  const turned =
    (typeof priorCloudTop === "number" && prev.close <= priorCloudTop) ||
    (typeof priorConversion === "number" &&
      typeof priorBase === "number" &&
      priorConversion <= priorBase);
  if (!turned) return null;
  const stopPrice = Math.min(base, cloudTop * 0.97);
  if (!(stopPrice < bar.close)) return null;
  const targetPrice = bar.close + 2.5 * (bar.close - stopPrice);
  return buildLongMatch(series, i, trendBreakoutSpecs[8]!, {
    pivotPrice: cloudTop,
    stopPrice,
    targetPrice,
    volumeRatio: ratio(bars, i),
    baseScore: 3,
    summary: `转换线 ${price(conversion)} > 基准线 ${price(base)}，收盘 ${price(bar.close)} 站上云层 ${price(cloudTop)}`,
    lines: [
      horizontal(series, "云层上沿", "upper", i - 26, i, cloudTop, "solid"),
      horizontal(series, "云层下沿", "lower", i - 26, i, cloudBottom, "solid"),
    ],
  });
}

/** F03.11 Elder 三重滤网：潮汐向上、回落到超卖、日线触发。 */
function tripleScreenDaily(series: Series, i: number) {
  const bars = series.bars;
  const bar = bars[i]!;
  const prev = bars[i - 1]!;
  if (i < 5) return null;
  const ema20 = valueAt(series.ema20, i);
  const ema20Past = valueAt(series.ema20, i - 5);
  const ma60 = valueAt(series.ma60, i);
  const hist = series.macd[i]?.macd;
  const histPast = series.macd[i - 5]?.macd;
  if (
    ema20 === null ||
    ema20Past === null ||
    ma60 === null ||
    typeof hist !== "number" ||
    typeof histPast !== "number"
  )
    return null;
  if (!(ema20 > ema20Past && bar.close > ma60 && hist > histPast)) return null;
  const williamsPrior = valueAt(series.williams14, i - 1);
  const rsiPrior = valueAt(series.rsi14, i - 1);
  const oversold =
    (williamsPrior !== null && williamsPrior < -75) ||
    (rsiPrior !== null && rsiPrior < 42);
  if (!oversold) return null;
  const williams = valueAt(series.williams14, i);
  if (
    williams === null ||
    williamsPrior === null ||
    !(bar.close > prev.high && williams > williamsPrior)
  )
    return null;
  const stopPrice = Math.min(bar.low, prev.low);
  if (!(stopPrice < bar.close)) return null;
  const targetPrice = bar.close + 2.5 * (bar.close - stopPrice);
  return buildLongMatch(series, i, trendBreakoutSpecs[9]!, {
    pivotPrice: prev.high,
    stopPrice,
    targetPrice,
    volumeRatio: ratio(bars, i),
    baseScore: 3,
    summary: `周线潮汐向上，日线 Williams %R 由 ${price(williamsPrior)} 回升至 ${price(williams)}，收盘突破前高 ${price(prev.high)}`,
    lines: [
      horizontal(series, "前高触发", "upper", i - 1, i, prev.high),
      horizontal(series, "MA60", "lower", i - 20, i, ma60, "solid"),
    ],
  });
}

/** F03.13 KAMA(10) 上行且收盘同时收复自适应均线与五日前高。 */
function adaptiveTrendCross(series: Series, i: number) {
  const bars = series.bars;
  const bar = bars[i]!;
  const prev = bars[i - 1]!;
  if (i < 5) return null;
  const kama = valueAt(series.kama10, i);
  const kamaPrior = valueAt(series.kama10, i - 1);
  const kamaPast = valueAt(series.kama10, i - 3);
  const ma60 = valueAt(series.ma60, i);
  if (kama === null || kamaPrior === null || kamaPast === null || ma60 === null)
    return null;
  if (!(kama > kamaPrior && kama > kamaPast && bar.close > ma60)) return null;
  let prev5High = -Infinity;
  for (let k = i - 5; k <= i - 1; k++) {
    const candidate = bars[k];
    if (!candidate || !Number.isFinite(candidate.high)) return null;
    prev5High = Math.max(prev5High, candidate.high);
  }
  const trigger = Math.max(kama, prev5High);
  if (!(prev.close <= Math.max(kamaPrior, prev5High) && bar.close > trigger))
    return null;
  const stopPrice = Math.min(kama, bar.low);
  if (!(stopPrice < bar.close)) return null;
  const targetPrice = bar.close + 2.5 * (bar.close - stopPrice);
  return buildLongMatch(series, i, trendBreakoutSpecs[10]!, {
    pivotPrice: prev5High,
    stopPrice,
    targetPrice,
    volumeRatio: ratio(bars, i),
    baseScore: 3,
    summary: `KAMA10 ${price(kama)} 拐头向上，收盘 ${price(bar.close)} 同时站上均线与五日前高 ${price(prev5High)}`,
    lines: [
      horizontal(series, "五日前高", "upper", i - 5, i, prev5High),
      makeGeometryLine(bars, "KAMA10", "lower", "solid", [
        { index: i - 5, price: valueAt(series.kama10, i - 5) ?? kama },
        { index: i, price: kama },
      ]),
    ],
  });
}

/** F04.02 海龟：突破 20 日 Donchian 上轨，10 日下轨与 2ATR 共同止损。 */
function turtleDonchian(series: Series, i: number) {
  const bars = series.bars;
  const bar = bars[i]!;
  const prev = bars[i - 1]!;
  if (i < 20 || !isValidBarRange(bars, i - 20, i - 1)) return null;
  const atr14 = valueAt(series.atr14, i);
  if (atr14 === null || !(atr14 > 0)) return null;
  let donchianHigh = -Infinity;
  for (let k = i - 20; k <= i - 1; k++)
    donchianHigh = Math.max(donchianHigh, bars[k]!.high);
  let donchianLow = Infinity;
  for (let k = i - 10; k <= i - 1; k++)
    donchianLow = Math.min(donchianLow, bars[k]!.low);
  if (!(bar.close > donchianHigh && prev.close <= donchianHigh)) return null;
  const stopPrice = Math.max(donchianLow, bar.close - 2 * atr14);
  if (!(stopPrice < bar.close)) return null;
  const targetPrice = bar.close + 4 * atr14;
  return buildLongMatch(series, i, trendBreakoutSpecs[11]!, {
    pivotPrice: donchianHigh,
    stopPrice,
    targetPrice,
    volumeRatio: ratio(bars, i),
    baseScore: 4,
    summary: `收盘 ${price(bar.close)} 突破 Donchian 20 日上轨 ${price(donchianHigh)}，ATR14 ${price(atr14)}`,
    lines: [
      horizontal(
        series,
        "Donchian 上轨",
        "upper",
        i - 20,
        i,
        donchianHigh,
        "solid",
      ),
      horizontal(
        series,
        "Donchian 下轨",
        "lower",
        i - 10,
        i,
        donchianLow,
        "solid",
      ),
    ],
  });
}

/** F04.04 TTM 挤压：BB(20,2) 连续收于 KC(EMA20±1.5ATR20) 内后向上释放。 */
function ttmSqueeze(series: Series, i: number) {
  const bars = series.bars;
  const bar = bars[i]!;
  const prev = bars[i - 1]!;
  if (i < 21) return null;
  const inside: number[] = [];
  for (let k = i - 1; k >= Math.max(0, i - 6); k--) {
    const band = series.boll20[k];
    const mid = valueAt(series.ema20, k);
    const range = valueAt(series.atr20, k);
    if (!band || mid === null || range === null) break;
    if (
      typeof band.upper !== "number" ||
      typeof band.lower !== "number" ||
      !(band.upper <= mid + 1.5 * range && band.lower >= mid - 1.5 * range)
    )
      break;
    inside.push(k);
  }
  if (inside.length < 3) return null;
  let squeezeHigh = -Infinity;
  let squeezeLow = Infinity;
  for (const k of inside) {
    squeezeHigh = Math.max(squeezeHigh, series.boll20[k]!.upper as number);
    squeezeLow = Math.min(squeezeLow, series.boll20[k]!.lower as number);
  }
  const ema20 = valueAt(series.ema20, i);
  if (ema20 === null || !(squeezeHigh > squeezeLow) || !(squeezeLow > 0))
    return null;
  if (!(
    bar.close > squeezeHigh &&
    prev.close <= squeezeHigh &&
    bar.close > ema20
  ))
    return null;
  const stopPrice = squeezeLow;
  if (!(stopPrice < bar.close)) return null;
  const targetPrice = squeezeHigh + 2 * (squeezeHigh - squeezeLow);
  const start = inside.at(-1)!;
  return buildLongMatch(series, i, trendBreakoutSpecs[12]!, {
    pivotPrice: squeezeHigh,
    stopPrice,
    targetPrice,
    volumeRatio: ratio(bars, i),
    baseScore: 4,
    summary: `BB 收于 Keltner 通道内 ${inside.length} 日形成挤压，收盘 ${price(bar.close)} 突破挤压箱体 ${price(squeezeHigh)}`,
    lines: [
      horizontal(
        series,
        "挤压箱体上沿",
        "upper",
        start,
        i,
        squeezeHigh,
        "solid",
      ),
      horizontal(
        series,
        "挤压箱体下沿",
        "lower",
        start,
        i,
        squeezeLow,
        "solid",
      ),
    ],
  });
}

/** F04.07 NR7 或内包线后的向上突破。 */
function nr7InsideBreak(series: Series, i: number) {
  const bars = series.bars;
  const bar = bars[i]!;
  if (i < 7 || !isValidBarRange(bars, i - 7, i - 1)) return null;
  const ma20 = valueAt(series.ma20, i);
  const ma60 = valueAt(series.ma60, i);
  if (ma20 === null || ma60 === null || !(bar.close > ma60 && ma20 >= ma60))
    return null;
  const prev = bars[i - 1]!;
  const prevRange = prev.high - prev.low;
  const isNr7 = [2, 3, 4, 5, 6, 7].every(
    (offset) => prevRange < bars[i - offset]!.high - bars[i - offset]!.low,
  );
  const twoBack = bars[i - 2]!;
  const isInside = prev.high < twoBack.high && prev.low > twoBack.low;
  if (!isNr7 && !isInside) return null;
  const trigHigh = isInside ? twoBack.high : prev.high;
  const trigLow = isInside ? twoBack.low : prev.low;
  if (!(bar.close > trigHigh && bar.low >= trigLow)) return null;
  const stopPrice = trigLow;
  if (!(stopPrice < bar.close)) return null;
  const targetPrice = bar.close + 2.5 * (bar.close - trigLow);
  return buildLongMatch(series, i, trendBreakoutSpecs[13]!, {
    pivotPrice: trigHigh,
    stopPrice,
    targetPrice,
    volumeRatio: ratio(bars, i),
    baseScore: 3,
    summary: `${isInside ? "内包线" : "NR7 窄幅"}收缩后收盘 ${price(bar.close)} 突破触发上沿 ${price(trigHigh)}`,
    lines: [
      horizontal(series, "触发上沿", "upper", i - 2, i, trigHigh),
      horizontal(series, "触发下沿", "lower", i - 2, i, trigLow),
    ],
  });
}

const evaluators: readonly {
  spec: TheoryScreenerMethodSpec;
  evaluate: (series: Series, index: number) => TheoryScreenMatch | null;
}[] = [
  { spec: trendBreakoutSpecs[0]!, evaluate: dowSwingBreak },
  { spec: trendBreakoutSpecs[1]!, evaluate: supportRejection },
  { spec: trendBreakoutSpecs[2]!, evaluate: trendlineBreak },
  { spec: trendBreakoutSpecs[3]!, evaluate: livermorePivotal },
  { spec: trendBreakoutSpecs[4]!, evaluate: weinsteinStage2 },
  { spec: trendBreakoutSpecs[5]!, evaluate: maPullbackReclaim },
  { spec: trendBreakoutSpecs[6]!, evaluate: macdZeroAccel },
  { spec: trendBreakoutSpecs[7]!, evaluate: dmiSupertrend },
  { spec: trendBreakoutSpecs[8]!, evaluate: ichimokuBreak },
  { spec: trendBreakoutSpecs[9]!, evaluate: tripleScreenDaily },
  { spec: trendBreakoutSpecs[10]!, evaluate: adaptiveTrendCross },
  { spec: trendBreakoutSpecs[11]!, evaluate: turtleDonchian },
  { spec: trendBreakoutSpecs[12]!, evaluate: ttmSqueeze },
  { spec: trendBreakoutSpecs[13]!, evaluate: nr7InsideBreak },
];

export const createTrendBreakoutFamilyScreener: TheoryFamilyScreenerFactory = (
  context,
): PreparedTheoryFamilyScreener => {
  if (context.bars.length === 0)
    return { specs: trendBreakoutSpecs, at: () => [] };
  const series = prepareSeries(context);
  return {
    specs: trendBreakoutSpecs,
    at(index) {
      if (!usable(series, index)) return [];
      const matches: TheoryScreenMatch[] = [];
      for (const { spec, evaluate } of evaluators) {
        if (index < spec.warmupBars) continue;
        const match = evaluate(series, index);
        if (match) matches.push(match);
      }
      return matches;
    },
  };
};
