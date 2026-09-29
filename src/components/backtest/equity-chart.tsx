"use client";
import { useEffect, useRef } from "react";
import { AreaSeries, LineSeries, type Time } from "lightweight-charts";
import { chartColor, createNocturneChart } from "~/lib/chart/chart-theme";
import {
  chineseChartLocalization,
  chineseTickMark,
} from "~/lib/chart/chart-localization";
import {
  drawdownCurve,
  returnCurve,
  type EquityPoint,
} from "~/lib/backtest/equity-drawdown";

/**
 * Strategy equity against the buy-and-hold benchmark, with the strategy's
 * underwater (drawdown from peak) curve in a pane below — the TradingView
 * Strategy Tester overview layout.
 */
export function EquityChart({
  equity,
  benchmark,
}: {
  equity: EquityPoint[];
  benchmark?: EquityPoint[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = createNocturneChart(ref.current, {
      localization: chineseChartLocalization,
      autoSize: true,
      height: 400,
      rightPriceScale: { borderColor: chartColor.border },
      timeScale: {
        tickMarkFormatter: chineseTickMark,
        borderColor: chartColor.border,
        // Fit decades of daily points into the panel width.
        minBarSpacing: 0.01,
      },
    });
    const percent = {
      type: "custom" as const,
      formatter: (v: number) => `${v.toFixed(1)}%`,
    };
    const points = (rows: EquityPoint[]) =>
      rows.map((r) => ({ time: r.date as Time, value: r.value }));
    if (benchmark?.length)
      chart
        .addSeries(LineSeries, {
          color: chartColor.series3,
          lineWidth: 1,
          title: "买入持有",
          priceFormat: percent,
          priceLineVisible: false,
        })
        .setData(points(returnCurve(benchmark)));
    chart
      .addSeries(LineSeries, {
        color: chartColor.accent,
        lineWidth: 2,
        title: "策略",
        priceFormat: percent,
      })
      .setData(points(returnCurve(equity)));
    chart
      .addSeries(
        AreaSeries,
        {
          lineColor: chartColor.down,
          topColor: chartColor.downFaint,
          bottomColor: chartColor.downSoft,
          lineWidth: 1,
          invertFilledArea: true,
          title: "回撤",
          priceFormat: percent,
        },
        1,
      )
      .setData(points(drawdownCurve(equity)));
    chart
      .panes()[1]
      ?.getSeries()[0]
      ?.priceScale()
      .applyOptions({
        scaleMargins: { top: 0.02, bottom: 0.05 },
      });
    chart.panes()[1]?.setHeight(110);
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [equity, benchmark]);
  return <div ref={ref} className="price-chart" data-testid="equity-chart" />;
}
