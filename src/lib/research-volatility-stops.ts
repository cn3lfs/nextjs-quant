import {
  externalVolatilityPoint,
  isExternalVolatility,
  volatilityInputBoundary,
  type VolatilityInput,
} from "./research-volatility-input";
import type { Bar } from "./domain";
import { atr, boll, emaSeries, maSeries, rollingHigh } from "./indicators";
import type { ResearchManagement } from "./research-management";

export const volatilityStopProfiles = {
  "rk-kase": ["RK-V4-kase", "Kase外部偏度参数三级保护"],
  "rk-kase-stages": ["RK-V4-stages", "Kase预警及三级累计减仓"],
  "rk-beta": ["RK-V7-beta", "Beta外部版本化查表止损"],
  "rk-keltner-opposite": ["RK-V3-opposite", "Keltner对侧上轨目标退出"],
  "rk-safezone": ["RK-V6-safezone", "SafeZone EMA22方向/转折截断10日"],
  "rk-sar": ["RK-V8-sar", "SAR 0.02/0.2与Wilder ADX14>25"],
  "rk-boll-lower": ["RK-V2-boll", "布林20/2下轨跟踪"],
  "rk-boll-mid": ["RK-V2-mid", "布林20中轨跟踪"],
  "rk-keltner-lower": ["RK-V3-keltner", "Keltner EMA20减2ATR20跟踪"],
  "rk-keltner-mid": ["RK-V3-mid", "Keltner EMA20中线跟踪"],
  "rk-kaufman": ["RK-V5-kaufman", "Kaufman 20日高点减2倍平均区间"],
  "rk-ema20": ["RK-A4-ema20", "EMA20跟踪止损"],
  "rk-ma60": ["RK-A4-ma60", "MA60跟踪止损"],
  "rk-ma120": ["RK-A4-ma120", "MA120跟踪止损"],
} as const;
export type VolatilityStopId = keyof typeof volatilityStopProfiles;
export const volatilityStopIds = Object.keys(volatilityStopProfiles) as [
  VolatilityStopId,
  ...VolatilityStopId[],
];
export const volatilityStopBoundary =
  volatilityInputBoundary +
  "对侧轨工程v1：双突破做多入场、固定5%保护与1%风险/20%市值，EMA20+2ATR20上轨为独立收盘目标，收盘大于等于上轨后下一开盘退出，不将上轨当止损向上抬。与均值回归入场并不等价。" +
  "波动线工程v1：固定双突破入场，初始5%止损、1%含费风险预算、20%单股上限。收盘以当日完整数据更新线，取旧止损与新线较高者，次日起生效；收盘不高于有效线确认退出，下一可成交开盘执行。缺失/非法窗口保留旧线并记录，不扩宽止损。布林共享样本标准差；Keltner工程冻结EMA20/算术ATR20/2倍；Kaufman工程冻结20日最高价减2倍20日平均H-L，不包含缺口。均线保护同样只升不降，不冒充每日可下降的原始指标线。EMA从首个有效收盘递推，但须20根连续有效行情才启用。SafeZone以EMA22斜率正负切换作为因果重要转折的工程定义，零斜率不启用且不改变方向；向下穿透只在实际穿透日求均值，近10次相邻比较不跨最近转折，无穿透为0，低点减2倍均值。SAR工程冻结首两根收盘决定方向、前两根极值钳制、触碰反转、AF每创新极值加0.02至0.2；仅上升SAR且Wilder ADX14严格大于25启用，弱趋势保留旧保护线。最长持有60交易日；与同入场固定5%止损对照，非盈利证据。";
export function volatilityStopTemplate(
  id: VolatilityStopId,
): ResearchManagement {
  return {
    volatilityStop: id,
    stop: { kind: "percent", fraction: 0.05 },
    confirmations: 1,
    stressBuffer: 0,
    timeExit: null,
    trail: { kind: "volatility", profile: id },
  };
}
function valid(bar: Bar) {
  return (
    [bar.open, bar.high, bar.low, bar.close, bar.volume].every(
      Number.isFinite,
    ) &&
    bar.low > 0 &&
    bar.volume > 0 &&
    bar.high >= Math.max(bar.open, bar.close) &&
    bar.low <= Math.min(bar.open, bar.close)
  );
}
/** Raw causal candidates; the existing portfolio ratchet owns effective stops. */
export function volatilityStopSeries(
  bars: readonly Bar[],
  id: VolatilityStopId,
  calendar: readonly string[] = bars.map((b) => b.date),
  external?: { symbol: string; inputs: readonly VolatilityInput[] },
): (number | null)[] {
  if (isExternalVolatility(id))
    return bars.map((b) => {
      const point = externalVolatilityPoint(
        id,
        bars,
        external?.symbol ?? "",
        b.date,
        external?.inputs,
        calendar,
      );
      return point.status === "available" ? point.stop : null;
    });
  if (id === "rk-safezone" || id === "rk-sar")
    return directionalStopSeries(bars, id, calendar);
  const period = id === "rk-ma120" ? 120 : id === "rk-ma60" ? 60 : 20;
  const closes = bars.map((b) => (valid(b) ? b.close : null));
  const mean = maSeries(closes, period);
  const exponential = emaSeries(closes, 20);
  const bands = boll(bars, 20, 2);
  const ranges = maSeries(
    bars.map((b) => (valid(b) ? b.high - b.low : null)),
    20,
  );
  const highs = rollingHigh(bars, 20);
  const trueRanges = atr(bars, 20);
  const dates = new Set(bars.map((b) => b.date));
  return bars.map((_, i) => {
    if (i < period - 1 || !bars.slice(i - period + 1, i + 1).every(valid))
      return null;
    if (
      calendar.some(
        (date) =>
          date >= bars[i - period + 1]!.date &&
          date <= bars[i]!.date &&
          !dates.has(date),
      )
    )
      return null;
    const value =
      id === "rk-boll-lower"
        ? bands[i]!.lower
        : id === "rk-boll-mid"
          ? bands[i]!.mid
          : id === "rk-keltner-lower" || id === "rk-keltner-opposite"
            ? exponential[i] == null || trueRanges[i] == null
              ? null
              : exponential[i]! +
                (id === "rk-keltner-opposite" ? 2 : -2) * trueRanges[i]!
            : id === "rk-keltner-mid" || id === "rk-ema20"
              ? exponential[i]
              : id === "rk-kaufman"
                ? highs[i] == null || ranges[i] == null
                  ? null
                  : highs[i]! - 2 * ranges[i]!
                : mean[i];
    return value != null && Number.isFinite(value) && value > 0 ? value : null;
  });
}

