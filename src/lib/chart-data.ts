import {
  defaultParameters,
  isMinutePeriod,
  type MainIndicator,
  type IndicatorParameters,
  type ChartPeriod as Period,
  type Subchart,
} from "./chart-view";
import type { Bar } from "./domain";
import { boll, kdj, ma, macd, rsi, type IndicatorValue } from "./indicators";
import type { LineData, Time, UTCTimestamp } from "lightweight-charts";
import type { SeriesMarker } from "lightweight-charts";
import type { CzscPoint, CzscResult } from "./czsc";
import type { BreakoutResult } from "../server/breakout";

/** Render as-of evidence only; no chart-side fitting or indicator formulas. */
export function breakoutChartData(
  result: BreakoutResult,
  bars: readonly Bar[],
  start: number,
  asOf = bars.length - 1,
  period: Period = "day",
) {
  const point = result.points.find((p) => p.index === asOf);
  const lines: { title: string; color: string; data: LineData<Time>[] }[] = [];
  if (point) {
    for (const side of [point.long, point.short]) {
      const line = side.line;
      if (!line) continue;
      const begin = Math.max(start, line.anchors[0].index);
      if (begin >= asOf) continue;
      lines.push({
        title: `${side.direction === "long" ? "下降" : "上升"}趋势线 · ${line.touches}触`,
        color: "#7c3aed",
        data: [
          {
            time: chartTime(bars[begin]!.date, period),
            value:
              line.anchors[0].price +
              line.slope * (begin - line.anchors[0].index),
          },
          { time: chartTime(point.date, period), value: line.value },
        ],
      });
    }
    // Keep the latest confirmed swing on each side. Round numbers, moving
    // averages and secondary targets remain in the strategy report, not on K bars.
    const selected = (["swing-high", "swing-low"] as const).map((source) =>
      point.levels.filter((level) => level.source === source).at(-1),
    );
    const seen = new Set<number>();
    for (const l of selected) {
      if (!l || seen.has(l.price)) continue;
      seen.add(l.price);
      const begin = Math.max(
        start,
        bars.findIndex((b) => b.date === l.confirmedAt),
      );
      if (begin >= asOf) continue;
      lines.push({
        title: `${l.source === "swing-high" ? "波段高点" : "波段低点"} ${l.price.toFixed(2)}`,
        color: l.price >= point.close ? "#be5263" : "#218775",
        data: [
          { time: chartTime(bars[begin]!.date, period), value: l.price },
          { time: chartTime(point.date, period), value: l.price },
        ],
      });
    }
  }
  const markers: SeriesMarker<Time>[] = result.points
    .filter((p) => p.index >= start && p.index <= asOf)
    .flatMap((p) =>
      [p.long, p.short]
        .filter((s) => s.status === "是")
        .map((s) => ({
          time: chartTime(p.date, period),
          position:
            s.direction === "long"
              ? ("belowBar" as const)
              : ("aboveBar" as const),
          color: "#7c3aed",
          shape:
            s.direction === "long"
              ? ("arrowUp" as const)
              : ("arrowDown" as const),
          text: `双突破${s.direction === "long" ? "↑" : "↓"} ${s.quality}`,
        })),
    );
  return { lines, markers, point };
}

export function czscChartLines(
  bars: readonly Bar[],
  points: CzscPoint[],
  period: Period,
  start: number,
): LineData<Time>[] {
  const data = points
    .filter((p) => p.index >= start)
    .map((p) => ({ time: chartTime(p.date, period), value: p.price }));
  const before = points.filter((p) => p.index < start).at(-1),
    after = points.find((p) => p.index >= start);
  // Clip the entering edge at the visible snapshot suffix, preserving its slope
  // without adding hidden historical dates to the M2 time scale.
  if (before && after && after.index > start && bars[start])
    data.unshift({
      time: chartTime(bars[start].date, period),
      value:
        before.price +
        ((after.price - before.price) * (start - before.index)) /
          (after.index - before.index),
    });
  return data;
}
export function czscChartMarkers(
  result: CzscResult,
  period: Period,
  start: number,
): SeriesMarker<Time>[] {
  return result.families
    .flatMap((f) =>
      f.signals
        .filter((s) => s.index >= start)
        .map((s) => ({
          time: chartTime(s.date, period),
          position: s.kind > 0 ? ("belowBar" as const) : ("aboveBar" as const),
          color: s.kind > 0 ? "#cf5562" : "#28977f",
          shape: s.kind > 0 ? ("arrowUp" as const) : ("arrowDown" as const),
          text: `${f.config === 0 ? "笔" : "段"}${Math.abs(s.kind)}${s.kind > 0 ? "买" : "卖"}`,
        })),
    )
    .sort((a, b) => String(a.time).localeCompare(String(b.time)));
}

