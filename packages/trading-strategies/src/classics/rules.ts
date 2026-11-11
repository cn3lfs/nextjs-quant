import {
  emaSeries,
  maSeries,
  rsi,
  smaSeries,
  atr,
} from "trading-strategy-core/indicators";
import type { Bar } from "trading-strategy-core/bars";
import { classicDefinitions, type ClassicId } from "./definitions.js";
export type ClassicIndicatorPoint = {
  value: number | null;
  signal: number | null;
};
type Position = { entry: number; entryIndex: number };
type Rule = (
  index: number,
  position: Position,
) => { enter: boolean; exit: boolean };
const finite = (value: number): number | null =>
  Number.isFinite(value) ? value : null;
function validBars(bars: readonly Bar[]) {
  let previous = "";
  for (const b of bars) {
    if (
      b.date <= previous ||
      ![b.open, b.close, b.high, b.low].every(
        (x) => Number.isFinite(x) && x > 0,
      ) ||
      b.low > Math.min(b.open, b.close) ||
      b.high < Math.max(b.open, b.close) ||
      ![b.volume, b.amount].every((x) => Number.isFinite(x) && x >= 0)
    )
      throw new Error("经典策略行情日期或OHLCV非法");
    previous = b.date;
  }
}
const point = (
  value: number | null,
  signal: number | null = 0,
): ClassicIndicatorPoint => ({
  value: value === null ? null : finite(value),
  signal: signal === null ? null : finite(signal),
});
function relativeStrength(values: readonly number[], period: number) {
  const changes = values.map((v, i) => (i ? v - values[i - 1]! : null));
  const gains = smaSeries(
    changes.map((v) => (v === null ? null : Math.max(v, 0))),
    period,
    1,
  );
  const absolute = smaSeries(
    changes.map((v) => (v === null ? null : Math.abs(v))),
    period,
    1,
  );
  return gains.map((v, i) =>
    v === null || absolute[i] === null || absolute[i] === 0
      ? null
      : (100 * v) / absolute[i]!,
  );
}
/** Formula reference is licensed source, local smoothing/undefined-value policy is explicit in provenance. */
export function classicIndicatorSeries(
  id: ClassicId,
  bars: readonly Bar[],
): ClassicIndicatorPoint[] {
  validBars(bars);
  const closes = bars.map((b) => b.close);
  switch (id) {
    case "classic-ibs":
      return bars.map((b) =>
        point(
          b.high === b.low ? 0.5 : (b.close - b.low) / (b.high - b.low),
          0.5,
        ),
      );
    case "classic-kama": {
      let previous: number | null = null;
      return closes.map((close, i) => {
        if (i < 10) return point(null, close);
        let volatility = 0;
        for (let n = i - 9; n <= i; n++)
          volatility += Math.abs(closes[n]! - closes[n - 1]!);
        const efficiency =
          volatility === 0 ? 0 : Math.abs(close - closes[i - 10]!) / volatility;
        const smoothing = (efficiency * (2 / 3 - 2 / 31) + 2 / 31) ** 2;
        previous ??= closes[i - 1]!;
        previous += smoothing * (close - previous);
        return point(previous, close);
      });
    }
    case "classic-aroon":
      return bars.map((_, i) => {
        if (i < 25) return point(null);
        let high = i - 25,
          low = i - 25;
        for (let j = i - 24; j <= i; j++) {
          if (bars[j]!.high >= bars[high]!.high) high = j;
          if (bars[j]!.low <= bars[low]!.low) low = j;
        }
        return point((100 * (high - low)) / 25);
      });
    case "classic-trix": {
      const triple = emaSeries(emaSeries(emaSeries(closes, 15), 15), 15);
      return triple.map((v, i) =>
        point(
          i && v !== null && triple[i - 1] !== null && triple[i - 1] !== 0
            ? 100 * (v / triple[i - 1]! - 1)
            : null,
        ),
      );
    }
    case "classic-force-index":
      return emaSeries(
        bars.map((b, i) =>
          i ? (b.close - bars[i - 1]!.close) * b.volume : null,
        ),
        13,
      ).map((v) => point(v));
    case "classic-nvi": {
      let nvi = 1000;
      const values = bars.map((b, i) => {
        if (i && b.volume < bars[i - 1]!.volume)
          nvi *= b.close / bars[i - 1]!.close;
        return nvi;
      });
      const signal = emaSeries(values, 255);
      return values.map((v, i) => point(v, signal[i]!));
    }
    case "classic-coppock": {
      const rocs = closes.map((v, i) =>
        i < 14
          ? null
          : 100 * (v / closes[i - 11]! - 1) + 100 * (v / closes[i - 14]! - 1),
      );
      return rocs.map((_, i) => {
        if (i < 23) return point(null);
        return point(
          rocs
            .slice(i - 9, i + 1)
            .reduce<number>((sum, v, j) => sum + v! * (j + 1), 0) / 55,
        );
      });
    }
    case "classic-vortex": {
      const trueRange = atr(bars, 14);
      return bars.map((_, i) => {
        if (i < 14 || trueRange[i] === null || trueRange[i] === 0)
          return point(null);
        let plus = 0,
          minus = 0;
        for (let j = i - 13; j <= i; j++) {
          plus += Math.abs(bars[j]!.high - bars[j - 1]!.low);
          minus += Math.abs(bars[j]!.low - bars[j - 1]!.high);
        }
        return point((plus - minus) / (trueRange[i]! * 14));
      });
    }
    case "classic-connors-rsi": {
      let streak = 0;
      const streaks = closes.map((v, i) => {
        if (i === 0) return 0;
        const change = v - closes[i - 1]!;
        streak =
          change > 0
            ? Math.max(0, streak) + 1
            : change < 0
              ? Math.min(0, streak) - 1
              : streak;
        return streak;
      });
      const price = rsi(bars, [3, 3, 3]).map((p) => p.rsi6),
        strength = relativeStrength(streaks, 2);
      const returns = closes.map((v, i) => (i ? v / closes[i - 1]! - 1 : null));
      return closes.map((_, i) => {
        if (i < 101 || price[i] === null || strength[i] === null)
          return point(null, 50);
        const current = returns[i]!,
          history = returns.slice(i - 100, i) as number[];
        const rank = history.filter((v) => v < current).length;
        return point((price[i]! + strength[i]! + rank) / 3, 50);
      });
    }
    case "classic-stoch-rsi": {
      const strength = rsi(bars, [14, 14, 14]).map((p, i) =>
        i < 14 ? null : p.rsi6,
      );
      const raw = strength.map((value, i) => {
        if (value === null || i < 27) return null;
        const window = strength.slice(i - 13, i + 1);
        if (window.some((v) => v === null)) return null;
        const low = Math.min(...(window as number[])),
          high = Math.max(...(window as number[]));
        return high === low ? 100 : (100 * (value - low)) / (high - low);
      });
      const k = maSeries(raw, 3),
        d = maSeries(k, 3);
      return k.map((v, i) => point(v, d[i]!));
    }
  }
}
export function createClassicRule(
  id: string,
  bars: readonly Bar[],
): Rule | null {
  const definition = classicDefinitions.find((d) => d.id === id);
  if (!definition) return null;
  const values = classicIndicatorSeries(definition.id, bars);
  return (index) => {
    const p = values[index];
    if (
      !Number.isInteger(index) ||
      index < definition.warmupBars ||
      !p ||
      p.value === null ||
      p.signal === null
    )
      return { enter: false, exit: false };
    const reversion = id === "classic-ibs" || id === "classic-connors-rsi";
    const inverted = reversion || id === "classic-kama";
    return {
      enter: inverted ? p.value < p.signal : p.value > p.signal,
      exit: inverted ? p.value > p.signal : p.value < p.signal,
    };
  };
}
