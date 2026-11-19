"use client";
import { useEffect, useRef } from "react";
import { chartColor, createNocturneChart } from "~/lib/chart/chart-theme";
import {
  chineseChartLocalization,
  chineseTickMark,
} from "~/lib/chart/chart-localization";
import {
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  type Time,
  ColorType,
} from "lightweight-charts";
import type { Bar } from "~/lib/domain";
import type { ChartPeriod as Period } from "~/lib/chart/chart-view";
import { MarketChart } from "./market-chart";
import { CzscMarketChart } from "./czsc-market-chart";

function LegacyChart({
  bars,
  equity,
}: {
  bars?: Bar[];
  equity?: { date: string; value: number }[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = createNocturneChart(ref.current, {
      localization: chineseChartLocalization,
      autoSize: true,
      height: 340,
      layout: {
        background: { type: ColorType.Solid, color: chartColor.ground },
        textColor: chartColor.text,
        fontFamily: "Consolas, monospace",
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: chartColor.grid },
        horzLines: { color: chartColor.grid },
      },
      rightPriceScale: { borderColor: chartColor.border },
      timeScale: {
        tickMarkFormatter: chineseTickMark,
        borderColor: chartColor.border,
        timeVisible: Boolean(bars?.[0]?.date.includes("T")),
      },
    });
    const time = (date: string) =>
      (date.includes("T") ? Math.floor(Date.parse(date) / 1000) : date) as Time;
    if (equity) {
      const series = chart.addSeries(LineSeries, {
        color: chartColor.accent,
        lineWidth: 2,
      });
      series.setData(
        equity.map((b) => ({ time: time(b.date), value: b.value })),
      );
    } else if (bars) {
      const series = chart.addSeries(CandlestickSeries, {
        upColor: chartColor.up,
        downColor: chartColor.down,
        borderVisible: false,
        wickUpColor: chartColor.up,
        wickDownColor: chartColor.down,
      });
      series.setData(bars.map((b) => ({ ...b, time: time(b.date) })));
      const volume = chart.addSeries(HistogramSeries, {
        priceFormat: { type: "volume" },
        priceScaleId: "volume",
      });
      volume
        .priceScale()
        .applyOptions({ scaleMargins: { top: 0.86, bottom: 0 } });
      series
        .priceScale()
        .applyOptions({ scaleMargins: { top: 0.08, bottom: 0.24 } });
      volume.setData(
        bars.map((b) => ({
          time: time(b.date),
          value: b.volume,
          color: b.close >= b.open ? chartColor.upSoft : chartColor.downSoft,
        })),
      );
    }
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [bars, equity]);
  return (
    <div>
      <div ref={ref} className="price-chart" />
      <a
        className="chart-credit"
        href="https://www.tradingview.com/"
        target="_blank"
        rel="noreferrer"
      >
        TradingView Lightweight Charts™ · © 2026 TradingView, Inc.
      </a>
    </div>
  );
}

export function PriceChart(props: {
  bars?: Bar[];
  equity?: { date: string; value: number }[];
  period?: Period;
  snapshotId?: string;
}) {
  // Frozen equity consumer keeps its existing rendering path.
  if (props.equity) return <LegacyChart equity={props.equity} />;
  if (props.snapshotId)
    return (
      <CzscMarketChart
        bars={props.bars ?? []}
        period={props.period ?? "day"}
        snapshotId={props.snapshotId}
      />
    );
  return <MarketChart bars={props.bars ?? []} period={props.period ?? "day"} />;
}
