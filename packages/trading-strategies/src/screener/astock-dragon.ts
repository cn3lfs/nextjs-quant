import type { Bar } from "trading-strategy-core/bars";
import { ma } from "trading-strategy-core/indicators";
import {
  astockPriceLimitRatio,
  clampScore,
  computeRewardMultiple,
  isAstockLimitUp,
  isValidBarRange,
  makeGeometryLine,
  meanVolume,
  priorVolumeRatio,
} from "./helpers.js";
import type {
  TheoryFamilyScreenerFactory,
  TheoryGeometryLine,
  TheoryScreenContext,
  TheoryScreenMatch,
  TheoryScreenerMethodSpec,
} from "./types.js";

const FAMILY = "astock-dragon" as const;
/** Percentage thresholds are exact in trading rules but not in binary floats. */
const EPSILON = 1e-9;

function spec(
  slug: string,
  theoryId: string,
  label: string,
  warmupBars: number,
  description: string,
): TheoryScreenerMethodSpec {
  return {
    id: "f11-" + slug,
    theoryId,
    family: FAMILY,
    label,
    warmupBars,
    description,
    direction: "long",
  };
}

const trendLeader = spec(
  "trend-leader",
  "F11.02",
  "A股趋势容量主升龙头",
  65,
  "均线多头、缩量回踩后放量突破十日高点",
);
const firstLimitUp = spec(
  "first-limit-up-break",
  "F11.04",
  "底部平台首板换手突破",
  30,
  "底部窄幅平台内首个换手涨停突破箱体",
);
const limitUpStreak = spec(
  "limit-up-streak",
  "F11.03",
  "连板身位龙头与涨停基因",
  25,
  "连续涨停形成身位优势并保留承接换手",
);
const weakToStrong = spec(
  "weak-to-strong",
  "F11.08",
  "分歧转一致与弱转强突破",
  25,
  "强势后分歧承接，次日放量转一致",
);
const dragonFirstYin = spec(
  "dragon-first-yin",
  "F11.09",
  "强势龙头首阴缩量承接",
  25,
  "主升龙头首次收阴且缩量守住十日均线",
);
const bullishReclaim = spec(
  "bullish-reclaim-cannon",
  "F11.10",
  "阳包阴反包与双阳夹阴",
  25,
  "强势阳线后单日回调，次日阳包阴收复",
);
const dragonSecondWave = spec(
  "dragon-second-wave",
  "F11.11",
  "人气龙头缩量回调二波启动",
  45,
  "一波主升后缩量回调，二次放量启动",
);

export const astockDragonSpecs: readonly TheoryScreenerMethodSpec[] = [
  trendLeader,
  firstLimitUp,
  limitUpStreak,
  weakToStrong,
  dragonFirstYin,
  bullishReclaim,
  dragonSecondWave,
];

type Point = { index: number; price: number };

