import type { RefObject } from "react";
import {
  LineSeries,
  type LogicalRange,
  type LineSeriesPartialOptions,
} from "lightweight-charts";
import { chartColor } from "~/lib/chart/chart-theme";
import {
  chartTime,
  initialHistoryStart,
  breakoutChartData,
  czscChartLines,
  czscChartMarkers,
} from "~/lib/chart/chart-data";
import { restoreChartRange } from "~/lib/chart/chart-viewport";
import type { Bar } from "~/lib/domain";
import type { ChartPeriod } from "~/lib/chart/chart-view";
import type { BreakoutResult } from "trading-strategies/research/breakout/breakout";
import type { CzscResult } from "trading-strategies/research/chan/czsc";
import type {
  MarketChartState,
  ChartViewport,
  ChartCompare,
} from "./market-chart-state";
import { compareColors } from "./market-chart-palette";

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
    compare,
    setHistoryStart,
  }: {
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
    compare?: readonly ChartCompare[];
    setHistoryStart: (start: number) => void;
  },
) {
  const { chart, candles } = n;
  if (n.bars !== bars || n.asOf !== breakoutIndex) {
    const saved = viewport.current;
    const restored = viewportKey ? restoreChartRange(viewportKey, bars) : null;
    const same =
      saved?.bars === bars &&
      saved.period === period &&
      saved.asOf === breakoutIndex;
    n.start = same
      ? saved.start
      : (restored?.start ?? initialHistoryStart(bars.length));
    n.bars = bars;
    n.asOf = breakoutIndex;
    n.cursor = null;
    n.byTime = new Map(
      bars.map((bar, index) => [chartTime(bar.date, period), index]),
    );
    n.pendingRange = same
      ? saved.range
      : ((restored?.range as LogicalRange | undefined) ?? null);
    setHistoryStart(n.start);
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
        ? breakoutChartData(breakout, bars, start, breakoutIndex, period)
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
    n.markers.setMarkers(
      [
        ...(czsc && showCzsc ? czscChartMarkers(czsc, period, start) : []),
        ...(overlay?.markers ?? []),
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