/** Invalid observations and calendar gaps reset recursive state instead of bridging unknown input. */
export function directionalStopSeries(
  bars: readonly Bar[],
  id: "rk-safezone" | "rk-sar",
  calendar: readonly string[] = bars.map((b) => b.date),
): (number | null)[] {
  const output: (number | null)[] = [];
  let start = 0,
    average = 0,
    direction = 0,
    turn = 0;
  let up = true,
    sar = 0,
    extreme = 0,
    acceleration = 0.02;
  let tr = 0,
    plus = 0,
    minus = 0,
    adx: number | null = null;
  const dx: number[] = [];
  const calendarIndex = new Map(calendar.map((date, i) => [date, i]));
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!,
      prior = bars[i - 1];
    const gap =
      prior &&
      (calendarIndex.get(b.date) ?? -1) !==
        (calendarIndex.get(prior.date) ?? -1) + 1;
    if (!valid(b) || (prior && b.date <= prior.date) || gap) {
      start = valid(b) && gap ? i : i + 1;
      average = valid(b) && gap ? b.close : 0;
      direction = 0;
      turn = start;
      adx = null;
      tr = plus = minus = 0;
      dx.length = 0;
      output.push(null);
      continue;
    }
    if (i === start) {
      average = b.close;
      output.push(null);
      continue;
    }
    const age = i - start;
    const previousAverage = average;
    average += (2 / 23) * (b.close - average);
    const slope = Math.sign(average - previousAverage);
    if (slope && slope !== direction) {
      turn = i;
      direction = slope;
    }
    if (id === "rk-safezone") {
      if (age < 21 || slope <= 0) {
        output.push(null);
        continue;
      }
      let total = 0,
        count = 0;
      for (let j = Math.max(start + 1, turn + 1, i - 9); j <= i; j++) {
        const penetration = bars[j - 1]!.low - bars[j]!.low;
        if (penetration > 0) {
          total += penetration;
          count++;
        }
      }
      const value = b.low - 2 * (count ? total / count : 0);
      output.push(value > 0 ? value : null);
      continue;
    }
    // Wilder TR/DM sums, then the mean of 14 DX values seeds ADX.
    const range = Math.max(
      b.high - b.low,
      Math.abs(b.high - prior!.close),
      Math.abs(b.low - prior!.close),
    );
    const rise = b.high - prior!.high,
      fall = prior!.low - b.low;
    const pdm = rise > fall && rise > 0 ? rise : 0;
    const mdm = fall > rise && fall > 0 ? fall : 0;
    if (age <= 14) {
      tr += range;
      plus += pdm;
      minus += mdm;
    } else {
      tr = tr - tr / 14 + range;
      plus = plus - plus / 14 + pdm;
      minus = minus - minus / 14 + mdm;
    }
    if (age >= 14) {
      const currentDx =
        plus + minus > 0 ? (100 * Math.abs(plus - minus)) / (plus + minus) : 0;
      if (adx == null) {
        dx.push(currentDx);
        if (dx.length === 14) adx = dx.reduce((a, b) => a + b, 0) / 14;
      } else adx = (13 * adx + currentDx) / 14;
    }
    if (age === 1) {
      up = b.close > prior!.close;
      sar = up ? Math.min(prior!.low, b.low) : Math.max(prior!.high, b.high);
      extreme = up
        ? Math.max(prior!.high, b.high)
        : Math.min(prior!.low, b.low);
      acceleration = 0.02;
    } else {
      const candidate = sar + acceleration * (extreme - sar);
      sar = up
        ? Math.min(candidate, prior!.low, bars[i - 2]!.low)
        : Math.max(candidate, prior!.high, bars[i - 2]!.high);
      if ((up && b.low <= sar) || (!up && b.high >= sar)) {
        sar = extreme;
        up = !up;
        extreme = up ? b.high : b.low;
        acceleration = 0.02;
      } else if ((up && b.high > extreme) || (!up && b.low < extreme)) {
        extreme = up ? b.high : b.low;
        acceleration = Math.min(0.2, acceleration + 0.02);
      }
    }
    output.push(up && adx != null && adx > 25 && sar > 0 ? sar : null);
  }
  return output;
}
