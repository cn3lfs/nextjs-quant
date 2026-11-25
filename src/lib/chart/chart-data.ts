import { formatNumber as displayNumber } from "trading-strategy-core/format-number";
import {
  defaultParameters,
  isMinutePeriod,
  type MainIndicator,
  type IndicatorParameters,
  type ChartPeriod as Period,
  type Subchart,
} from "./chart-view";
import type { Bar } from "../domain";
import { boll, kdj, ma, macd, rsi, type IndicatorValue } from "../indicators";
import { bias, cci, ema, obv, williams } from "./chart-extra-indicators";
import type { LineData, Time, UTCTimestamp } from "lightweight-charts";
import type { SeriesMarker } from "lightweight-charts";
import type { TradeMark } from "./chart-trade-marks";
import type { PatternBreakoutMatch } from "trading-strategies";
import {
  CZSC_CTX,
  type CzscFamily,
  type CzscPoint,
  type CzscResult,
} from "trading-strategies/research/chan/czsc";
import {
  evaluateBreakoutFilter,
  type Level,
  type BreakoutResult,
  type DoubleBreakoutFilter,
} from "trading-strategies/research/breakout/breakout";

const breakoutColors = { long: "#7c3aed", short: "#28977f" };
const levelLabels: Record<Level["source"], string> = {
  "swing-high": "波段高点",
  "swing-low": "波段低点",
  "platform-high": "平台高点",
  "platform-low": "平台低点",
  "volume-bull-close": "放量阳线收盘",
  "volume-bear-close": "放量阴线收盘",
  ma20: "MA20",
  ma60: "MA60",
  round: "整数关口",
};

export function tradeChartMarkers(
  marks: readonly TradeMark[],
  firstBar: Bar | undefined,
  period: Period,
): SeriesMarker<Time>[] {
  if (!firstBar || period !== "day") return [];
  // An unloaded marker date would be clamped to the first rendered candle.
  return marks
    .filter(({ date }) => date >= firstBar.date)
    .map(({ date, position, color, shape, text }) => ({
      time: chartTime(date, period),
      position,
      color,
      shape,
      text,
    }));
}

