"use client";
import { useEffect, useRef } from "react";
import { formatNumber } from "trading-strategy-core/format-number";
import { createNocturneChart } from "~/lib/chart/chart-theme";
import {
  positionRiskCurveSegments,
  type PositionRiskCurvePoint,
} from "~/lib/portfolio/position-risk";
import {
  chineseChartLocalization,
  chineseTickMark,
} from "~/lib/chart/chart-localization";
import { LineSeries, type Time } from "lightweight-charts";

export function PositionRiskChart({
  points,
}: {
  points: PositionRiskCurvePoint[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = createNocturneChart(ref.current, {
      autoSize: true,
      height: 360,
      localization: chineseChartLocalization,
      layout: { attributionLogo: true },
      timeScale: { tickMarkFormatter: chineseTickMark },
    });
    const labels = ["等效持仓只数", "最大单一权重"];
    const color = getComputedStyle(ref.current)
      .getPropertyValue("--primary")
      .trim();
    (["effectivePositions", "maxSingleWeight"] as const).forEach(
      (key, pane) => {
        // 空白轴保留首尾缺失日期；独立连续段防止图表跨缺口连线。
        chart
          .addSeries(LineSeries, { visible: false }, pane)
          .setData(points.map((point) => ({ time: point.date as Time })));
        for (const segment of positionRiskCurveSegments(points, key)) {
          const series = chart.addSeries(
            LineSeries,
            {
              title: labels[pane],
              color,
              lineWidth: 2,
              pointMarkersVisible: segment.length === 1,
              priceLineVisible: false,
              lastValueVisible: false,
              priceFormat: {
                type: "custom",
                formatter: (value: number) =>
                  pane === 0
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
      },
    );
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [points]);
  return (
    <div
      ref={ref}
      role="img"
      // autoSize follows the container: without a fixed height the canvas
      // grows the container, which grows the canvas again, without end.
      style={{ height: 360 }}
      aria-label="持仓集中度曲线，上图等效持仓只数，下图最大单一权重；缺失断线，具体数值见分页表格"
    />
  );
}
