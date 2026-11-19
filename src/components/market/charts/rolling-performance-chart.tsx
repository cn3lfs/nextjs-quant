"use client";
import { useEffect, useRef } from "react";
import { formatNumber } from "trading-strategy-core/format-number";
import { chartColor, createNocturneChart } from "~/lib/chart/chart-theme";
import {
  rollingChartMetrics,
  rollingCurveSegments,
  type RollingCurvePoint,
} from "~/lib/backtest/rolling-performance";
import {
  chineseChartLocalization,
  chineseTickMark,
} from "~/lib/chart/chart-localization";
import { LineSeries, type Time } from "lightweight-charts";

export function RollingPerformanceChart({
  points,
  simple,
}: {
  points: RollingCurvePoint[];
  simple: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = createNocturneChart(ref.current, {
      autoSize: true,
      height: 540,
      localization: chineseChartLocalization,
      layout: { attributionLogo: true },
      timeScale: { tickMarkFormatter: chineseTickMark },
    });
    const labels = [
      "夏普（wbt）",
      simple ? "最大回撤（绝对值）" : "最大回撤",
      "年化收益",
    ];
    rollingChartMetrics.forEach((key, pane) => {
      // 空白轴保留首尾缺失日期；独立连续段防止图表跨缺口连线。
      chart
        .addSeries(LineSeries, { visible: false }, pane)
        .setData(points.map((point) => ({ time: point.endDate as Time })));
      for (const segment of rollingCurveSegments(points, key)) {
        const series = chart.addSeries(
          LineSeries,
          {
            title: labels[pane],
            color: [chartColor.series3, chartColor.up, chartColor.series2][
              pane
            ],
            lineWidth: 2,
            pointMarkersVisible: segment.length === 1,
            priceLineVisible: false,
            lastValueVisible: false,
            priceFormat: {
              type: "custom",
              formatter: (value: number) =>
                pane === 0 || (pane === 1 && simple)
                  ? formatNumber(value, 4)
                  : `${formatNumber(value * 100, 2)}%`,
            },
          },
          pane,
        );
        series.setData(
          segment.map((point) => ({
            time: point.date as Time,
            value: point.value,
          })),
        );
      }
    });
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [points, simple]);
  return (
    <div
      ref={ref}
      role="img"
      // autoSize follows the container: without a fixed height the canvas
      // grows the container, which grows the canvas again, without end.
      style={{ height: 540 }}
      aria-label="滚动绩效曲线，从上到下为夏普、最大回撤、年化收益；具体数值和覆盖率见分页表格"
    />
  );
}
