import { type IntelEvent } from "~/lib/news/intel-events";
import type { RefObject } from "react";
import { LineSeries, type LineSeriesPartialOptions } from "lightweight-charts";
import { chartColor } from "~/lib/chart/chart-theme";
import {
  chartTime,
  initialHistoryStart,
  breakoutChartData,
  czscChartLines,
  czscChartMarkers,
  patternChartData,
  tradeChartMarkers,
} from "~/lib/chart/chart-data";
import { restoreChartRange } from "~/lib/chart/chart-viewport";
import {
  tradeMarkFocusRange,
  type TradeMark,
} from "~/lib/chart/chart-trade-marks";
import type { Bar } from "~/lib/domain";
import type { ChartPeriod } from "~/lib/chart/chart-view";
import type {
  BreakoutResult,
  DoubleBreakoutFilter,
} from "trading-strategies/research/breakout/breakout";
import type { CzscResult } from "trading-strategies/research/chan/czsc";
import type { PatternBreakoutResult } from "trading-strategies";
import type {
  MarketChartState,
  ChartViewport,
  ChartCompare,
  ChartTradeMarksValue,
} from "./market-chart-state";
import { compareColors } from "./market-chart-palette";
import { reviewFillMarkers } from "./charts/trade-review-overlay";

export function updateMarketBase(
  n: MarketChartState,
  {
    bars,
    period,
    breakoutIndex,
    viewport,
    viewportKey,
    cost,
    czsc,
    showCzsc,
    breakout,
    showBreakout,
    breakoutFilter,
    patternBreakout,
    showPatterns,
    showAllPatternGeometry,
    tradeMarks,
    showTradeMarks,
    review,
    focusAt,
    compare,
    setHistoryStart,
    newsEvents: _newsEvents,
  }: {
    newsEvents?: readonly IntelEvent[];
    bars: Bar[];
    period: ChartPeriod;
    breakoutIndex: number;
    viewport: RefObject<ChartViewport | null>;
    viewportKey?: string;
    cost?: number | null;
    czsc?: CzscResult;
    showCzsc: boolean;
    breakout?: BreakoutResult;
    showBreakout: boolean;
    /** Chart-only filter; the analysis query already used the same options. */
    breakoutFilter?: DoubleBreakoutFilter;
    patternBreakout?: PatternBreakoutResult;
    showPatterns?: boolean;
    showAllPatternGeometry?: boolean;
    /** Daily-only fills already projected onto existing bar dates. */
    tradeMarks?: readonly TradeMark[];
    showTradeMarks?: boolean;
    review?: ChartTradeMarksValue["review"];
    focusAt?: ChartTradeMarksValue["focusAt"];
    compare?: readonly ChartCompare[];
    setHistoryStart: (start: number) => void;
  },
) {
  const { chart, candles } = n;
  if (n.bars !== bars || n.asOf !== breakoutIndex) {
    const ephemeral = n.viewportPolicy === "ephemeral";
    const saved = ephemeral ? null : viewport.current;
    const restored =
      !ephemeral && viewportKey ? restoreChartRange(viewportKey, bars) : null;
    // Replay updates keep the local zoom and follow the latest bar only when
    // the trainee was already viewing the trailing edge.
    const previousLength = ephemeral ? n.bars.length : 0;
    const replayRange =
      ephemeral && previousLength > 0
        ? chart.timeScale().getVisibleLogicalRange()
        : null;
    const appended =
      replayRange && replayRange.to >= previousLength - n.start - 2
        ? bars.length - previousLength
        : 0;
    const same =
      saved?.bars === bars &&
      saved.period === period &&
      saved.asOf === breakoutIndex;
    if (!replayRange)
      n.start = same
        ? saved.start
        : (restored?.start ?? initialHistoryStart(bars.length));
    n.bars = bars;
    n.asOf = breakoutIndex;
    n.cursor = null;
    n.byTime = new Map(
      bars.map((bar, index) => [chartTime(bar.date, period), index]),
    );
    n.pendingRange = replayRange
      ? { from: replayRange.from + appended, to: replayRange.to + appended }
      : same
        ? saved.range
        : (restored?.range ?? null);
    setHistoryStart(n.start);
  }
  // `at=` centres the window once. It must never be written into the
  // persistent viewport store (rememberChartRange owns that state).
  if (period === "day" && focusAt && bars.length) {
    const first = n.byTime.get(chartTime(focusAt.date, period));
    const last = focusAt.through
      ? n.byTime.get(chartTime(focusAt.through, period))
      : undefined;
    const midpoint =
      first !== undefined && last !== undefined
        ? Math.floor((first + last) / 2)
        : undefined;
    const halfWindow =
      midpoint === undefined ? 60 : Math.max(60, last! - midpoint + 6);
    const focus = tradeMarkFocusRange(
      bars,
      midpoint === undefined ? focusAt.date : bars[midpoint]!.date,
      halfWindow,
      Math.max(120, halfWindow),
    );
    if (focus && focusAt.consume()) {
      n.temporaryRange = true;
      n.start = Math.min(n.start, focus.start);
      const offset = focus.start - n.start;
      n.pendingRange = {
        from: focus.range.from + offset,
        to: focus.range.to + offset,
      };
      setHistoryStart(n.start);
    }
  }
  if (n.costLine) candles.removePriceLine(n.costLine);
  n.costLine =
    cost != null && cost > 0
      ? candles.createPriceLine({
          price: cost,
          color:
            (bars.at(-1)?.close ?? cost) >= cost
              ? chartColor.up
              : chartColor.down,
          lineWidth: 2,
          lineStyle: 2,
          axisLabelVisible: true,
          title: "持仓成本",
        })
      : null;
  const renderBase = () => {
    const start = n.start;
    n.structure = { czsc: czsc && showCzsc ? czsc : null, bars, start };
    candles.setData(
      bars
        .slice(start)
        .map((bar) => ({ ...bar, time: chartTime(bar.date, period) })),
    );
    for (const line of n.baseLines) chart.removeSeries(line);
    n.baseLines = [];
    for (const line of n.compareLines) chart.removeSeries(line);
    n.compareLines = [];
    // Compared closes are aligned to the main chart's own dates: a date the
    // other symbol did not trade is whitespace, never an extra time point.
    compare?.forEach((item, i) => {
      const close = new Map(item.bars.map((bar) => [bar.date, bar.close]));
      const line = chart.addSeries(LineSeries, {
        color: compareColors[i % compareColors.length],
        lineWidth: 2,
        priceLineVisible: false,
        title: item.label,
        crosshairMarkerVisible: false,
      });
      line.setData(
        bars.slice(start).map((bar) => {
          const time = chartTime(bar.date, period),
            value = close.get(bar.date);
          return value === undefined ? { time } : { time, value };
        }),
      );
      n.compareLines.push(line);
    });
    const line = (options: LineSeriesPartialOptions) => {
      const series = chart.addSeries(LineSeries, options);
      n.baseLines.push(series);
      return series;
    };
    if (czsc && showCzsc) {
      for (const family of czsc.families) {
        // A level can be shown for centers/signals only: never add an empty line.
        if (!family.points.length) continue;
        line({
          color: family.config === 0 ? chartColor.series1 : chartColor.accent,
          lineWidth: family.config === 0 ? 1 : 2,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        }).setData(czscChartLines(bars, family.points, period, start));
      }
    }
    const overlay =
      breakout && showBreakout
        ? breakoutChartData(
            breakout,
            bars,
            start,
            breakoutIndex,
            period,
            breakoutFilter,
          )
        : null;
    for (const item of overlay?.lines ?? []) {
      line({
        color: item.color,
        lineWidth: 2,
        lineStyle: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      }).setData(item.data);
    }
    const patternOverlay =
      patternBreakout && showPatterns
        ? patternChartData(
            patternBreakout,
            bars,
            start,
            breakoutIndex,
            period,
            {
              showAllGeometry: showAllPatternGeometry,
            },
          )
        : null;
    for (const item of patternOverlay?.lines ?? []) {
      line({
        color: item.color,
        lineWidth: 2,
        lineStyle: item.lineStyle,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      }).setData(item.data);
    }
    n.markers.setMarkers(
      [
        ...(czsc && showCzsc
          ? czscChartMarkers(czsc, period, start, bars)
          : []),
        ...(overlay?.markers ?? []),
        ...(patternOverlay?.markers ?? []),
        ...(showTradeMarks && period === "day"
          ? review
            ? reviewFillMarkers(review, n.byTime, start)
            : tradeChartMarkers(tradeMarks ?? [], bars[start], period)
          : []),
      ].sort((a, b) => String(a.time).localeCompare(String(b.time))),
    );
  };
  n.renderBase = renderBase;
  renderBase();
  if (n.pendingRange !== undefined) {
    if (bars.length)
      chart
        .timeScale()
        .setVisibleLogicalRange(
          n.pendingRange ?? { from: 0, to: bars.length - n.start - 1 },
        );
    n.pendingRange = undefined;
  }
}
