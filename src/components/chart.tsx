"use client";
import {
  positionRiskCurveSegments,
  type PositionRiskCurvePoint,
} from "~/lib/position-risk";
import {
  rollingChartMetrics,
  rollingCurveSegments,
  type RollingCurvePoint,
} from "~/lib/rolling-performance";
import { rememberChartRange, restoreChartRange } from "~/lib/chart-viewport";
import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { rpsPeriods } from "~/lib/rps";
import { rpsChartSegments, type RpsCurve } from "~/lib/chart-data";
import { Checkbox } from "~/components/ui/checkbox";

import {
  attachDrawings,
  drawingAnchor,
  drawingPreview,
} from "~/lib/chart-drawings";
import {
  chineseChartLocalization,
  chineseTickMark,
} from "~/lib/chart-localization";
import {
  defaultChartView,
  indicatorLabel,
  keyboardRange,
  periodLabels,
  normalizeSubcharts,
  type MainIndicator,
  type Subchart,
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
import {
  chartAdjustmentLabels,
  type ChartAdjustment,
} from "~/lib/chart-adjustment";
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
      localization: chineseChartLocalization,
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
        tickMarkFormatter: chineseTickMark,
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
const subchartLabels: Record<Subchart, string> = {
  volume: "成交量",
  macd: "MACD",
  kdj: "KDJ",
  rsi: "RSI",
  rps: "RPS（日线）",
};
const mainIndicatorLabels: Record<MainIndicator, string> = {
  ma: "均线",
  boll: "BOLL",
};
const formatValue = (value: number | null | undefined, precision = 2) =>
  value == null ? "—" : value.toFixed(precision);

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
    const chart = createChart(ref.current, {
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
            color: ["#287e97", "#cf5562", "#9b4dcc"][pane],
            lineWidth: 2,
            pointMarkersVisible: segment.length === 1,
            priceLineVisible: false,
            lastValueVisible: false,
            priceFormat: {
              type: "custom",
              formatter: (value: number) =>
                pane === 0 || (pane === 1 && simple)
                  ? value.toFixed(4)
                  : `${(value * 100).toFixed(2)}%`,
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
      aria-label="滚动绩效曲线，从上到下为夏普、最大回撤、年化收益；具体数值和覆盖率见分页表格"
    />
  );
}

export function PositionRiskChart({
  points,
}: {
  points: PositionRiskCurvePoint[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, {
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
                    ? value.toFixed(4)
                    : `${(value * 100).toFixed(2)}%`,
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
      aria-label="持仓集中度曲线，上图等效持仓只数，下图最大单一权重；缺失断线，具体数值见分页表格"
    />
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

export function CzscMarketChart({
  pricePrecision = 2,
  volumeUnit,
  bars,
  period,
  snapshotId,
  adjustment = "none",
  chartSnapshot = false,
  view,
  onViewChange,
  drawingTool,
  drawingStart,
  onAnchor,
  cost,
  rps,
  rpsMessage,
  onRpsRetry,
  onHistoryRequest,
  viewportKey,
}: {
  bars: Bar[];
  period: Period;
  snapshotId: string;
  adjustment?: ChartAdjustment;
  chartSnapshot?: boolean;
  pricePrecision?: 2 | 3;
  volumeUnit?: string;
  view?: ChartView;
  onViewChange?: (view: ChartView) => void;
  drawingTool?: Drawing["kind"] | "none";
  drawingStart?: Drawing["a"] | null;
  onAnchor?: (p: Drawing["a"]) => void;
  cost?: number | null;
  rps?: RpsCurve;
  rpsMessage?: string;
  onRpsRetry?: () => void;
  onHistoryRequest?: () => void;
  viewportKey?: string;
}) {
  const [paintedSnapshot, setPaintedSnapshot] = useState("");
  useEffect(() => {
    // Let the mounted price chart paint before starting annotation requests.
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => setPaintedSnapshot(snapshotId));
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [snapshotId]);
  const annotationsReady = paintedSnapshot === snapshotId;
  const result = api.czsc.useQuery(
    { snapshotId, chartSnapshot },
    {
      enabled: annotationsReady,
      staleTime: Infinity,
      retry: false,
    },
  );
  const breakout = api.breakout.useQuery(
    { snapshotId, chartSnapshot },
    {
      enabled: annotationsReady,
      staleTime: Infinity,
      retry: false,
    },
  );
  return (
    <MarketChart
      pricePrecision={pricePrecision}
      volumeUnit={volumeUnit}
      bars={bars}
      period={period}
      adjustment={adjustment}
      view={view}
      onViewChange={onViewChange}
      drawingTool={drawingTool}
      drawingStart={drawingStart}
      onAnchor={onAnchor}
      cost={cost}
      rps={rps}
      rpsMessage={rpsMessage}
      onRpsRetry={onRpsRetry}
      onHistoryRequest={onHistoryRequest}
      viewportKey={viewportKey}
      czsc={result.data}
      breakout={breakout.data}
      breakoutMessage={
        breakout.error
          ? `双突破计算失败：${breakout.error.message}`
          : breakout.isPending
            ? "双突破标注后台加载中，K 线可正常浏览"
            : undefined
      }
      czscMessage={
        result.error
          ? `缠论计算失败：${result.error.message}`
          : result.isPending
            ? "缠论标注后台加载中，K 线可正常浏览"
            : undefined
      }
    />
  );
}

export function MarketChart({
  pricePrecision = 2,
  volumeUnit = "股",
  bars,
  period,
  adjustment = "none",
  czsc,
  czscMessage,
  breakout,
  breakoutMessage,
  view,
  onViewChange,
  drawingTool = "none",
  drawingStart,
  onAnchor,
  cost,
  rps,
  rpsMessage,
  onRpsRetry,
  onHistoryRequest,
  viewportKey,
}: {
  bars: Bar[];
  period: Period;
  adjustment?: ChartAdjustment;
  volumeUnit?: string;
  pricePrecision?: 2 | 3;
  czsc?: CzscResult;
  czscMessage?: string;
  breakout?: BreakoutResult;
  breakoutMessage?: string;
  view?: ChartView;
  onViewChange?: (view: ChartView) => void;
  drawingTool?: Drawing["kind"] | "none";
  drawingStart?: Drawing["a"] | null;
  onAnchor?: (p: Drawing["a"]) => void;
  cost?: number | null;
  rps?: RpsCurve;
  rpsMessage?: string;
  onRpsRetry?: () => void;
  onHistoryRequest?: () => void;
  viewportKey?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const viewport = useRef<{
    bars: Bar[];
    period: Period;
    start: number;
    asOf: number;
    range: LogicalRange | null;
  } | null>(null);
  const [localMainIndicators, setLocalMainIndicators] = useState<
    MainIndicator[]
  >(defaultChartView.mainIndicators);
  const selectedMainIndicators = useMemo(
    () => view?.mainIndicators ?? localMainIndicators,
    [view?.mainIndicators, localMainIndicators],
  );
  const setMainIndicators = (value: MainIndicator[]) =>
    onViewChange && view
      ? onViewChange({ ...view, mainIndicators: value })
      : setLocalMainIndicators(value);
  const chartApi = useRef<ReturnType<typeof createChart> | null>(null);
  const [showCzsc, setShowCzsc] = useState(true);
  const [showBreakout, setShowBreakout] = useState(true);
  const breakoutIndex = breakout?.latest?.index ?? bars.length - 1;
  // One chart shares its time scale across independently scaled indicator panes.
  const [localSubcharts, setLocalSubcharts] = useState<Subchart[]>(
    defaultChartView.subchart,
  );
  const selectedSubcharts = useMemo(
    () => normalizeSubcharts(view?.subchart ?? localSubcharts),
    [view?.subchart, localSubcharts],
  );
  const visibleSubcharts = useMemo(
    () =>
      selectedSubcharts.filter(
        (subchart) => subchart !== "rps" || period === "day",
      ),
    [selectedSubcharts, period],
  );
  const setSubcharts = (value: Subchart[]) =>
    onViewChange && view
      ? onViewChange({ ...view, subchart: value })
      : setLocalSubcharts(value);
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
    () => enabledIndicators(selectedMainIndicators, selectedSubcharts),
    [selectedMainIndicators, selectedSubcharts],
  );
  const legend = chartLegend(
    bars,
    values,
    hover?.bars === bars ? hover.index : bars.length - 1,
    names,
  );
  const mainIndicatorSummary = selectedMainIndicators.length
    ? selectedMainIndicators
        .map((indicator) => mainIndicatorLabels[indicator])
        .join(" + ")
    : "无主图指标";
  const subchartSummary = selectedSubcharts.length
    ? selectedSubcharts.map((subchart) => subchartLabels[subchart]).join(" + ")
    : "无副图";

  useEffect(() => {
    if (!ref.current) return;
    const saved = viewport.current;
    const restored = viewportKey ? restoreChartRange(viewportKey, bars) : null;
    let start =
      saved?.bars === bars &&
      saved.period === period &&
      saved.asOf === breakoutIndex
        ? saved.start
        : (restored?.start ?? initialHistoryStart(bars.length));
    const savedRange =
      saved?.bars === bars &&
      saved.period === period &&
      saved.asOf === breakoutIndex
        ? saved.range
        : (restored?.range ?? null);
    setHistoryStart(start);
    const chart = createChart(ref.current, {
      localization: chineseChartLocalization,
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
        axisPressedMouseMove: {
          time: true,
          price: !visibleSubcharts.includes("rps"),
        },
        mouseWheel: true,
        pinch: true,
      },
      handleScroll: {
        pressedMouseMove: drawingTool === "none",
        mouseWheel: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      timeScale: {
        tickMarkFormatter: chineseTickMark,
        timeVisible: period.endsWith("m"),
        secondsVisible: false,
        borderColor: "#e5ebf2",
      },
      crosshair: { mode: CrosshairMode.Normal },
    });
    chartApi.current = chart;
    const candles = chart.addSeries(CandlestickSeries, {
      priceFormat: {
        type: "price",
        precision: pricePrecision,
        minMove: 10 ** -pricePrecision,
      },
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
    const updatePreview = attachDrawings(
      chart,
      candles,
      bars,
      period,
      [],
      true,
    );
    const drawingContainer = ref.current;
    const anchorAt = (event: MouseEvent) => {
      const bounds = drawingContainer.getBoundingClientRect();
      const x = event.clientX - bounds.left,
        y = event.clientY - bounds.top;
      if (
        x < 0 ||
        x > chart.timeScale().width() ||
        y < 0 ||
        y > chart.panes()[0]!.getHeight()
      )
        return null;
      return drawingAnchor(chart, candles, bars, period, x, y);
    };
    // Chart crosshair events quantize x to a bar even in Normal mode.
    // Native coordinates preserve the actual pointer location between bars.
    const moveDrawing = (event: MouseEvent) => {
      if (drawingTool === "none") return;
      updatePreview(
        drawingPreview(
          drawingTool,
          drawingStart ?? null,
          anchorAt(event),
          view?.dark ? "#60a5fa" : "#2563eb",
        ),
      );
    };
    const clickDrawing = (event: MouseEvent) => {
      if (!onAnchor || drawingTool === "none" || event.button !== 0) return;
      const point = anchorAt(event);
      if (point) {
        updatePreview(null);
        onAnchor(point);
      }
    };
    const clearPreview = () => updatePreview(null);
    drawingContainer.addEventListener("mousemove", moveDrawing);
    drawingContainer.addEventListener("click", clickDrawing);
    drawingContainer.addEventListener("mouseleave", clearPreview);
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
    // Each selected secondary chart gets its own pane. RPS is only available
    // for daily data; a legacy selection on another period is ignored.
    const paneBySubchart = new Map(
      visibleSubcharts.map((subchart, index) => [subchart, index + 1]),
    );
    let volume: ISeriesApi<"Histogram"> | null = null;
    let macd: ISeriesApi<"Histogram"> | null = null;
    let rpsAnchor: ISeriesApi<"Line"> | null = null;
    for (const subchart of visibleSubcharts) {
      const pane = paneBySubchart.get(subchart)!;
      if (subchart === "volume")
        volume = chart.addSeries(
          HistogramSeries,
          {
            priceFormat: { type: "volume" },
            priceLineVisible: false,
            title: "成交量",
          },
          pane,
        );
      else if (subchart === "macd")
        macd = chart.addSeries(
          HistogramSeries,
          {
            priceFormat: { type: "price", precision: 2, minMove: 0.01 },
            priceLineVisible: false,
            title: "MACD",
          },
          pane,
        );
      else if (subchart === "rps")
        rpsAnchor = chart.addSeries(
          LineSeries,
          {
            lastValueVisible: false,
            priceLineVisible: false,
            lineVisible: false,
            crosshairMarkerVisible: false,
            autoscaleInfoProvider: () => ({
              priceRange: { minValue: 0, maxValue: 100 },
            }),
          },
          pane,
        );
      else
        chart.addSeries(
          LineSeries,
          {
            lastValueVisible: false,
            priceLineVisible: false,
            lineVisible: false,
            crosshairMarkerVisible: false,
          },
          pane,
        );
    }
    const rpsPane = paneBySubchart.get("rps");
    // A newly created pane inherits the first pane scale settings in LWC 5.
    // Explicitly reset every secondary pane after it exists.
    for (const pane of chart.panes().slice(1))
      pane.priceScale("right").applyOptions({ mode: 0 });
    if (rpsAnchor) {
      rpsAnchor.priceScale().applyOptions({
        autoScale: true,
        scaleMargins: { top: 0, bottom: 0 },
      });
      rpsAnchor.createPriceLine({
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
      volume?.setData(
        visible.map((bar) => ({
          time: chartTime(bar.date, period),
          value: bar.volume,
          color: bar.close >= bar.open ? "#cf5562" : "#28977f",
        })),
      );
      rpsAnchor?.setData(
        visible.map((bar) => ({
          time: chartTime(bar.date, period),
          value: rpsOptions.threshold,
        })),
      );
      macd?.setData(
        visible.map((bar, i) => {
          const value = values.MACD[start + i];
          return value == null
            ? { time: chartTime(bar.date, period) }
            : {
                time: chartTime(bar.date, period),
                value,
                color: value >= 0 ? "#cf5562" : "#28977f",
              };
        }),
      );
      for (const line of lines) chart.removeSeries(line);
      lines = [];
      if (rpsPane !== undefined) {
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
              rpsPane,
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
          ? breakoutChartData(breakout, bars, start, breakoutIndex, period)
          : null;
      for (const item of overlay?.lines ?? []) {
        const line = chart.addSeries(LineSeries, {
          color: item.color,
          lineWidth: 2,
          lineStyle: 2,
          priceLineVisible: false,
          lastValueVisible: false,
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
        const pane =
          name.startsWith("MA") || name.startsWith("BOLL")
            ? 0
            : name === "DIF" || name === "DEA"
              ? paneBySubchart.get("macd")
              : name === "K" || name === "D" || name === "J"
                ? paneBySubchart.get("kdj")
                : paneBySubchart.get("rsi");
        if (pane === undefined) continue;
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
    visibleSubcharts.forEach((subchart, index) => {
      chart
        .panes()
        [index + 1]?.setStretchFactor(subchart === "rps" ? 1.2 : 1.4);
    });
    if (bars.length)
      chart.timeScale().setVisibleLogicalRange(
        savedRange ?? {
          from: 0,
          to: bars.length - start - 1,
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
    let dragging = false;
    const container = ref.current;
    const beginDrag = () => {
      dragging = true;
    };
    const endDrag = () => {
      dragging = false;
      reveal(chart.timeScale().getVisibleLogicalRange());
    };
    const reveal = (range: LogicalRange | null) => {
      if (!range || updating) return;
      viewport.current = { bars, period, start, range, asOf: breakoutIndex };
      if (dragging || range.from > 12 || frame) return;
      if (!start) {
        onHistoryRequest?.();
        return;
      }
      // Defer setData outside the library's range callback and shift logical
      // indices by the exact prepend count to keep the viewed dates stationary.
      frame = requestAnimationFrame(() => {
        frame = 0;
        const current = chart.timeScale().getVisibleLogicalRange();
        if (dragging || !current || current.from > 12) return;
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
    };
    // Replacing series during a pressed-mouse gesture resets the library's
    // scroll anchor. Reveal older bars after release, preserving the viewport.
    container.addEventListener("pointerdown", beginDrag, true);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    chart.timeScale().subscribeVisibleLogicalRangeChange(reveal);
    return () => {
      container.removeEventListener("mousemove", moveDrawing);
      container.removeEventListener("click", clickDrawing);
      container.removeEventListener("mouseleave", clearPreview);
      container.removeEventListener("pointerdown", beginDrag, true);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
      cancelAnimationFrame(frame);
      viewport.current = {
        bars,
        period,
        start,
        asOf: breakoutIndex,
        range: chart.timeScale().getVisibleLogicalRange(),
      };
      if (viewportKey)
        rememberChartRange(
          viewportKey,
          bars,
          start,
          chart.timeScale().getVisibleLogicalRange(),
        );
      chartApi.current = null;
      chart.remove();
    };
  }, [
    bars,
    period,
    values,
    names,
    selectedSubcharts,
    visibleSubcharts,
    czsc,
    showCzsc,
    breakout,
    showBreakout,
    breakoutIndex,
    view,
    drawingTool,
    drawingStart,
    onAnchor,
    cost,
    rps,
    rpsOptions,
    onHistoryRequest,
    viewportKey,
    pricePrecision,
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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label="主图指标"
            >
              主图：{mainIndicatorSummary}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {(
              Object.entries(mainIndicatorLabels) as [MainIndicator, string][]
            ).map(([value, label]) => (
              <DropdownMenuCheckboxItem
                key={value}
                checked={selectedMainIndicators.includes(value)}
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={(checked) =>
                  setMainIndicators(
                    checked
                      ? [...selectedMainIndicators, value]
                      : selectedMainIndicators.filter((item) => item !== value),
                  )
                }
              >
                {label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label="副图组合"
            >
              副图：{subchartSummary}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {(Object.entries(subchartLabels) as [Subchart, string][]).map(
              ([value, label]) => {
                const disabled =
                  value === "rps" &&
                  period !== "day" &&
                  !selectedSubcharts.includes(value);
                return (
                  <DropdownMenuCheckboxItem
                    key={value}
                    checked={selectedSubcharts.includes(value)}
                    disabled={disabled}
                    onSelect={(event) => event.preventDefault()}
                    onCheckedChange={(checked) =>
                      setSubcharts(
                        checked
                          ? [...selectedSubcharts, value]
                          : selectedSubcharts.filter((item) => item !== value),
                      )
                    }
                  >
                    {label}
                    {disabled && "（仅日线）"}
                  </DropdownMenuCheckboxItem>
                );
              },
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <label>
          <Checkbox
            checked={showBreakout}
            onCheckedChange={(checked) => setShowBreakout(checked === true)}
          />{" "}
          双突破
        </label>
        <label>
          <Checkbox
            checked={showCzsc}
            onCheckedChange={(checked) => setShowCzsc(checked === true)}
          />{" "}
          缠论结构
        </label>
        {selectedSubcharts.includes("rps") && (
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
        {(showBreakout || breakoutMessage?.startsWith("双突破计算失败")) && (
          <span data-testid="breakout-status">
            {breakoutMessage ??
              (breakout
                ? (() => {
                    const p = breakout.points.find(
                      (p) => p.index === breakoutIndex,
                    );
                    return p
                      ? `${p.date.slice(0, 16).replace("T", " ")} · 多 ${p.long.status} ${p.long.quality} · 空 ${p.short.status} ${p.short.quality} · 紫色虚线/箭头 · 关键位按来源标注`
                      : "无日线数据";
                  })()
                : "")}
          </span>
        )}
        {(showCzsc || czscMessage?.startsWith("缠论计算失败")) && (
          <span data-testid="czsc-status">
            {czscMessage ??
              (czsc?.status === "no-structure"
                ? "无结构"
                : czsc
                  ? `笔 ${Math.max(0, (czsc.families[0]?.points.length ?? 0) - 1)} · 线段端点 ${czsc.families[1]?.points.length ?? 0} · 中枢 ${czsc.families.reduce((n, f) => n + f.centers.length, 0)} · 金色笔 / 紫色线段 · 阴影背驰`
                  : "")}
          </span>
        )}
        <span>
          {periodLabels[period]} · {chartAdjustmentLabels[adjustment]} ·{" "}
          {subchartSummary}
        </span>
      </div>
      <div
        data-testid="chart-legend"
        className="flex min-h-8 flex-wrap content-start gap-x-3 gap-y-1 text-xs"
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {legend ? (
          <>
            <span>
              {chineseChartLocalization.timeFormatter(
                chartTime(legend.bar.date, period),
              )}
            </span>
            <span>开 {formatValue(legend.bar.open, pricePrecision)}</span>
            <span>高 {formatValue(legend.bar.high, pricePrecision)}</span>
            <span>低 {formatValue(legend.bar.low, pricePrecision)}</span>
            <span>收 {formatValue(legend.bar.close, pricePrecision)}</span>
            {selectedSubcharts.includes("volume") && (
              <span>
                量 {formatValue(legend.bar.volume)} {volumeUnit}
              </span>
            )}
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
      {showBreakout && breakout && (
        <div
          data-testid="chart-level-legend"
          className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums"
          aria-label="双突破关键位与趋势线"
        >
          {breakoutChartData(
            breakout,
            bars,
            0,
            breakoutIndex,
            period,
          ).lines.map((line) => (
            <span key={line.title} style={{ color: line.color }}>
              {line.title}
            </span>
          ))}
        </div>
      )}
      <div
        ref={ref}
        tabIndex={0}
        role="application"
        aria-label="行情图：按住鼠标左键拖动，左右键平移，上下键缩放"
        onPointerDown={(event) => event.currentTarget.focus()}
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
        style={{
          // Fill the window below the toolbar instead of a fixed height, so the
          // chart is fully visible on a laptop screen and grows on a large one.
          // 660px is the application chrome above and below the canvas; the
          // clamp keeps the main pane usable on short windows.
          height: `clamp(${
            visibleSubcharts.length === 0
              ? 320
              : 320 + visibleSubcharts.length * 120
          }px, calc(100dvh - 660px), 1200px)`,
          cursor: drawingTool === "none" ? "grab" : "crosshair",
        }}
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
