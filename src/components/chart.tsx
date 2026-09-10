"use client";
import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";
import { rpsPeriods } from "~/lib/rps";
import { rpsChartSegments, type RpsCurve } from "~/lib/chart-data";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "~/components/ui/select";

import { attachDrawings } from "~/lib/chart-drawings";
import {
  defaultChartView,
  indicatorLabel,
  keyboardRange,
  periodLabels,
  type ChartPeriod as Period,
  type ChartView,
  type Drawing,
} from "~/lib/chart-view";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  createSeriesMarkers,
  type ISeriesPrimitive,
  type Time,
  ColorType,
  CrosshairMode,
  type LogicalRange,
  type ISeriesApi,
} from "lightweight-charts";
import type { Bar } from "~/lib/domain";
import type { CzscResult } from "~/lib/czsc";
import type { BreakoutResult } from "~/server/breakout";
import { breakoutChartData } from "~/lib/chart-data";
import { api } from "~/trpc/react";
import {
  chartIndicators,
  chartLegend,
  chartTime,
  enabledIndicators,
  indicatorSegments,
  initialHistoryStart,
  revealHistory,
  czscChartLines,
  czscChartMarkers,
  type IndicatorName,
  type Subchart,
} from "~/lib/chart-data";
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
    const chart = createChart(ref.current, {
      autoSize: true,
      height: 340,
      layout: {
        background: { type: ColorType.Solid, color: "#ffffff" },
        textColor: "#6a7d91",
        fontFamily: "Consolas, monospace",
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: "#f0f3f7" },
        horzLines: { color: "#f0f3f7" },
      },
      rightPriceScale: { borderColor: "#e5ebf2" },
      timeScale: {
        borderColor: "#e5ebf2",
        timeVisible: Boolean(bars?.[0]?.date.includes("T")),
      },
    });
    const time = (date: string) =>
      (date.includes("T") ? Math.floor(Date.parse(date) / 1000) : date) as Time;
    if (equity) {
      const series = chart.addSeries(LineSeries, {
        color: "#287e97",
        lineWidth: 2,
      });
      series.setData(
        equity.map((b) => ({ time: time(b.date), value: b.value })),
      );
    } else if (bars) {
      const series = chart.addSeries(CandlestickSeries, {
        upColor: "#cf5562",
        downColor: "#28977f",
        borderVisible: false,
        wickUpColor: "#cf5562",
        wickDownColor: "#28977f",
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
          color: b.close >= b.open ? "#cf556233" : "#28977f33",
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

const colors: Record<IndicatorName, string> = {
  MA5: "#b77900",
  MA10: "#9b4dcc",
  MA20: "#287e97",
  MA60: "#4666cc",
  BOLL中: "#68788c",
  BOLL上: "#d97706",
  BOLL下: "#d97706",
  DIF: "#b77900",
  DEA: "#9b4dcc",
  MACD: "#cf5562",
  K: "#b77900",
  D: "#9b4dcc",
  J: "#287e97",
  RSI6: "#b77900",
  RSI12: "#9b4dcc",
  RSI24: "#287e97",
};
const rpsColors: Record<number, string> = {
  5: "#be5263",
  10: "#218775",
  20: "#68788c",
  50: "#b77900",
  120: "#9b4dcc",
  250: "#287e97",
};
const subcharts = {
  none: "隐藏副图",
  volume: "成交量",
  macd: "MACD",
  kdj: "KDJ",
  rsi: "RSI",
  rps: "RPS（日线）",
} as const;
const formatValue = (value: number | null | undefined) =>
  value == null ? "—" : value.toFixed(2);

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

export function CzscMarketChart({
  bars,
  period,
  snapshotId,
  view,
  onViewChange,
  drawingTool,
  onAnchor,
  cost,
  rps,
  rpsMessage,
  onRpsRetry,
}: {
  bars: Bar[];
  period: Period;
  snapshotId: string;
  view?: ChartView;
  onViewChange?: (view: ChartView) => void;
  drawingTool?: Drawing["kind"] | "none";
  onAnchor?: (p: Drawing["a"]) => void;
  cost?: number | null;
  rps?: RpsCurve;
  rpsMessage?: string;
  onRpsRetry?: () => void;
}) {
  const result = api.czsc.useQuery(
    { snapshotId },
    {
      enabled: period === "day" || period === "5m",
      staleTime: Infinity,
      retry: false,
    },
  );
  const breakout = api.breakout.useQuery(
    { snapshotId },
    { enabled: period === "day", staleTime: Infinity, retry: false },
  );
  return (
    <MarketChart
      bars={bars}
      period={period}
      view={view}
      onViewChange={onViewChange}
      drawingTool={drawingTool}
      onAnchor={onAnchor}
      cost={cost}
      rps={rps}
      rpsMessage={rpsMessage}
      onRpsRetry={onRpsRetry}
      czsc={period === "day" || period === "5m" ? result.data : undefined}
      breakout={period === "day" ? breakout.data : undefined}
      breakoutMessage={
        period !== "day"
          ? "双突破仅支持日线"
          : breakout.error
            ? `双突破计算失败：${breakout.error.message}`
            : breakout.isPending
              ? "双突破计算中…"
              : undefined
      }
      czscMessage={
        period === "week" || period === "month"
          ? "缠论结构在周/月线不可用"
          : result.error
            ? `缠论计算失败：${result.error.message}`
            : result.isPending
              ? "缠论计算中…"
              : undefined
      }
    />
  );
}

export function MarketChart({
  bars,
  period,
  czsc,
  czscMessage,
  breakout,
  breakoutMessage,
  view,
  onViewChange,
  drawingTool = "none",
  onAnchor,
  cost,
  rps,
  rpsMessage,
  onRpsRetry,
}: {
  bars: Bar[];
  period: Period;
  czsc?: CzscResult;
  czscMessage?: string;
  breakout?: BreakoutResult;
  breakoutMessage?: string;
  view?: ChartView;
  onViewChange?: (view: ChartView) => void;
  drawingTool?: Drawing["kind"] | "none";
  onAnchor?: (p: Drawing["a"]) => void;
  cost?: number | null;
  rps?: RpsCurve;
  rpsMessage?: string;
  onRpsRetry?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const viewport = useRef<{
    bars: Bar[];
    period: Period;
    start: number;
    asOf: number;
    range: LogicalRange | null;
  } | null>(null);
  const [localBoll, setLocalBoll] = useState(false);
  const showBoll = view?.showBoll ?? localBoll;
  const setShowBoll = (value: boolean) =>
    onViewChange && view
      ? onViewChange({ ...view, showBoll: value })
      : setLocalBoll(value);
  const chartApi = useRef<ReturnType<typeof createChart> | null>(null);
  const [showCzsc, setShowCzsc] = useState(true);
  const [showBreakout, setShowBreakout] = useState(true);
  const [breakoutDate, setBreakoutDate] = useState("");
  const selectedBreakoutIndex = breakoutDate
    ? bars.findIndex((b) => b.date === breakoutDate)
    : -1;
  const breakoutIndex =
    selectedBreakoutIndex >= 0
      ? selectedBreakoutIndex
      : (breakout?.latest?.index ?? bars.length - 1);
  // One selectable, independently scaled pane keeps the price chart readable.
  const [localSubchart, setLocalSubchart] = useState<Subchart>("volume");
  const subchart = view?.subchart ?? localSubchart;
  const setSubchart = (value: Subchart) =>
    onViewChange && view
      ? onViewChange({ ...view, subchart: value })
      : setLocalSubchart(value);
  const [localRps, setLocalRps] = useState(defaultChartView.rps);
  const rpsOptions = view?.rps ?? localRps;
  const setRpsOptions = (rps: ChartView["rps"]) =>
    onViewChange && view ? onViewChange({ ...view, rps }) : setLocalRps(rps);
  const parameters = view?.parameters ?? defaultChartView.parameters;
  const [hover, setHover] = useState<{ bars: Bar[]; index: number } | null>(
    null,
  );
  const [historyStart, setHistoryStart] = useState(
    initialHistoryStart(bars.length),
  );
  const values = useMemo(
    () => chartIndicators(bars, parameters),
    [bars, period, parameters],
  );
  const names = useMemo(
    () => enabledIndicators(showBoll, subchart),
    [showBoll, subchart],
  );
  const legend = chartLegend(
    bars,
    values,
    hover?.bars === bars ? hover.index : bars.length - 1,
    names,
  );

  useEffect(() => {
    if (!ref.current) return;
    const saved = viewport.current;
    let start =
      saved?.bars === bars &&
      saved.period === period &&
      saved.asOf === breakoutIndex
        ? saved.start
        : selectedBreakoutIndex >= 0
          ? Math.max(0, breakoutIndex - 120)
          : initialHistoryStart(bars.length);
    const savedRange =
      saved?.bars === bars &&
      saved.period === period &&
      saved.asOf === breakoutIndex
        ? saved.range
        : null;
    setHistoryStart(start);
    const chart = createChart(ref.current, {
      autoSize: true,
      layout: {
        background: {
          type: ColorType.Solid,
          color: view?.dark ? "#111827" : "#ffffff",
        },
        textColor: view?.dark ? "#d1d5db" : "#52677c",
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: view?.dark ? "#263244" : "#f0f3f7" },
        horzLines: { color: view?.dark ? "#263244" : "#f0f3f7" },
      },
      rightPriceScale: {
        borderColor: "#64748b",
        mode: 0,
      },
      handleScale: {
        axisPressedMouseMove: { time: true, price: subchart !== "rps" },
        mouseWheel: true,
        pinch: true,
      },
      timeScale: {
        timeVisible: period === "5m",
        secondsVisible: false,
        borderColor: "#e5ebf2",
      },
      crosshair: { mode: CrosshairMode.Normal },
    });
    chartApi.current = chart;
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: "#cf5562",
      downColor: "#28977f",
      borderVisible: false,
      wickUpColor: "#cf5562",
      wickDownColor: "#28977f",
    });
    if (view) {
      // Log prices only: oscillators can be negative and must retain their linear scale.
      candles.priceScale().applyOptions({ mode: view.logarithmic ? 1 : 0 });
      attachDrawings(chart, candles, bars, period, view.drawings);
    }
    if (cost != null && cost > 0)
      candles.createPriceLine({
        price: cost,
        color: (bars.at(-1)?.close ?? cost) >= cost ? "#cf5562" : "#28977f",
        lineWidth: 2,
        lineStyle: 2,
        axisLabelVisible: true,
        title: "持仓成本",
      });
    if (onAnchor && drawingTool !== "none")
      chart.subscribeClick((event) => {
        if (!event.point || event.paneIndex !== 0 || event.time === undefined)
          return;
        const bar = bars.find((b) => chartTime(b.date, period) === event.time);
        const price = candles.coordinateToPrice(event.point.y);
        if (bar && price != null && price > 0)
          onAnchor({ date: bar.date, price: Math.round(price * 100) / 100 });
      });
    const markers =
      (czsc && showCzsc) || (breakout && showBreakout)
        ? createSeriesMarkers(candles, [])
        : null;
    // A series primitive follows the chart's own pan/zoom/price-scale paint cycle.
    // Rectangles use DLL boundaries and ZG/ZD; no chart-side structure calculation.
    if (czsc && showCzsc) {
      const primitive: ISeriesPrimitive<Time> = {
        paneViews: () => [
          {
            zOrder: () => "normal",
            renderer: () => ({
              draw: (target) =>
                target.useMediaCoordinateSpace(
                  ({ context: ctx, mediaSize }) => {
                    for (const family of czsc.families) {
                      const color = family.config === 0 ? "#b77900" : "#7c3aed";
                      for (const center of family.centers) {
                        if (center.end < start) continue;
                        const x1 = chart
                          .timeScale()
                          .timeToCoordinate(
                            chartTime(
                              bars[Math.max(start, center.start)]!.date,
                              period,
                            ),
                          );
                        const x2 = chart
                          .timeScale()
                          .timeToCoordinate(
                            chartTime(bars[center.end]!.date, period),
                          );
                        const y1 = candles.priceToCoordinate(center.ZG),
                          y2 = candles.priceToCoordinate(center.ZD);
                        if (
                          x1 === null ||
                          x2 === null ||
                          y1 === null ||
                          y2 === null
                        )
                          continue;
                        ctx.fillStyle = `${color}18`;
                        ctx.strokeStyle = color;
                        ctx.lineWidth = 1;
                        ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
                        ctx.strokeRect(x1, y1, x2 - x1, Math.max(1, y2 - y1));
                      }
                      for (const interval of family.divergences) {
                        if (interval.end < start) continue;
                        const x1 = chart
                          .timeScale()
                          .timeToCoordinate(
                            chartTime(
                              bars[Math.max(start, interval.start)]!.date,
                              period,
                            ),
                          );
                        const x2 = chart
                          .timeScale()
                          .timeToCoordinate(
                            chartTime(bars[interval.end]!.date, period),
                          );
                        if (x1 === null || x2 === null) continue;
                        ctx.fillStyle =
                          interval.direction > 0 ? "#cf556220" : "#28977f20";
                        ctx.fillRect(x1, 0, x2 - x1, mediaSize.height);
                      }
                    }
                  },
                ),
            }),
          },
        ],
      };
      candles.attachPrimitive(primitive);
    }
    // The RPS reference anchor has values only to display its threshold;
    // observations still come exclusively from persisted segmented curves.
    // Other oscillators use whitespace to retain an empty warmup pane.
    const anchor =
      subchart === "none" || (subchart === "rps" && period !== "day")
        ? null
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
            1,
          );
    const histogram =
      subchart === "volume" || subchart === "macd"
        ? chart.addSeries(
            HistogramSeries,
            {
              priceFormat:
                subchart === "volume"
                  ? { type: "volume" }
                  : { type: "price", precision: 2, minMove: 0.01 },
              priceLineVisible: false,
            },
            1,
          )
        : null;
    // A newly created pane inherits the first pane scale settings in LWC 5.
    // Explicitly reset the oscillator pane after it exists.
    anchor?.priceScale().applyOptions({ mode: 0 });
    if (subchart === "rps" && period === "day" && anchor) {
      anchor.priceScale().applyOptions({
        autoScale: true,
        scaleMargins: { top: 0, bottom: 0 },
      });
      anchor.createPriceLine({
        price: rpsOptions.threshold,
        color: "#64748b",
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: "RPS阈值",
      });
    }
    let lines: ISeriesApi<"Line">[] = [];
    const render = () => {
      const visible = bars.slice(start);
      candles.setData(
        visible.map((bar) => ({ ...bar, time: chartTime(bar.date, period) })),
      );
      anchor?.setData(
        visible.map((bar) =>
          subchart === "rps"
            ? { time: chartTime(bar.date, period), value: rpsOptions.threshold }
            : { time: chartTime(bar.date, period) },
        ),
      );
      histogram?.setData(
        visible.map((bar, i) => {
          const value =
            subchart === "volume" ? bar.volume : values.MACD[start + i];
          return value == null
            ? { time: chartTime(bar.date, period) }
            : {
                time: chartTime(bar.date, period),
                value,
                color: (
                  subchart === "volume" ? bar.close >= bar.open : value >= 0
                )
                  ? "#cf5562"
                  : "#28977f",
              };
        }),
      );
      for (const line of lines) chart.removeSeries(line);
      lines = [];
      if (subchart === "rps") {
        for (const window of rpsOptions.periods) {
          for (const segment of rpsChartSegments(
            bars,
            rps ?? [],
            period,
            window,
            start,
          )) {
            const line = chart.addSeries(
              LineSeries,
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
              1,
            );
            line.setData(segment.data);
            lines.push(line);
          }
        }
      }
      if (czsc && showCzsc) {
        for (const family of czsc.families) {
          const line = chart.addSeries(LineSeries, {
            color: family.config === 0 ? "#b77900" : "#7c3aed",
            lineWidth: family.config === 0 ? 1 : 2,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
          });
          line.setData(czscChartLines(bars, family.points, period, start));
          lines.push(line);
        }
      }
      const overlay =
        breakout && showBreakout
          ? breakoutChartData(breakout, bars, start, breakoutIndex)
          : null;
      for (const item of overlay?.lines ?? []) {
        const line = chart.addSeries(LineSeries, {
          color: item.color,
          title: item.title,
          lineWidth: 2,
          lineStyle: 2,
          priceLineVisible: false,
          lastValueVisible: true,
          crosshairMarkerVisible: false,
        });
        line.setData(item.data);
        lines.push(line);
      }
      markers?.setMarkers(
        [
          ...(czsc && showCzsc ? czscChartMarkers(czsc, period, start) : []),
          ...(overlay?.markers ?? []),
        ].sort((a, b) => String(a.time).localeCompare(String(b.time))),
      );
      for (const name of names) {
        if (name === "MACD") continue;
        const pane = name.startsWith("MA") || name.startsWith("BOLL") ? 0 : 1;
        for (const segment of indicatorSegments(
          bars,
          values[name],
          period,
          start,
        )) {
          const line = chart.addSeries(
            LineSeries,
            {
              color: colors[name],
              lineWidth: 1,
              priceLineVisible: false,
              lastValueVisible: false,
              pointMarkersVisible: segment.length === 1,
              pointMarkersRadius: 2,
            },
            pane,
          );
          line.setData(segment);
          lines.push(line);
        }
      }
    };
    render();
    chart.panes()[0]?.setStretchFactor(3);
    chart.panes()[1]?.setStretchFactor(1.4);
    if (bars.length)
      chart.timeScale().setVisibleLogicalRange(
        savedRange ?? {
          from: 0,
          to:
            selectedBreakoutIndex >= 0
              ? Math.min(180, bars.length - start - 1)
              : bars.length - start - 1,
        },
      );
    const byTime = new Map(
      bars.map((bar, index) => [chartTime(bar.date, period), index]),
    );
    chart.subscribeCrosshairMove((event) => {
      const index =
        event.time === undefined ? undefined : byTime.get(event.time);
      setHover(index === undefined ? null : { bars, index });
    });
    let frame = 0;
    let updating = false;
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (!range || updating) return;
      viewport.current = { bars, period, start, range, asOf: breakoutIndex };
      if (range.from > 12 || !start || frame) return;
      // Defer setData outside the library's range callback and shift logical
      // indices by the exact prepend count to keep the viewed dates stationary.
      frame = requestAnimationFrame(() => {
        frame = 0;
        const current = chart.timeScale().getVisibleLogicalRange();
        if (!current || current.from > 12) return;
        const next = revealHistory(start, current);
        updating = true;
        start = next.start;
        render();
        chart.timeScale().setVisibleLogicalRange(next.range);
        viewport.current = {
          bars,
          period,
          start,
          asOf: breakoutIndex,
          range: chart.timeScale().getVisibleLogicalRange(),
        };
        setHistoryStart(start);
        updating = false;
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      viewport.current = {
        bars,
        period,
        start,
        asOf: breakoutIndex,
        range: chart.timeScale().getVisibleLogicalRange(),
      };
      chartApi.current = null;
      chart.remove();
    };
  }, [
    bars,
    period,
    values,
    names,
    subchart,
    czsc,
    showCzsc,
    breakout,
    showBreakout,
    breakoutIndex,
    view,
    drawingTool,
    onAnchor,
    cost,
    rps,
    rpsOptions,
  ]);

  return (
    <div
      data-testid="market-chart"
      data-period={period}
      data-dark={view?.dark ?? false}
      style={{
        background: view?.dark ? "#111827" : undefined,
        color: view?.dark ? "#e5e7eb" : undefined,
        padding: 8,
      }}
    >
      <div
        className="flex items-center gap-3 overflow-x-auto py-2 text-sm whitespace-nowrap"
        data-testid="chart-secondary-controls"
      >
        <label>
          <Checkbox
            checked={showBreakout}
            onCheckedChange={(checked) => setShowBreakout(checked === true)}
          />{" "}
          双突破
        </label>
        {breakout && (
          <label className="flex shrink-0 items-center gap-1">
            双突破观察日{" "}
            <Select
              value={breakoutDate}
              onValueChange={(selected) => setBreakoutDate(selected)}
            >
              <SelectTrigger aria-label="双突破观察日" className="w-full">
                <SelectValue placeholder="最新" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">最新</SelectItem>
                {breakout.points.map((p) => (
                  <SelectItem key={p.date} value={p.date}>
                    {p.date}
                    {p.long.status === "是"
                      ? " ↑"
                      : p.short.status === "是"
                        ? " ↓"
                        : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        )}
        <label className="flex items-center gap-1">
          <Checkbox
            checked={showBoll}
            onCheckedChange={(checked) => setShowBoll(checked === true)}
          />
          BOLL
        </label>
        <label className="flex shrink-0 items-center gap-1">
          副图{" "}
          <Select
            value={subchart}
            onValueChange={(selected) => setSubchart(selected as Subchart)}
          >
            <SelectTrigger aria-label="副图" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(subcharts).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label>
          <Checkbox
            checked={showCzsc}
            onCheckedChange={(checked) => setShowCzsc(checked === true)}
          />{" "}
          缠论结构
        </label>
        {subchart === "rps" && (
          <div
            className="flex shrink-0 items-center gap-3 text-xs"
            data-testid="rps-controls"
          >
            {period !== "day" ? (
              <span role="status">RPS仅支持日线，当前周期不可用</span>
            ) : (
              <>
                {rpsPeriods.map((window) => (
                  <label
                    key={window}
                    className="flex items-center gap-1"
                    style={{ color: rpsColors[window] }}
                  >
                    <Checkbox
                      checked={rpsOptions.periods.includes(window)}
                      onCheckedChange={(checked) =>
                        setRpsOptions({
                          ...rpsOptions,
                          periods:
                            checked === true
                              ? [...rpsOptions.periods, window]
                              : rpsOptions.periods.filter((p) => p !== window),
                        })
                      }
                    />
                    RPS{window}
                  </label>
                ))}
                <label className="flex items-center gap-2">
                  参考阈值
                  <Input
                    aria-label="RPS参考阈值"
                    className="w-20"
                    type="number"
                    min={0}
                    max={100}
                    value={rpsOptions.threshold}
                    onChange={(e) => {
                      const n = e.target.valueAsNumber;
                      if (Number.isFinite(n) && n >= 0 && n <= 100)
                        setRpsOptions({ ...rpsOptions, threshold: n });
                    }}
                  />
                </label>
                <span>
                  虚线：回填（生存者偏差） · 实线：向前新增 · 后复权日线排名
                </span>
                <span role="status">
                  {rpsMessage ??
                    (rps?.some((row) => row.values.some((v) => v != null))
                      ? ""
                      : "暂无已落库RPS数据")}
                </span>
                {rpsMessage?.startsWith("RPS读取失败") && onRpsRetry && (
                  <Button variant="plain" onClick={onRpsRetry}>
                    重试RPS
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-3 text-sm">
        <span data-testid="breakout-status">
          {breakoutMessage ??
            (breakout
              ? (() => {
                  const p = breakout.points.find(
                    (p) => p.index === breakoutIndex,
                  );
                  return p
                    ? `${p.date} · 多 ${p.long.status} ${p.long.quality} · 空 ${p.short.status} ${p.short.quality} · 紫色虚线/箭头 · 关键位按来源标注`
                    : "无日线数据";
                })()
              : "")}
        </span>
        <span data-testid="czsc-status">
          {czscMessage ??
            (czsc?.status === "no-structure"
              ? "无结构"
              : czsc
                ? `笔 ${Math.max(0, (czsc.families[0]?.points.length ?? 0) - 1)} · 线段端点 ${czsc.families[1]?.points.length ?? 0} · 中枢 ${czsc.families.reduce((n, f) => n + f.centers.length, 0)} · 金色笔 / 紫色线段 · 阴影背驰`
                : "")}
        </span>
        <span>
          {periodLabels[period]} · 不复权 · {subcharts[subchart]}
        </span>
      </div>
      <div
        data-testid="chart-legend"
        className="flex min-h-16 flex-wrap content-start gap-x-3 gap-y-1 text-xs"
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {legend ? (
          <>
            <span>{legend.bar.date}</span>
            <span>开 {formatValue(legend.bar.open)}</span>
            <span>高 {formatValue(legend.bar.high)}</span>
            <span>低 {formatValue(legend.bar.low)}</span>
            <span>收 {formatValue(legend.bar.close)}</span>
            <span>量 {formatValue(legend.bar.volume)} 股</span>
            {legend.indicators.map(({ name, value }) => (
              <span key={name} style={{ color: colors[name] }}>
                {indicatorLabel(name, parameters)} {formatValue(value)}
              </span>
            ))}
          </>
        ) : (
          <span>暂无行情</span>
        )}
      </div>
      <div
        ref={ref}
        tabIndex={0}
        role="application"
        aria-label="行情图：左右平移，上下缩放"
        onKeyDown={(event) => {
          const range = chartApi.current?.timeScale().getVisibleLogicalRange();
          if (!range) return;
          const next = keyboardRange(range, event.key);
          if (next) {
            event.preventDefault();
            chartApi.current?.timeScale().setVisibleLogicalRange(next);
          }
        }}
        className="price-chart"
        style={{ height: subchart === "none" ? 400 : 560 }}
      />
      <div className="flex justify-between text-xs text-slate-500">
        <span data-testid="chart-history">
          已显示 {bars.length - historyStart} / {bars.length} 根 ·{" "}
          {historyStart ? "向左滚动加载更多历史" : "已到快照历史起点"}
        </span>
        <a
          className="chart-credit"
          href="https://www.tradingview.com/"
          target="_blank"
          rel="noreferrer"
        >
          TradingView Lightweight Charts™ · © 2026 TradingView, Inc.
        </a>
      </div>
    </div>
  );
}