function valid(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function highestPoint(bars: readonly Bar[], start: number, end: number): Point {
  let index = start;
  for (let i = start + 1; i <= end; i++)
    if (bars[i]!.high > bars[index]!.high) index = i;
  return { index, price: bars[index]!.high };
}

function highest(bars: readonly Bar[], start: number, end: number): number {
  return highestPoint(bars, start, end).price;
}

function lowest(bars: readonly Bar[], start: number, end: number): number {
  let price = bars[start]!.low;
  for (let i = start + 1; i <= end; i++) price = Math.min(price, bars[i]!.low);
  return price;
}

function lowestClose(bars: readonly Bar[], start: number, end: number): number {
  let price = bars[start]!.close;
  for (let i = start + 1; i <= end; i++)
    price = Math.min(price, bars[i]!.close);
  return price;
}

function maxDrawdown(bars: readonly Bar[], start: number, end: number): number {
  let peak = -Infinity;
  let worst = 0;
  for (let i = start; i <= end; i++) {
    const close = bars[i]!.close;
    peak = Math.max(peak, close);
    if (peak > 0) worst = Math.max(worst, (peak - close) / peak);
  }
  return worst;
}

function isLimitUpAt(
  bars: readonly Bar[],
  index: number,
  symbol?: string,
): boolean {
  return (
    index >= 1 &&
    isAstockLimitUp(bars[index - 1]!.close, bars[index]!.close, symbol)
  );
}

function limitUpsBetween(
  bars: readonly Bar[],
  start: number,
  end: number,
  symbol?: string,
): number {
  let count = 0;
  for (let i = Math.max(1, start); i <= end; i++)
    if (isLimitUpAt(bars, i, symbol)) count++;
  return count;
}

function isSurgeAt(bars: readonly Bar[], index: number, symbol?: string) {
  if (index < 1) return false;
  const prevClose = bars[index - 1]!.close;
  return (
    isAstockLimitUp(prevClose, bars[index]!.close, symbol) ||
    (prevClose > 0 && bars[index]!.close / prevClose - 1 >= 0.07 - EPSILON)
  );
}

function horizontal(
  bars: readonly Bar[],
  label: string,
  kind: TheoryGeometryLine["kind"],
  start: number,
  end: number,
  price: number,
): TheoryGeometryLine {
  return makeGeometryLine(bars, label, kind, "solid", [
    { index: start, price },
    { index: end, price },
  ]);
}

function trendLine(
  bars: readonly Bar[],
  label: string,
  kind: TheoryGeometryLine["kind"],
  start: number,
  startPrice: number | null | undefined,
  end: number,
  endPrice: number | null | undefined,
  fallback: number,
): TheoryGeometryLine {
  return makeGeometryLine(bars, label, kind, "solid", [
    { index: start, price: valid(startPrice) ? startPrice : fallback },
    { index: end, price: valid(endPrice) ? endPrice : fallback },
  ]);
}

type Session = {
  bars: readonly Bar[];
  symbol?: string;
  ma10: readonly (number | null)[];
  ma20: readonly (number | null)[];
  ma60: readonly (number | null)[];
  rpsAt?: TheoryScreenContext["rpsAt"];
  i: number;
  bar: Bar;
  prev: Bar;
  volumeRatio: number;
  matches: TheoryScreenMatch[];
  emit: (
    method: TheoryScreenerMethodSpec,
    pivotPrice: number,
    stopPrice: number,
    targetPrice: number,
    lines: TheoryGeometryLine[],
    score: number,
    summary: string,
  ) => void;
};

function detectTrendLeader(s: Session) {
  const { bars, ma10, ma20, ma60, i, bar, prev, volumeRatio } = s;
  const m10 = ma10[i];
  const m20 = ma20[i];
  const m60 = ma60[i];
  const m60Before = ma60[i - 10];
  if (!valid(m10) || !valid(m20) || !valid(m60) || !valid(m60Before)) return;
  if (!(m10 > m20 && m20 > m60 && m60 > m60Before)) return;
  const prior10High = highest(bars, i - 10, i - 1);
  if (!(bar.close > prior10High && prev.close <= prior10High)) return;
  if (volumeRatio < 1.2) return;
  const return20 =
    bars[i - 20]!.close > 0 ? bar.close / bars[i - 20]!.close - 1 : -Infinity;
  const rps = s.rpsAt?.(i);
  const leader =
    return20 >= 0.15 - EPSILON ||
    (rps?.rps20 ?? -Infinity) >= 85 ||
    (rps?.rps50 ?? -Infinity) >= 85;
  if (!leader || maxDrawdown(bars, i - 15, i) > 0.15 + EPSILON) return;
  // 1–5 bar pause holding above MA20 before the breakout.
  if (lowestClose(bars, i - 5, i - 1) < m20) return;
  const stop = m20;
  const target = bar.close + 2.5 * (bar.close - stop);
  const gain = valid(return20) ? `${(return20 * 100).toFixed(1)}%` : "相对强势";
  s.emit(
    trendLeader,
    prior10High,
    stop,
    target,
    [
      horizontal(bars, "10日高点", "upper", i - 10, i, prior10High),
      trendLine(bars, "MA20 支撑", "lower", i - 5, ma20[i - 5], i, m20, m20),
    ],
    return20 >= 0.25 || (rps?.rps50 ?? 0) >= 90 ? 5 : 4,
    `趋势龙头：20日涨幅${gain}，回踩不破 MA20 后放量突破`,
  );
}

function detectFirstLimitUpBreak(s: Session) {
  const { bars, symbol, i, bar, prev, volumeRatio } = s;
  if (!isAstockLimitUp(prev.close, bar.close, symbol)) return;
  if (isLimitUpAt(bars, i - 1, symbol)) return;
  // An unbuyable one-word board needs exceptional volume to count as turnover.
  if (!(bar.low < bar.high || volumeRatio >= 1.3)) return;
  const boxHigh = highest(bars, i - 20, i - 1);
  const boxLow = lowest(bars, i - 20, i - 1);
  if (!(boxLow > 0 && (boxHigh - boxLow) / boxLow <= 0.25 + EPSILON)) return;
  if (!(bar.close > boxHigh)) return;
  const stop = Math.max(boxLow, prev.close);
  const target = bar.close * (1 + 2 * astockPriceLimitRatio(symbol));
  s.emit(
    firstLimitUp,
    boxHigh,
    stop,
    target,
    [
      horizontal(bars, "箱体上沿", "upper", i - 20, i - 1, boxHigh),
      horizontal(bars, "箱体下沿", "lower", i - 20, i - 1, boxLow),
    ],
    volumeRatio >= 1.5 || (boxHigh - boxLow) / boxLow <= 0.12 ? 5 : 4,
    `底部平台首板：换手涨停突破 ${boxHigh.toFixed(2)} 箱体上沿`,
  );
}

function detectLimitUpStreak(s: Session) {
  const { bars, symbol, i, bar, prev, volumeRatio } = s;
  let streak = 0;
  for (let k = i; k >= 1; k--) {
    if (!isLimitUpAt(bars, k, symbol)) break;
    streak++;
  }
  if (streak < 2) return;
  if (!(bar.low < bar.high || volumeRatio >= 0.8)) return;
  const target = bar.close * (1 + 1.5 * astockPriceLimitRatio(symbol));
  s.emit(
    limitUpStreak,
    prev.close,
    prev.low,
    target,
    [
      horizontal(bars, "连板枢轴", "upper", i - 1, i, prev.close),
      horizontal(bars, "承接止损", "lower", i - 1, i, prev.low),
    ],
    streak >= 3 ? 5 : 4,
    `${streak}连板：涨停基因清晰，关注承接换手`,
  );
}

function detectWeakToStrong(s: Session) {
  const { bars, ma10, i, bar, prev, volumeRatio } = s;
  const m10Before = ma10[i - 1];
  if (!valid(m10Before)) return;
  let strong = false;
  for (let k = i - 6; k <= i - 2 && !strong; k++)
    strong = isSurgeAt(bars, k, s.symbol);
  if (!strong) return;
  const upperShadow =
    (prev.high - prev.close) / prev.close >= 0.03 - EPSILON &&
    prev.high >= bars[i - 2]!.close * 1.05;
  const redPullback = prev.close < prev.open && prev.close < bars[i - 2]!.close;
  if (!(upperShadow || redPullback)) return;
  if (prev.close < m10Before) return;
  if (!(bar.close > prev.high && bar.close > bar.open)) return;
  if (volumeRatio < 1.2 && !isAstockLimitUp(prev.close, bar.close, s.symbol))
    return;
  const stop = Math.min(bar.low, prev.low);
  const target = bar.close + 2 * (bar.close - stop);
  s.emit(
    weakToStrong,
    prev.high,
    stop,
    target,
    [
      horizontal(bars, "弱转强枢轴", "upper", i - 2, i, prev.high),
      trendLine(
        bars,
        "MA10 承接",
        "lower",
        i - 1,
        m10Before,
        i,
        ma10[i],
        m10Before,
      ),
    ],
    isAstockLimitUp(prev.close, bar.close, s.symbol) ? 5 : 4,
    "弱转强：分歧承接后放量转一致，收复前日高点",
  );
}

function detectDragonFirstYin(s: Session) {
  const { bars, ma10, symbol, i, bar, prev } = s;
  const m10 = ma10[i];
  if (!valid(m10)) return;
  const fiveBarGain =
    bars[i - 6]!.close > 0 ? bars[i - 1]!.close / bars[i - 6]!.close - 1 : -1;
  const limitUps = limitUpsBetween(bars, i - 5, i - 1, symbol);
  if (!(limitUps >= 2 || fiveBarGain >= 0.22 - EPSILON)) return;
  for (let k = i - 3; k <= i - 1; k++)
    if (bars[k]!.close < bars[k]!.open) return;
  if (!(bar.close < bar.open || bar.close < prev.close)) return;
  if (!(bar.close >= m10 && bar.low >= m10 * 0.985)) return;
  if (!(bar.volume <= prev.volume * 0.95)) return;
  const stop = Math.min(bar.low, m10) * 0.98;
  const target = Math.max(bar.high, prev.high) * 1.12;
  s.emit(
    dragonFirstYin,
    bar.high,
    stop,
    target,
    [
      horizontal(bars, "首阴高点", "upper", i - 1, i, bar.high),
      trendLine(bars, "MA10 承接", "lower", i - 5, ma10[i - 5], i, m10, m10),
    ],
    limitUps >= 2 || fiveBarGain >= 0.4 ? 5 : 4,
    "龙头首阴：强势后缩量回踩，守住 MA10 承接",
  );
}

function detectBullishReclaim(s: Session) {
  const { bars, ma20, i, bar, prev } = s;
  const strongBar = bars[i - 2]!;
  const m20 = ma20[i];
  if (!valid(m20)) return;
  const strong =
    isAstockLimitUp(bars[i - 3]!.close, strongBar.close, s.symbol) ||
    strongBar.close / bars[i - 3]!.close - 1 >= 0.05 - EPSILON;
  if (!strong) return;
  if (!(prev.close < prev.open && prev.low >= strongBar.low)) return;
  if (!(
    bar.close > bar.open &&
    bar.close > prev.high &&
    bar.close > strongBar.close &&
    bar.close > m20
  ))
    return;
  const stop = Math.min(bar.low, prev.low);
  const target = bar.close + 2 * (bar.close - stop);
  s.emit(
    bullishReclaim,
    prev.high,
    stop,
    target,
    [
      horizontal(bars, "反包枢轴", "upper", i - 1, i, prev.high),
      horizontal(bars, "回调低点", "lower", i - 2, i, strongBar.low),
    ],
    bar.close > strongBar.high ||
      isAstockLimitUp(prev.close, bar.close, s.symbol)
      ? 5
      : 4,
    "阳包阴：强势阳线后单日回调，次日反包收复",
  );
}

function detectDragonSecondWave(s: Session) {
  const { bars, ma60, symbol, i, bar, prev, volumeRatio } = s;
  if (i < 45 || !isValidBarRange(bars, i - 35, i)) return;
  const peak = highestPoint(bars, i - 20, i - 5);
  const peakIdx = peak.index;
  const peakHigh = peak.price;
  if (peakIdx < 16) return;
  const waveLow = lowest(bars, peakIdx - 15, peakIdx - 1);
  if (!(waveLow > 0)) return;
  const limitUps = limitUpsBetween(bars, i - 35, peakIdx, symbol);
  const advance = peakHigh / waveLow - 1;
  if (!(advance >= 0.3 - EPSILON || limitUps >= 2)) return;

  const pullStart = peakIdx + 1;
  const pullEnd = i - 1;
  const pullLength = pullEnd - pullStart + 1;
  if (!(pullLength >= 4 && pullLength <= 15)) return;
  const pullLow = lowest(bars, pullStart, pullEnd);
  const retrace = (peakHigh - pullLow) / peakHigh;
  if (!(retrace >= 0.08 - EPSILON && retrace <= 0.25 + EPSILON)) return;
  const m60Before = ma60[i - 1];
  if (!valid(m60Before)) return;
  const halfWave = (peakHigh + waveLow) / 2;
  if (!(pullLow >= m60Before && pullLow >= halfWave)) return;
  const recentVolume = meanVolume(bars, i - 3, i - 1);
  if (recentVolume === null) return;
  if (!(recentVolume < bars[peakIdx]!.volume * 0.75)) return;

  const pivot = highest(bars, i - 3, i - 1);
  if (!(bar.close > bar.open && bar.close > pivot)) return;
  if (!(prev.close <= highest(bars, i - 4, i - 2))) return;
  if (volumeRatio < 1.25) return;
  const stop = lowest(bars, pullStart, i);
  const target = peakHigh + 0.5 * (peakHigh - stop);
  s.emit(
    dragonSecondWave,
    pivot,
    stop,
    target,
    [
      horizontal(bars, "一波峰顶", "upper", peakIdx, i, peakHigh),
      horizontal(bars, "二波枢轴", "neckline", i - 3, i, pivot),
    ],
    advance >= 0.4 || limitUps >= 3 ? 5 : 4,
    "二波启动：一波主升后缩量回调，二次放量突破",
  );
}

const detectors = [
  detectTrendLeader,
  detectFirstLimitUpBreak,
  detectLimitUpStreak,
  detectWeakToStrong,
  detectDragonFirstYin,
  detectBullishReclaim,
  detectDragonSecondWave,
];

export const createAstockDragonFamilyScreener: TheoryFamilyScreenerFactory = (
  context,
) => {
  if (context.bars.length === 0)
    return { specs: astockDragonSpecs, at: () => [] };
  const bars = context.bars;
  const ma10 = ma(bars, 10);
  const ma20 = ma(bars, 20);
  const ma60 = ma(bars, 60);
  return {
    specs: astockDragonSpecs,
    at: (i) => {
      if (!Number.isInteger(i) || i < 20 || i >= bars.length) return [];
      const volumeRatio = priorVolumeRatio(bars, i);
      if (volumeRatio === null) return [];
      const bar = bars[i]!;
      const matches: TheoryScreenMatch[] = [];
      const session: Session = {
        bars,
        symbol: context.symbol,
        ma10,
        ma20,
        ma60,
        rpsAt: context.rpsAt,
        i,
        bar,
        prev: bars[i - 1]!,
        volumeRatio,
        matches,
        emit: (
          method,
          pivotPrice,
          stopPrice,
          targetPrice,
          lines,
          score,
          summary,
        ) => {
          const rewardMultiple = computeRewardMultiple(
            "long",
            bar.close,
            stopPrice,
            targetPrice,
          );
          if (rewardMultiple === null) return;
          matches.push({
            family: FAMILY,
            methodId: method.id,
            theoryId: method.theoryId,
            label: method.label,
            direction: "long",
            index: i,
            date: bar.date,
            close: bar.close,
            pivotPrice,
            stopPrice,
            targetPrice,
            rewardMultiple,
            volumeRatio,
            score: clampScore(score),
            summary,
            geometry: { lines },
          });
        },
      };
      for (const detect of detectors) detect(session);
      return matches;
    },
  };
};