/** Render as-of evidence only; no chart-side fitting or indicator formulas. */
export function breakoutChartData(
  result: BreakoutResult,
  bars: readonly Bar[],
  start: number,
  asOf = bars.length - 1,
  period: Period = "day",
  filter?: DoubleBreakoutFilter,
) {
  const direction = filter?.direction ?? "both";
  const point = result.points.find((p) => p.index === asOf);
  const lines: { title: string; color: string; data: LineData<Time>[] }[] = [];
  if (point) {
    const sides = [point.long, point.short].filter(
      (side) => direction === "both" || side.direction === direction,
    );
    if (
      sides.some(
        (s) => !s.line && s.trendSource === "ma20" && s.checks.trend !== "未知",
      )
    ) {
      const begin = Math.max(start, asOf - 20);
      const warmup = Math.max(0, begin - 19);
      const history = bars.slice(warmup, asOf + 1);
      for (const data of indicatorSegments(
        history,
        ma(history, 20),
        period,
        begin - warmup,
      )) {
        if (data.length >= 2)
          lines.push({ title: "MA20趋势基准", color: "#64748b", data });
      }
    }
    for (const side of sides) {
      const line = side.line;
      if (!line) continue;
      const begin = Math.max(start, line.anchors[0].index);
      if (begin >= asOf) continue;
      lines.push({
        title: `${side.direction === "long" ? "下降" : "上升"}趋势线 · ${line.touches}触`,
        color: breakoutColors[side.direction],
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
    const selected = sides
      .map((side) => side.keyLevel)
      .filter((level) => level !== null);
    const barIndexByDate = new Map<string, number>();
    if (selected.length) {
      bars.forEach((bar, index) => {
        if (!barIndexByDate.has(bar.date)) barIndexByDate.set(bar.date, index);
      });
    }
    const seen = new Set<number>();
    for (const l of selected) {
      if (seen.has(l.price)) continue;
      seen.add(l.price);
      const begin = Math.max(start, barIndexByDate.get(l.confirmedAt) ?? -1);
      if (begin >= asOf) continue;
      lines.push({
        title: `${levelLabels[l.source]} ${displayNumber(l.price, 2)}`,
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
        .filter((s) => {
          if (!filter) return s.status === "是";
          if (direction !== "both" && s.direction !== direction) return false;
          const bar = bars[p.index];
          return (
            bar &&
            evaluateBreakoutFilter(p, bar, {
              ...filter,
              direction: s.direction,
            }).matched
          );
        })
        .map((s) => ({
          time: chartTime(p.date, period),
          position:
            s.direction === "long"
              ? ("belowBar" as const)
              : ("aboveBar" as const),
          color: breakoutColors[s.direction],
          shape:
            s.direction === "long"
              ? ("arrowUp" as const)
              : ("arrowDown" as const),
          text: `双突破${s.direction === "long" ? "↑" : "↓"} ${s.quality}`,
        })),
    );
  return { lines, markers, point };
}

export function patternChartData(
  matches: readonly PatternBreakoutMatch[],
  bars: readonly Bar[],
  start: number,
  asOf = bars.length - 1,
  period: Period = "day",
  options?: { showAllGeometry?: boolean },
) {
  const lines: {
    title: string;
    color: string;
    lineStyle: 0 | 2;
    data: LineData<Time>[];
  }[] = [];
  const markers: SeriesMarker<Time>[] = [];
  const visibleMatches = matches.filter(
    (m) => m.index >= start && m.index <= asOf,
  );
  const latest = visibleMatches.at(-1);
  for (const match of visibleMatches) {
    const long = match.direction === "long";
    const color = long ? "#d97706" : "#0891b2";
    const arrow = long ? "↑" : "↓";
    const label = match.label.replace(/(?:\s*[↑↓])+\s*$/, "");
    markers.push({
      time: chartTime(match.date, period),
      position: long ? "belowBar" : "aboveBar",
      color,
      shape: long ? "arrowUp" : "arrowDown",
      text: `${label}${arrow} ${match.score}/5`,
    });
    if (!options?.showAllGeometry && match !== latest) continue;
    for (const line of match.geometry.lines) {
      const points = line.points.filter(
        (p) => p.index <= asOf && bars[p.index],
      );
      const data = clipChartLine(bars, points, period, start);
      if (!data.length) continue;
      const isBreakoutLine =
        line.kind === "neckline" || line.kind === (long ? "upper" : "lower");
      lines.push({
        title: line.label,
        color: isBreakoutLine ? color : "#64748b",
        lineStyle: line.style === "dashed" ? 2 : 0,
        data,
      });
    }
  }
  return { lines, markers };
}

export function czscChartLines(
  bars: readonly Bar[],
  points: CzscPoint[],
  period: Period,
  start: number,
): LineData<Time>[] {
  return clipChartLine(bars, points, period, start);
}

function clipChartLine(
  bars: readonly Bar[],
  points: readonly Pick<CzscPoint, "index" | "date" | "price">[],
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

function isStandardCzscSignal(signal: CzscFamily["signals"][number]) {
  const flags = signal.structure?.contextFlags ?? 0;
  switch (Math.abs(signal.kind)) {
    case 1:
      return signal.divergence?.semantic !== 2;
    case 2:
      return !(flags & CZSC_CTX.overlap);
    case 3:
      return (
        !(flags & (CZSC_CTX.overlap | CZSC_CTX.smallTurn)) &&
        signal.divergence?.semantic !== 3
      );
    default:
      return false;
  }
}
export function czscChartMarkers(
  result: CzscResult,
  period: Period,
  start: number,
  _bars?: readonly Bar[],
): SeriesMarker<Time>[] {
  const marker = (
    date: string,
    long: boolean,
    text: string,
  ): SeriesMarker<Time> => ({
    time: chartTime(date, period),
    position: long ? "belowBar" : "aboveBar",
    color: long ? "#cf5562" : "#28977f",
    shape: long ? "arrowUp" : "arrowDown",
    text,
  });
  const markers = result.families.flatMap((family) =>
    family.signals
      .filter(
        (signal) =>
          signal.index >= start &&
          (signal.revokedAt ?? -1) < 0 &&
          isStandardCzscSignal(signal),
      )
      .map((signal) =>
        marker(
          signal.date,
          signal.kind > 0,
          `${family.config === 0 ? "笔" : "段"}${Math.abs(signal.kind)}${signal.kind > 0 ? "买" : "卖"}`,
        ),
      ),
  );
  return markers.sort((a, b) => String(a.time).localeCompare(String(b.time)));
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
    EMA1: ema(bars, parameters.ema[0]),
    EMA2: ema(bars, parameters.ema[1]),
    EMA3: ema(bars, parameters.ema[2]),
    WR1: williams(bars, parameters.wr[0]),
    WR2: williams(bars, parameters.wr[1]),
    BIAS1: bias(bars, parameters.bias[0]),
    BIAS2: bias(bars, parameters.bias[1]),
    BIAS3: bias(bars, parameters.bias[2]),
    CCI: cci(bars, parameters.cci[0]),
    OBV: obv(bars),
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
  if (mainIndicators.includes("ema")) names.push("EMA1", "EMA2", "EMA3");
  if (mainIndicators.includes("boll")) names.push("BOLL中", "BOLL上", "BOLL下");
  if (subcharts.includes("macd")) names.push("DIF", "DEA", "MACD");
  if (subcharts.includes("kdj")) names.push("K", "D", "J");
  if (subcharts.includes("rsi")) names.push("RSI6", "RSI12", "RSI24");
  if (subcharts.includes("wr")) names.push("WR1", "WR2");
  if (subcharts.includes("bias")) names.push("BIAS1", "BIAS2", "BIAS3");
  if (subcharts.includes("cci")) names.push("CCI");
  if (subcharts.includes("obv")) names.push("OBV");
  return names;
}
/** Beijing wall-clock label for a bar date, matching the chart axis. Dates
 *  without a time part (daily and longer) are returned unchanged. */
export function wallClockLabel(date: string) {
  if (!date.includes("T")) return date;
  return new Date(Date.parse(date) + 8 * 3600000)
    .toISOString()
    .slice(0, 16)
    .replace("T", " ");
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
