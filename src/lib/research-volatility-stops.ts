import type { Bar } from "./domain";
import { atr, boll, emaSeries, maSeries, rollingHigh } from "./indicators";
import type { ResearchManagement } from "./research-management";

export const volatilityStopProfiles = {
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
  "波动线工程v1：固定双突破入场，初始5%止损、1%含费风险预算、20%单股上限。收盘以当日完整数据更新线，取旧止损与新线较高者，次日起生效；收盘不高于有效线确认退出，下一可成交开盘执行。缺失/非法窗口保留旧线并记录，不扩宽止损。布林共享样本标准差；Keltner工程冻结EMA20/算术ATR20/2倍；Kaufman工程冻结20日最高价减2倍20日平均H-L，不包含缺口。均线保护同样只升不降，不冒充每日可下降的原始指标线。EMA从首个有效收盘递推，但须20根连续有效行情才启用。最长持有60交易日；与同入场固定5%止损对照，非盈利证据。";
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
): (number | null)[] {
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
          : id === "rk-keltner-lower"
            ? exponential[i] == null || trueRanges[i] == null
              ? null
              : exponential[i]! - 2 * trueRanges[i]!
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