export const chartPageSize = 180;
export type { Subchart } from "./chart-view";

// Compute against the entire immutable snapshot, never the displayed suffix:
// revealing history must not move the recursive indicators' starting point.
export function chartIndicators(
  bars: readonly Bar[],
  parameters: IndicatorParameters = defaultParameters,
) {
  const m = macd(bars, ...parameters.macd),
    k = kdj(bars, ...parameters.kdj),
    r = rsi(bars, parameters.rsi),
    b = boll(bars, ...parameters.boll);
  return {
    MA5: ma(bars, parameters.ma[0]),
    MA10: ma(bars, parameters.ma[1]),
    MA20: ma(bars, parameters.ma[2]),
    MA60: ma(bars, parameters.ma[3]),
    BOLL中: b.map((v) => v.mid),
    BOLL上: b.map((v) => v.upper),
    BOLL下: b.map((v) => v.lower),
    DIF: m.map((v) => v.dif),
    DEA: m.map((v) => v.dea),
    MACD: m.map((v) => v.macd),
    K: k.map((v) => v.k),
    D: k.map((v) => v.d),
    J: k.map((v) => v.j),
    RSI6: r.map((v) => v.rsi6),
    RSI12: r.map((v) => v.rsi12),
    RSI24: r.map((v) => v.rsi24),
  };
}
export type ChartIndicators = ReturnType<typeof chartIndicators>;
export type IndicatorName = keyof ChartIndicators;
export function enabledIndicators(
  mainIndicators: readonly MainIndicator[],
  subcharts: readonly Subchart[],
): IndicatorName[] {
  const names: IndicatorName[] = [];
  if (mainIndicators.includes("ma")) names.push("MA5", "MA10", "MA20", "MA60");
  if (mainIndicators.includes("boll")) names.push("BOLL中", "BOLL上", "BOLL下");
  if (subcharts.includes("macd")) names.push("DIF", "DEA", "MACD");
  if (subcharts.includes("kdj")) names.push("K", "D", "J");
  if (subcharts.includes("rsi")) names.push("RSI6", "RSI12", "RSI24");
  return names;
}
export function chartTime(date: string, period: Period): Time {
  // Intraday timestamps encode exchange wall time on the UTC chart axis so the
  // displayed labels remain Asia/Shanghai, independently of browser timezone.
  return !isMinutePeriod(period)
    ? date
    : ((Math.floor(Date.parse(date) / 1000) + 8 * 3600) as UTCTimestamp);
}
export function chartLegend(
  bars: readonly Bar[],
  values: ChartIndicators,
  index: number,
  names: IndicatorName[],
) {
  const bar = bars[index];
  if (!bar) return null;
  return {
    bar,
    indicators: names.map((name) => ({
      name,
      value: values[name][index] ?? null,
    })),
  };
}
// Whitespace alone does not break lightweight-charts LineSeries. Separate
// continuous runs guarantee a real gap, including an isolated valid point.
export function indicatorSegments(
  bars: readonly Bar[],
  values: IndicatorValue[],
  period: Period,
  start = 0,
) {
  const segments: LineData<Time>[][] = [];
  let run: LineData<Time>[] = [];
  for (let i = start; i < bars.length; i++) {
    const value = values[i];
    if (value == null) {
      run = [];
      continue;
    }
    if (!run.length) segments.push(run);
    run.push({ time: chartTime(bars[i]!.date, period), value });
  }
  return segments;
}
export function initialHistoryStart(length: number) {
  return Math.max(0, length - chartPageSize);
}
export function revealHistory(
  start: number,
  range: { from: number; to: number },
) {
  const next = Math.max(0, start - chartPageSize);
  const added = start - next;
  return {
    start: next,
    range: { from: range.from + added, to: range.to + added },
  };
}

export type RpsCurve = {
  date: string;
  mode: "backfill" | "forward";
  periods: number[];
  values: ({ rps: number } | null)[];
}[];

// Align persisted observations to daily bars; absent dates and null values break
// runs. Split provenance too, so backfill never appears to be forward evidence.
export function rpsChartSegments(
  bars: readonly Bar[],
  curve: RpsCurve,
  period: Period,
  window: number,
  start = 0,
) {
  if (period !== "day") return [];
  const byDate = new Map(curve.map((row) => [row.date, row]));
  return (["backfill", "forward"] as const).flatMap((mode) =>
    indicatorSegments(
      bars,
      bars.map((bar) => {
        const row = byDate.get(bar.date);
        return row?.mode === mode
          ? (row.values[row.periods.indexOf(window)]?.rps ?? null)
          : null;
      }),
      period,
      start,
    ).map((data) => ({ mode, data })),
  );
}
