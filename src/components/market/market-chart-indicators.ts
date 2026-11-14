import {
  LineSeries,
  HistogramSeries,
  type LineSeriesPartialOptions,
} from "lightweight-charts";
import { chartColor } from "~/lib/chart/chart-theme";
import {
  chartTime,
  chartIndicators,
  indicatorSegments,
  rpsChartSegments,
  type IndicatorName,
  type RpsCurve,
} from "~/lib/chart/chart-data";
import type { Bar } from "~/lib/domain";
import type { ChartPeriod, ChartView, Subchart } from "~/lib/chart/chart-view";
import type { MarketChartState } from "./market-chart-state";
import { colors, rpsColors, subchartOf } from "./market-chart-palette";

/** Keep each selected pane's identity; changing one does not rebuild others. */
export function updateIndicatorPanes(
  n: MarketChartState,
  {
    visibleSubcharts,
    rpsOptions,
  }: {
    visibleSubcharts: readonly Subchart[];
    rpsOptions: ChartView["rps"];
  },
) {
  const { chart } = n;
  const gone = [...n.panes.keys()].filter(
    (key) => !visibleSubcharts.includes(key),
  );
  if (gone.length) {
    // Removing a pane also removes the indicator lines on it; drop every
    // line first so none is removed twice. The line layer re-adds them.
    for (const line of n.indicatorLines) chart.removeSeries(line);
    n.indicatorLines = [];
    for (const key of gone) {
      chart.removePane(n.panes.get(key)!.anchor.getPane().paneIndex());
      n.panes.delete(key);
    }
  }
  for (const subchart of visibleSubcharts) {
    if (n.panes.has(subchart)) continue;
    const pane = chart.panes().length;
    const anchor =
      subchart === "volume"
        ? chart.addSeries(
            HistogramSeries,
            {
              priceFormat: { type: "volume" },
              priceLineVisible: false,
              title: "成交量",
            },
            pane,
          )
        : subchart === "macd"
          ? chart.addSeries(
              HistogramSeries,
              {
                priceFormat: { type: "price", precision: 2, minMove: 0.01 },
                priceLineVisible: false,
                title: "MACD",
              },
              pane,
            )
          : chart.addSeries(
              LineSeries,
              {
                lastValueVisible: false,
                priceLineVisible: false,
                lineVisible: false,
                crosshairMarkerVisible: false,
                ...(subchart === "rps"
                  ? {
                      autoscaleInfoProvider: () => ({
                        priceRange: { minValue: 0, maxValue: 100 },
                      }),
                    }
                  : {}),
              },
              pane,
            );
    // A newly created pane inherits the first pane scale settings in LWC 5.
    // Explicitly reset every secondary pane after it exists.
    anchor.getPane().priceScale("right").applyOptions({ mode: 0 });
    if (subchart === "rps")
      anchor.priceScale().applyOptions({
        autoScale: true,
        scaleMargins: { top: 0, bottom: 0 },
      });
    n.panes.set(subchart, { anchor, threshold: null });
  }
  visibleSubcharts.forEach((subchart, index) => {
    const pane = n.panes.get(subchart)!.anchor.getPane();
    if (pane.paneIndex() !== index + 1) pane.moveTo(index + 1);
  });
  const rpsPane = n.panes.get("rps");
  if (rpsPane) {
    if (rpsPane.threshold) rpsPane.anchor.removePriceLine(rpsPane.threshold);
    rpsPane.threshold = rpsPane.anchor.createPriceLine({
      price: rpsOptions.threshold,
      color: chartColor.muted,
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: "RPS阈值",
    });
  }
  chart.panes()[0]?.setStretchFactor(3);
  visibleSubcharts.forEach((subchart, index) => {
    chart.panes()[index + 1]?.setStretchFactor(subchart === "rps" ? 1.2 : 1.4);
  });
}
/** Refresh line data separately from pane identity and candle data. */
export function updateIndicatorLines(
  n: MarketChartState,
  {
    bars,
    period,
    values,
    names,
    rps,
    rpsOptions,
  }: {
    bars: Bar[];
    period: ChartPeriod;
    values: ReturnType<typeof chartIndicators>;
    names: readonly IndicatorName[];
    rps?: RpsCurve;
    rpsOptions: ChartView["rps"];
  },
) {
  const { chart } = n;
  const renderIndicators = () => {
    const start = n.start;
    const visible = bars.slice(start);
    const time = (bar: Bar) => chartTime(bar.date, period);
    for (const [subchart, { anchor }] of n.panes) {
      if (subchart === "volume")
        anchor.setData(
          visible.map((bar) => ({
            time: time(bar),
            value: bar.volume,
            color: bar.close >= bar.open ? chartColor.up : chartColor.down,
          })),
        );
      else if (subchart === "macd")
        anchor.setData(
          visible.map((bar, i) => {
            const value = values.MACD[start + i];
            return value == null
              ? { time: time(bar) }
              : {
                  time: time(bar),
                  value,
                  color: value >= 0 ? chartColor.up : chartColor.down,
                };
          }),
        );
      else if (subchart === "rps")
        anchor.setData(
          visible.map((bar) => ({
            time: time(bar),
            value: rpsOptions.threshold,
          })),
        );
    }
    for (const line of n.indicatorLines) chart.removeSeries(line);
    n.indicatorLines = [];
    const paneOf = (subchart: Subchart) =>
      n.panes.get(subchart)?.anchor.getPane().paneIndex();
    const line = (options: LineSeriesPartialOptions, pane: number) => {
      const series = chart.addSeries(LineSeries, options, pane);
      n.indicatorLines.push(series);
      return series;
    };
    const rpsPane = paneOf("rps");
    if (rpsPane !== undefined) {
      for (const window of rpsOptions.periods) {
        for (const segment of rpsChartSegments(
          bars,
          rps ?? [],
          period,
          window,
          start,
        )) {
          line(
            {
              color: rpsColors[window],
              lineWidth: 2,
              lineStyle: segment.mode === "backfill" ? 2 : 0,
              pointMarkersVisible: segment.data.length === 1,
              pointMarkersRadius: 3,
              priceLineVisible: false,
              lastValueVisible: false,
              autoscaleInfoProvider: () => ({
                priceRange: { minValue: 0, maxValue: 100 },
              }),
            },
            rpsPane,
          ).setData(segment.data);
        }
      }
    }
    for (const name of names) {
      if (name === "MACD") continue;
      const host = subchartOf(name);
      const pane = host === "main" ? 0 : paneOf(host);
      if (pane === undefined) continue;
      for (const segment of indicatorSegments(
        bars,
        values[name],
        period,
        start,
      )) {
        line(
          {
            color: colors[name],
            lineWidth: 1,
            priceLineVisible: false,
            lastValueVisible: false,
            pointMarkersVisible: segment.length === 1,
            pointMarkersRadius: 2,
          },
          pane,
        ).setData(segment);
      }
    }
  };
  n.renderIndicators = renderIndicators;
  renderIndicators();
}
