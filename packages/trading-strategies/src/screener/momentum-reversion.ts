import type { Bar } from "trading-strategy-core/bars";
import {
  boll,
  cci,
  kdj,
  ma,
  macd,
  rsi,
  williamsR,
  type IndicatorValue,
} from "trading-strategy-core/indicators";
import {
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

const definitions = [
  [
    "f10-rps-triple-red",
    "F10.06",
    "多周期 RPS 三线红领涨",
    65,
    "20/50/120 日相对强度同时处于前列，收盘突破十日前高。",
  ],
  [
    "f10-rps-turnaround",
    "F10.06",
    "短周期 RPS 上穿长线拐点",
    65,
    "短线相对强度跃升而长线仍未过热，突破二十日高点确认拐点。",
  ],
  [
    "f10-dual-momentum-12-1",
    "F10.05",
    "双动量与跳期动量突破",
    130,
    "跳期与绝对动量领先基准，十日消化后突破短期前高。",
  ],
  [
    "f12-trend-rsi2-pullback",
    "F12.10",
    "多头趋势 RSI2/IBS 极值低吸",
    125,
    "长期多头趋势中两日 RSI 或 IBS 极端超卖后右侧收复。",
  ],
  [
    "f12-bollinger-zscore-reentry",
    "F12.02",
    "布林回带与 Z-Score 极值回归",
    65,
    "价格跌破布林下轨或 Z-Score 极值后重新收回带内。",
  ],
  [
    "f12-oscillator-divergence-reclaim",
    "F12.05",
    "CCI/威廉/KDJ 超卖重夺共振",
    65,
    "CCI、威廉与 KDJ 至少两项自超卖区回升并收复前高。",
  ],
  [
    "f12-five-factor-confluence",
    "F03.06",
    "波段五维指标共振突破",
    65,
    "放量突破二十日高点，趋势/MACD/KDJ/RSI/布林五项至少四项共振。",
  ],
] as const;

export const momentumReversionSpecs: readonly TheoryScreenerMethodSpec[] =
  definitions.map(([id, theoryId, label, warmupBars, description]) => ({
    id,
    theoryId,
    family: "momentum-reversion",
    label,
    direction: "long",
    warmupBars,
    description,
  }));

type BollPoint = ReturnType<typeof boll>[number];
type KdjPoint = ReturnType<typeof kdj>[number];
type MacdPoint = ReturnType<typeof macd>[number];

type Series = {
  context: TheoryScreenContext;
  bars: readonly Bar[];
  ma10: IndicatorValue[];
  ma20: IndicatorValue[];
  ma60: IndicatorValue[];
  ma120: IndicatorValue[];
  rsi2: IndicatorValue[];
  rsi14: IndicatorValue[];
  boll20: BollPoint[];
  cci20: IndicatorValue[];
  williams14: IndicatorValue[];
  kdj9: KdjPoint[];
  macd: MacdPoint[];
};

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

/** Close-to-close return over `lookback` bars; null when history is short. */
function returnOver(
  bars: readonly Bar[],
  index: number,
  lookback: number,
): number | null {
  const anchor = index - lookback;
  const now = bars[index]?.close;
  const then = anchor >= 0 ? bars[anchor]?.close : undefined;
  if (!Number.isFinite(now) || !Number.isFinite(then) || !(then! > 0))
    return null;
  return now! / then! - 1;
}

function highOver(
  bars: readonly Bar[],
  start: number,
  end: number,
): number | null {
  if (!isValidBarRange(bars, start, end)) return null;
  let high = -Infinity;
  for (let i = start; i <= end; i++) high = Math.max(high, bars[i]!.high);
  return high;
}

function line(
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

function scoreOf(
  volumeRatio: number | null,
  rewardMultiple: number,
  base: number,
): number {
  return clampScore(
    base +
      (volumeRatio !== null && volumeRatio >= 1.5 ? 0.5 : 0) +
      (rewardMultiple >= 3 ? 0.5 : 0),
  );
}

type MatchDraft = {
  pivotPrice: number | null;
  stopPrice: number;
  targetPrice: number;
  volumeRatio: number | null;
  baseScore: number;
  summary: string;
  lines: TheoryGeometryLine[];
};

/** Long-only builder; refuses drafts without positive risk and reward. */
function buildMatch(
  series: Series,
  index: number,
  spec: TheoryScreenerMethodSpec,
  draft: MatchDraft,
): TheoryScreenMatch | null {
  const bar = series.bars[index]!;
  const rewardMultiple = computeRewardMultiple(
    "long",
    bar.close,
    draft.stopPrice,
    draft.targetPrice,
  );
  if (rewardMultiple === null) return null;
  return {
    family: "momentum-reversion",
    methodId: spec.id,
    theoryId: spec.theoryId,
    label: spec.label,
    direction: "long",
    index,
    date: bar.date,
    close: bar.close,
    pivotPrice: draft.pivotPrice,
    stopPrice: draft.stopPrice,
    targetPrice: draft.targetPrice,
    rewardMultiple,
    volumeRatio: draft.volumeRatio,
    score: scoreOf(draft.volumeRatio, rewardMultiple, draft.baseScore),
    summary: draft.summary,
    geometry: { lines: draft.lines },
  };
}

function prepareSeries(context: TheoryScreenContext): Series {
  const bars = context.bars;
  return {
    context,
    bars,
    ma10: ma(bars, 10),
    ma20: ma(bars, 20),
    ma60: ma(bars, 60),
    ma120: ma(bars, 120),
    // 核心 RSI 只暴露 6/12/24，用两个同周期三元组分别取 RSI2 与 RSI14。
    rsi2: rsi(bars, [2, 2, 2]).map((point) => point.rsi6),
    rsi14: rsi(bars, [14, 14, 14]).map((point) => point.rsi6),
    boll20: boll(bars, 20, 2),
    cci20: cci(bars, 20),
    williams14: williamsR(bars, 14),
    kdj9: kdj(bars),
    macd: macd(bars),
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

/** F10.06 多周期 RPS 三线红：20/50/120 日强度同时领先并突破十日前高。 */
function rpsTripleRed(
  series: Series,
  i: number,
  spec: TheoryScreenerMethodSpec,
) {
  const bars = series.bars;
  const bar = bars[i]!;
  const prev = bars[i - 1]!;
  const ma20 = valueAt(series.ma20, i);
  const ma60 = valueAt(series.ma60, i);
  if (ma20 === null || ma60 === null || !(ma20 > ma60)) return null;
  const prior10High = highOver(bars, i - 10, i - 1);
  if (
    prior10High === null ||
    !(bar.close > prior10High && prev.close <= prior10High)
  )
    return null;
  const rps = series.context.rpsAt;
  let red: boolean;
  if (rps) {
    const point = rps(i);
    red =
      (point?.rps20 ?? 0) >= 85 &&
      (point?.rps50 ?? 0) >= 85 &&
      (point?.rps120 ?? 0) >= 85;
  } else {
    const r20 = returnOver(bars, i, 20);
    const r50 = returnOver(bars, i, 50);
    const r120 = returnOver(bars, i, 120);
    red =
      r20 !== null &&
      r50 !== null &&
      r120 !== null &&
      r20 >= 0.15 &&
      r50 >= 0.25 &&
      r120 >= 0.35;
  }
  if (!red) return null;
  const stopPrice = Math.min(ma20, bar.close * 0.94);
  const targetPrice = bar.close + 2.5 * (bar.close - stopPrice);
  return buildMatch(series, i, spec, {
    pivotPrice: prior10High,
    stopPrice,
    targetPrice,
    volumeRatio: priorVolumeRatio(bars, i),
    baseScore: 4,
    summary: `多周期 RPS 三线红领涨，收盘 ${price(bar.close)} 突破十日前高 ${price(prior10High)}`,
    lines: [
      line(series, "RPS 领涨突破", "upper", i - 10, i, prior10High, "solid"),
      line(series, "MA20 支撑", "lower", i - 20, i, ma20),
    ],
  });
}

/** F10.06 短线 RPS 跃升而长线未过热，突破二十日高点确认拐点。 */
function rpsTurnaround(
  series: Series,
  i: number,
  spec: TheoryScreenerMethodSpec,
) {
  const bars = series.bars;
  const bar = bars[i]!;
  const prev = bars[i - 1]!;
  const prior20High = highOver(bars, i - 20, i - 1);
  const ma20 = valueAt(series.ma20, i);
  if (prior20High === null || ma20 === null) return null;
  const breakout = bar.close > prior20High && prev.close <= prior20High;
  if (!breakout) return null;
  const rps = series.context.rpsAt;
  let triggered: boolean;
  if (rps) {
    const now = rps(i);
    const before = rps(i - 1);
    const has10 =
      now?.rps10 != null &&
      Number.isFinite(now.rps10) &&
      before?.rps10 != null &&
      Number.isFinite(before.rps10);
    const shortNow = has10 ? now?.rps10 : now?.rps20;
    const shortBefore = has10 ? before?.rps10 : before?.rps20;
    const longNow = now?.rps120;
    triggered =
      shortNow != null &&
      Number.isFinite(shortNow) &&
      shortNow >= 85 &&
      shortBefore != null &&
      Number.isFinite(shortBefore) &&
      shortBefore < 85 &&
      shortNow > shortBefore &&
      longNow != null &&
      Number.isFinite(longNow) &&
      longNow < 75;
  } else {
    const surge = returnOver(bars, i, 20);
    // [i-60, i-20] 的基准涨幅：以 i-20 为终点回看 40 根。
    const base = returnOver(bars, i - 20, 40);
    triggered =
      surge !== null && surge >= 0.18 && base !== null && base <= 0.05;
  }
  if (!triggered) return null;
  const stopPrice = Math.min(ma20, bar.close * 0.93);
  const targetPrice = bar.close + 2.5 * (bar.close - stopPrice);
  return buildMatch(series, i, spec, {
    pivotPrice: prior20High,
    stopPrice,
    targetPrice,
    volumeRatio: priorVolumeRatio(bars, i),
    baseScore: 3.5,
    summary: `短周期强度自低位跃升，收盘 ${price(bar.close)} 突破二十日高点 ${price(prior20High)}`,
    lines: [
      line(series, "拐点突破", "upper", i - 20, i, prior20High, "solid"),
      line(series, "MA20 支撑", "lower", i - 20, i, ma20),
    ],
  });
}

/** Latest observed benchmark close on or before the stock date. */
function benchmarkBarAt(
  bars: readonly Bar[],
  firstDate: string,
  targetDate: string,
): Bar | null {
  let left = 0;
  let right = bars.length;
  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if (bars[mid]!.date <= targetDate) left = mid + 1;
    else right = mid;
  }
  const bar = bars[left - 1];
  return bar &&
    bar.date >= firstDate &&
    Number.isFinite(bar.close) &&
    bar.close > 0
    ? bar
    : null;
}

/** F10.05 跳期与绝对动量领先，十日消化后突破短期前高。 */
function dualMomentum(
  series: Series,
  i: number,
  spec: TheoryScreenerMethodSpec,
) {
  if (i < 120) return null;
  const bars = series.bars;
  const bar = bars[i]!;
  const prev = bars[i - 1]!;
  const base = bars[i - 120]!.close;
  const mid = bars[i - 10]!.close;
  if (!(base > 0) || !(mid > 0)) return null;
  const skipReturn = mid / base - 1;
  if (!(skipReturn >= 0.2) || !(bar.close > base)) return null;
  const benchmark = series.context.benchmarkBars;
  if (benchmark !== undefined) {
    const then = benchmarkBarAt(benchmark, bars[0]!.date, bars[i - 120]!.date);
    const now = benchmarkBarAt(
      benchmark,
      bars[Math.max(0, i - 20)]!.date,
      bars[i - 10]!.date,
    );
    if (
      then === null ||
      now === null ||
      now.date <= then.date ||
      skipReturn < now.close / then.close - 1
    )
      return null;
  }
  if (Math.abs(bar.close / mid - 1) > 0.12) return null;
  const prior10High = highOver(bars, i - 10, i - 1);
  if (
    prior10High === null ||
    !(bar.close > prior10High && prev.close <= prior10High)
  )
    return null;
  const ma20 = valueAt(series.ma20, i);
  if (ma20 === null) return null;
  const stopPrice = Math.min(ma20, bar.close * 0.93);
  const targetPrice = bar.close + 2.5 * (bar.close - stopPrice);
  return buildMatch(series, i, spec, {
    pivotPrice: prior10High,
    stopPrice,
    targetPrice,
    volumeRatio: priorVolumeRatio(bars, i),
    baseScore: 4,
    summary: `跳期动量 ${(skipReturn * 100).toFixed(1)}% 领先，消化后收盘 ${price(bar.close)} 突破 ${price(prior10High)}`,
    lines: [
      line(series, "消化后突破", "upper", i - 10, i, prior10High, "solid"),
      line(series, "MA20 支撑", "lower", i - 20, i, ma20),
    ],
  });
}

/** F12.10 多头趋势中 RSI2/IBS 极端超卖后的右侧收复。 */
function rsi2Pullback(
  series: Series,
  i: number,
  spec: TheoryScreenerMethodSpec,
) {
  const bars = series.bars;
  const bar = bars[i]!;
  const prev = bars[i - 1]!;
  const ma10 = valueAt(series.ma10, i);
  const ma60 = valueAt(series.ma60, i);
  const ma120 = valueAt(series.ma120, i);
  if (ma60 === null || ma120 === null || !(bar.close > ma120 && ma60 > ma120))
    return null;
  const prevRsi2 = valueAt(series.rsi2, i - 1);
  const ibs = (prev.close - prev.low) / (prev.high - prev.low + 1e-9);
  const lowerCloses =
    i >= 3 &&
    prev.close < bars[i - 2]!.close &&
    bars[i - 2]!.close < bars[i - 3]!.close;
  if (!((prevRsi2 !== null && prevRsi2 < 15) || (ibs < 0.15 && lowerCloses)))
    return null;
  if (!(bar.close > bar.open && bar.close > prev.close)) return null;
  const stopPrice = Math.min(bar.low, prev.low) * 0.98;
  const targetPrice = Math.max(
    ma10 ?? bar.close * 1.06,
    bar.close + 2 * (bar.close - stopPrice),
  );
  return buildMatch(series, i, spec, {
    pivotPrice: prev.close,
    stopPrice,
    targetPrice,
    volumeRatio: priorVolumeRatio(bars, i),
    baseScore: 3.5,
    summary: `多头趋势中回撤至超卖（RSI2 ${prevRsi2 === null ? "-" : prevRsi2.toFixed(1)}），收盘 ${price(bar.close)} 阳线收复前收 ${price(prev.close)}`,
    lines: [
      line(series, "前收收复", "upper", i - 1, i, prev.close),
      line(series, "MA120 趋势", "lower", i - 20, i, ma120, "solid"),
    ],
  });
}

/** F12.02 跌破布林下轨或 Z-Score 极值后重新收回带内。 */
function bollingerReentry(
  series: Series,
  i: number,
  spec: TheoryScreenerMethodSpec,
) {
  const bars = series.bars;
  const bar = bars[i]!;
  const prev = bars[i - 1]!;
  const ma60 = valueAt(series.ma60, i);
  const ma60Past = valueAt(series.ma60, i - 10);
  if (ma60 === null || ma60Past === null || !(ma60 >= ma60Past * 0.97))
    return null;
  const band = series.boll20[i];
  const priorBand = series.boll20[i - 1];
  if (!band || !priorBand) return null;
  const { mid, lower } = band;
  const { upper: priorUpper, lower: priorLower, mid: priorMid } = priorBand;
  if (
    typeof mid !== "number" ||
    typeof lower !== "number" ||
    !Number.isFinite(lower) ||
    lower <= 0 ||
    typeof priorUpper !== "number" ||
    typeof priorLower !== "number" ||
    typeof priorMid !== "number"
  )
    return null;
  const width = priorUpper - priorLower;
  const z = width > 0 ? (prev.close - priorMid) / (width / 4) : null;
  if (!(prev.close < priorLower || (z !== null && z < -2))) return null;
  if (!(bar.close > lower && bar.close > bar.open && bar.close > prev.high))
    return null;
  const stopPrice = Math.min(bar.low, prev.low) * 0.985;
  const targetPrice = Math.max(mid, bar.close + 1.8 * (bar.close - stopPrice));
  return buildMatch(series, i, spec, {
    pivotPrice: lower,
    stopPrice,
    targetPrice,
    volumeRatio: priorVolumeRatio(bars, i),
    baseScore: 3.5,
    summary: `前一日收于布林下轨 ${price(priorLower)} 下方，收盘 ${price(bar.close)} 重新站回 ${price(lower)}`,
    lines: [
      line(series, "布林下轨", "lower", i - 20, i, lower, "solid"),
      line(series, "布林中轨", "neckline", i - 20, i, mid),
    ],
  });
}

/** F12.05 CCI/威廉/KDJ 至少两项自超卖区重夺，且收复前高。 */
function oscillatorReclaim(
  series: Series,
  i: number,
  spec: TheoryScreenerMethodSpec,
) {
  const bars = series.bars;
  const bar = bars[i]!;
  const prev = bars[i - 1]!;
  const ma60 = valueAt(series.ma60, i);
  const ma60Past = valueAt(series.ma60, i - 10);
  if (
    ma60 === null ||
    ma60Past === null ||
    !(bar.close >= ma60 * 0.98 && ma60 >= ma60Past * 0.99)
  )
    return null;
  const cciPrev = valueAt(series.cci20, i - 1);
  const cciNow = valueAt(series.cci20, i);
  const williamsPrev = valueAt(series.williams14, i - 1);
  const williamsNow = valueAt(series.williams14, i);
  const kdjPrev = series.kdj9[i - 1];
  const kdjNow = series.kdj9[i];
  let votes = 0;
  if (cciPrev !== null && cciNow !== null && cciPrev < -100 && cciNow >= -100)
    votes++;
  if (
    williamsPrev !== null &&
    williamsNow !== null &&
    williamsPrev < -80 &&
    williamsNow >= -80
  )
    votes++;
  if (
    kdjPrev &&
    kdjNow &&
    typeof kdjPrev.k === "number" &&
    typeof kdjPrev.d === "number" &&
    typeof kdjPrev.j === "number" &&
    typeof kdjNow.k === "number" &&
    typeof kdjNow.d === "number" &&
    kdjPrev.k <= kdjPrev.d &&
    kdjNow.k > kdjNow.d &&
    kdjPrev.j < 20
  )
    votes++;
  if (votes < 2 || !(bar.close > prev.high)) return null;
  const stopPrice = Math.min(bar.low, prev.low) * 0.985;
  const targetPrice = bar.close + 2.2 * (bar.close - stopPrice);
  return buildMatch(series, i, spec, {
    pivotPrice: prev.high,
    stopPrice,
    targetPrice,
    volumeRatio: priorVolumeRatio(bars, i),
    baseScore: 3 + 0.5 * (votes - 2),
    summary: `${votes} 项振荡指标自超卖区回升，收盘 ${price(bar.close)} 收复前高 ${price(prev.high)}`,
    lines: [
      line(series, "前高重夺", "upper", i - 1, i, prev.high, "solid"),
      line(series, "MA60 支撑", "lower", i - 20, i, ma60),
    ],
  });
}

/** F03.06 放量突破二十日高点，五项技术共振至少四项成立。 */
function fiveFactorConfluence(
  series: Series,
  i: number,
  spec: TheoryScreenerMethodSpec,
) {
  const bars = series.bars;
  const bar = bars[i]!;
  const prev = bars[i - 1]!;
  const prior20High = highOver(bars, i - 20, i - 1);
  if (prior20High === null) return null;
  const volumeRatio = priorVolumeRatio(bars, i);
  if (volumeRatio === null || volumeRatio < 1.3) return null;
  if (!(bar.close > prior20High && prev.close <= prior20High)) return null;
  const ma10 = valueAt(series.ma10, i);
  const ma20 = valueAt(series.ma20, i);
  const ma60 = valueAt(series.ma60, i);
  const macdPoint = series.macd[i];
  const kdjPoint = series.kdj9[i];
  const rsiNow = valueAt(series.rsi14, i);
  const band = series.boll20[i];
  const priorBand = series.boll20[i - 1];
  let votes = 0;
  if (
    ma10 !== null &&
    ma20 !== null &&
    ma60 !== null &&
    ma10 > ma20 &&
    ma20 > ma60
  )
    votes++;
  if (
    macdPoint &&
    typeof macdPoint.dif === "number" &&
    typeof macdPoint.dea === "number" &&
    typeof macdPoint.macd === "number" &&
    macdPoint.dif > macdPoint.dea &&
    macdPoint.macd > 0
  )
    votes++;
  if (
    kdjPoint &&
    typeof kdjPoint.k === "number" &&
    typeof kdjPoint.d === "number" &&
    kdjPoint.k > kdjPoint.d &&
    kdjPoint.k < 85
  )
    votes++;
  if (rsiNow !== null && rsiNow >= 52 && rsiNow <= 78) votes++;
  if (
    band &&
    priorBand &&
    typeof band.mid === "number" &&
    typeof band.upper === "number" &&
    typeof priorBand.upper === "number" &&
    bar.close > band.mid &&
    band.upper > priorBand.upper
  )
    votes++;
  if (votes < 4 || ma20 === null) return null;
  const stopPrice = Math.min(ma20, bar.close * 0.94);
  const targetPrice = bar.close + 2.5 * (bar.close - stopPrice);
  return buildMatch(series, i, spec, {
    pivotPrice: prior20High,
    stopPrice,
    targetPrice,
    volumeRatio,
    baseScore: 4,
    summary: `放量 ${volumeRatio.toFixed(2)} 倍突破二十日高点 ${price(prior20High)}，五项指标共振 ${votes}/5`,
    lines: [
      line(series, "二十日高突破", "upper", i - 20, i, prior20High, "solid"),
      line(series, "MA20 支撑", "lower", i - 20, i, ma20),
    ],
  });
}

const evaluators: readonly ((
  series: Series,
  index: number,
  spec: TheoryScreenerMethodSpec,
) => TheoryScreenMatch | null)[] = [
  rpsTripleRed,
  rpsTurnaround,
  dualMomentum,
  rsi2Pullback,
  bollingerReentry,
  oscillatorReclaim,
  fiveFactorConfluence,
];

export const createMomentumReversionFamilyScreener: TheoryFamilyScreenerFactory =
  (context): PreparedTheoryFamilyScreener => {
    if (context.bars.length === 0)
      return { specs: momentumReversionSpecs, at: () => [] };
    const series = prepareSeries(context);
    return {
      specs: momentumReversionSpecs,
      at(index) {
        if (!usable(series, index)) return [];
        const matches: TheoryScreenMatch[] = [];
        for (let m = 0; m < evaluators.length; m++) {
          const spec = momentumReversionSpecs[m]!;
          if (index < spec.warmupBars) continue;
          const match = evaluators[m]!(series, index, spec);
          if (match) matches.push(match);
        }
        return matches;
      },
    };
  };
