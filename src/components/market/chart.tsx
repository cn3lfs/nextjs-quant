"use client";
import { chartColor, createNocturneChart } from "~/lib/chart/chart-theme";
import {
  positionRiskCurveSegments,
  type PositionRiskCurvePoint,
} from "~/lib/portfolio/position-risk";
import {
  rollingChartMetrics,
  rollingCurveSegments,
  type RollingCurvePoint,
} from "~/lib/backtest/rolling-performance";
import {
  rememberChartRange,
  restoreChartRange,
} from "~/lib/chart/chart-viewport";
import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";
import { rpsPeriods } from "~/lib/screening/rps";
import { rpsChartSegments, type RpsCurve } from "~/lib/chart/chart-data";
import { Checkbox } from "~/components/ui/checkbox";

import {
  attachDrawings,
  drawingAnchor,
  drawingX,
  hitDrawing,
  type DrawingHandle,
  drawingPreview,
} from "~/lib/chart/chart-drawings";
import {
  chineseChartLocalization,
  chineseTickMark,
} from "~/lib/chart/chart-localization";
import {
  defaultChartView,
  defaultParameters,
  indicatorCatalog,
  indicatorLabel,
  indicatorParametersSchema,
  parameterSummary,
  type IndicatorParameters,
  keyboardRange,
  keyboardPage,
  keyboardCursor,
  periodLabels,
  normalizeSubcharts,
  type MainIndicator,
  type Subchart,
  type ChartPeriod as Period,
  type ChartView,
  type Drawing,
} from "~/lib/chart/chart-view";
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
  type IPriceLine,
  type LineSeriesPartialOptions,
  type SeriesType,
  type ISeriesMarkersPluginApi,
} from "lightweight-charts";
import type { Bar } from "~/lib/domain";
import {
  chartAdjustmentLabels,
  type ChartAdjustment,
} from "~/lib/chart/chart-adjustment";
import type { CzscResult } from "~/lib/research/methods/chan/czsc";
import type { BreakoutResult } from "~/server/strategies/breakout/breakout";
import { breakoutChartData } from "~/lib/chart/chart-data";
import {
  barInstant,
  linkedIndex,
  type CrosshairLink,
} from "~/lib/chart/crosshair-link";
import { api } from "~/trpc/react";
import {
  chartIndicators,
  chartLegend,
  chartTime,
  wallClockLabel,
  enabledIndicators,
  indicatorSegments,
  initialHistoryStart,
  revealHistory,
  czscChartLines,
  czscChartMarkers,
  type IndicatorName,
} from "~/lib/chart/chart-data";
import { usePanelVisible } from "../workbench/keep-alive";
import { useCzscSettings } from "~/lib/stores/czsc-settings-store";
import { czscEffectiveSettings } from "~/lib/chart/czsc-settings";
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

const colors: Record<IndicatorName, string> = {
  MA5: chartColor.series1,
  MA10: chartColor.series2,
  MA20: chartColor.series3,
  MA60: chartColor.series4,
  BOLL中: chartColor.muted,
  BOLL上: chartColor.series1,
  BOLL下: chartColor.series1,
  DIF: chartColor.series1,
  DEA: chartColor.series2,
  MACD: chartColor.up,
  K: chartColor.series1,
  D: chartColor.series2,
  J: chartColor.series3,
  RSI6: chartColor.series1,
  RSI12: chartColor.series2,
  RSI24: chartColor.series3,
  EMA1: chartColor.series1,
  EMA2: chartColor.series2,
  EMA3: chartColor.series3,
  WR1: chartColor.series1,
  WR2: chartColor.series2,
  BIAS1: chartColor.series1,
  BIAS2: chartColor.series2,
  BIAS3: chartColor.series3,
  CCI: chartColor.series1,
  OBV: chartColor.series2,
};
const rpsColors: Record<number, string> = {
  5: chartColor.up,
  10: chartColor.down,
  20: chartColor.muted,
  50: chartColor.series1,
  120: chartColor.series2,
  250: chartColor.series3,
};
const subchartLabels: Record<Subchart, string> = {
  volume: "成交量",
  macd: "MACD",
  kdj: "KDJ",
  rsi: "RSI",
  wr: "WR",
  bias: "BIAS",
  cci: "CCI",
  obv: "OBV",
  rps: "RPS",
};
const mainIndicatorLabels: Record<MainIndicator, string> = {
  ma: "MA",
  ema: "EMA",
  boll: "BOLL",
};
/** Legend groups: indicator lines sharing one parameter set and header. */
const legendGroups: {
  key: keyof IndicatorParameters | "obv";
  names: IndicatorName[];
}[] = [
  { key: "ma", names: ["MA5", "MA10", "MA20", "MA60"] },
  { key: "ema", names: ["EMA1", "EMA2", "EMA3"] },
  { key: "boll", names: ["BOLL中", "BOLL上", "BOLL下"] },
  { key: "macd", names: ["DIF", "DEA", "MACD"] },
  { key: "kdj", names: ["K", "D", "J"] },
  { key: "rsi", names: ["RSI6", "RSI12", "RSI24"] },
  { key: "wr", names: ["WR1", "WR2"] },
  { key: "bias", names: ["BIAS1", "BIAS2", "BIAS3"] },
  { key: "cci", names: ["CCI"] },
  { key: "obv", names: ["OBV"] },
];
/** Sub-chart pane that hosts an indicator line; main-chart lines use pane 0. */
const subchartOf = (name: IndicatorName): Subchart | "main" =>
  name.startsWith("MA") || name.startsWith("EMA") || name.startsWith("BOLL")
    ? "main"
    : name === "DIF" || name === "DEA" || name === "MACD"
      ? "macd"
      : name === "K" || name === "D" || name === "J"
        ? "kdj"
        : name.startsWith("RSI")
          ? "rsi"
          : name.startsWith("WR")
            ? "wr"
            : name.startsWith("BIAS")
              ? "bias"
              : name === "CCI"
                ? "cci"
                : "obv";
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
      // autoSize follows the container: without a fixed height the canvas
      // grows the container, which grows the canvas again, without end.
      style={{ height: 540 }}
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
      // autoSize follows the container: without a fixed height the canvas
      // grows the container, which grows the canvas again, without end.
      style={{ height: 360 }}
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
  drawingPoints,
  drawingText,
  compare,
  onAnchor,
  cost,
  rps,
  rpsMessage,
  onRpsRetry,
  onHistoryRequest,
  viewportKey,
  annotations = true,
  rpsAvailable = true,
  hotkeys = false,
  link,
  height,
  sharedDrawings,
}: {
  bars: Bar[];
  period: Period;
  snapshotId: string;
  hotkeys?: boolean;
  /** Crosshair shared with the other periods of this symbol. */
  link?: { hub: CrosshairLink; id: string };
  /** Fixed canvas height (a secondary chart); default fills the window. */
  height?: number;
  /** Drawings shared from the symbol's other periods, already remapped. */
  sharedDrawings?: Drawing[];
  /** RPS is an A-share ranking; futures, crypto and sectors hide it. */
  rpsAvailable?: boolean;
  /** Chan/breakout overlays; off for charts outside the A-share method scope. */
  annotations?: boolean;
  adjustment?: ChartAdjustment;
  chartSnapshot?: boolean;
  pricePrecision?: number;
  volumeUnit?: string;
  view?: ChartView;
  onViewChange?: (view: ChartView) => void;
  drawingTool?: Drawing["kind"] | "none";
  /** Comparison symbols (TDX 叠加): drawn on a shared percentage scale. */
  compare?: readonly ChartCompare[];
  /** Anchors placed so far for the active drawing tool. */
  drawingPoints?: readonly Drawing["a"][];
  /** Label for the text tool preview. */
  drawingText?: string;
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
  // A hidden kept-alive panel defers the structure analysis until shown.
  const visible = usePanelVisible();
  const annotationsReady = visible && paintedSnapshot === snapshotId;
  const czscSettings = useCzscSettings();
  const { values: czscValues, showStroke, showSegment } = czscSettings;
  // The schema's dependency rules fix or drop inapplicable fields before the
  // DLL sees them, so a stale combination never fails the whole overlay.
  const czscSchema = api.czscSchema.useQuery(undefined, {
    enabled: annotations,
    staleTime: Infinity,
    retry: false,
  });
  const result = api.czsc.useQuery(
    {
      snapshotId,
      chartSnapshot,
      settings: czscEffectiveSettings(czscSchema.data, czscValues),
    },
    {
      enabled: annotationsReady && annotations,
      staleTime: Infinity,
      retry: false,
    },
  );
  // Level toggles only filter what is drawn; structure settings went to the query.
  const czscView = useMemo(
    () =>
      result.data && {
        ...result.data,
        families: result.data.families.filter((f) =>
          f.config === 0 ? showStroke : showSegment,
        ),
      },
    [result.data, showStroke, showSegment],
  );
  const breakout = api.breakout.useQuery(
    { snapshotId, chartSnapshot },
    {
      enabled: annotationsReady && annotations,
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
      drawingPoints={drawingPoints}
      drawingText={drawingText}
      compare={compare}
      onAnchor={onAnchor}
      cost={cost}
      rps={rps}
      rpsMessage={rpsMessage}
      onRpsRetry={onRpsRetry}
      onHistoryRequest={onHistoryRequest}
      viewportKey={viewportKey}
      annotations={annotations}
      rpsAvailable={rpsAvailable}
      hotkeys={hotkeys}
      link={link}
      height={height}
      sharedDrawings={sharedDrawings}
      czsc={annotations ? czscView : undefined}
      breakout={annotations ? breakout.data : undefined}
      breakoutMessage={
        !annotations
          ? undefined
          : breakout.error
            ? `双突破计算失败：${breakout.error.message}`
            : breakout.isPending
              ? "双突破标注后台加载中，K 线可正常浏览"
              : undefined
      }
      czscMessage={
        !annotations
          ? undefined
          : result.error
            ? `缠论计算失败：${result.error.message}`
            : result.isPending
              ? "缠论标注后台加载中，K 线可正常浏览"
              : undefined
      }
    />
  );
}

export type ChartCompare = { symbol: string; label: string; bars: Bar[] };
// Theme categorical colours, distinct from the MA/structure lines.
export const compareColors = [
  chartColor.series3,
  chartColor.series4,
  chartColor.accentLight,
] as const;

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
  drawingPoints,
  drawingText,
  compare,
  onAnchor,
  cost,
  rps,
  rpsMessage,
  onRpsRetry,
  onHistoryRequest,
  viewportKey,
  annotations = true,
  rpsAvailable = true,
  hotkeys = false,
  link,
  height,
  sharedDrawings,
}: {
  bars: Bar[];
  period: Period;
  adjustment?: ChartAdjustment;
  annotations?: boolean;
  /** Page-level TDX keys (arrows, Home/End, PageUp/PageDown, Esc) without
   * first focusing the chart; for the one main chart of a page. */
  hotkeys?: boolean;
  /** Crosshair shared with the other periods of this symbol. */
  link?: { hub: CrosshairLink; id: string };
  /** Fixed canvas height (a secondary chart); default fills the window. */
  height?: number;
  /** Drawings shared from the symbol's other periods, already remapped. */
  sharedDrawings?: Drawing[];
  rpsAvailable?: boolean;
  volumeUnit?: string;
  pricePrecision?: number;
  czsc?: CzscResult;
  czscMessage?: string;
  breakout?: BreakoutResult;
  breakoutMessage?: string;
  view?: ChartView;
  onViewChange?: (view: ChartView) => void;
  drawingTool?: Drawing["kind"] | "none";
  /** Comparison symbols (TDX 叠加): drawn on a shared percentage scale. */
  compare?: readonly ChartCompare[];
  /** Anchors placed so far for the active drawing tool. */
  drawingPoints?: readonly Drawing["a"][];
  /** Label for the text tool preview. */
  drawingText?: string;
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
        (subchart) => subchart !== "rps" || (rpsAvailable && period === "day"),
      ),
    [selectedSubcharts, period, rpsAvailable],
  );
  const setSubcharts = (value: Subchart[]) =>
    onViewChange && view
      ? onViewChange({ ...view, subchart: value })
      : setLocalSubcharts(value);
  const [localRps, setLocalRps] = useState(defaultChartView.rps);
  const rpsOptions = view?.rps ?? localRps;
  const setRpsOptions = (rps: ChartView["rps"]) =>
    onViewChange && view ? onViewChange({ ...view, rps }) : setLocalRps(rps);
  const [localParameters, setLocalParameters] = useState(defaultParameters);
  const parameters = view?.parameters ?? localParameters;
  const setParameters = (value: IndicatorParameters) =>
    onViewChange && view
      ? onViewChange({ ...view, parameters: value })
      : setLocalParameters(value);
  const [editing, setEditing] = useState<keyof IndicatorParameters | null>(
    null,
  );
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
    () => enabledIndicators(selectedMainIndicators, visibleSubcharts),
    [selectedMainIndicators, visibleSubcharts],
  );
  const legend = chartLegend(
    bars,
    values,
    hover?.bars === bars ? hover.index : bars.length - 1,
    names,
  );
  const subchartOptions = (Object.keys(subchartLabels) as Subchart[]).filter(
    (value) => value !== "rps" || rpsAvailable,
  );
  const dark = view?.dark ?? false;
  const logarithmic = view?.logarithmic ?? false;
  const drawings = view?.drawings;
  const hasRps = visibleSubcharts.includes("rps");
  // Long-lived chart callbacks read the latest props through this ref, so
  // pointer/drawing state never forces the native chart to be rebuilt.
  const [selected, setSelected] = useState<string | null>(null);
  const live = useRef({
    drawingTool,
    drawingPoints,
    drawingText,
    onAnchor,
    onHistoryRequest,
    dark,
    view,
    onViewChange,
  });
  live.current = {
    drawingTool,
    drawingPoints,
    drawingText,
    onAnchor,
    onHistoryRequest,
    dark,
    view,
    onViewChange,
  };
  // The native chart and its content layer. Created once per period and
  // precision; everything else is applied in place by the effects below.
  const native = useRef<{
    chart: ReturnType<typeof createChart>;
    candles: ISeriesApi<"Candlestick">;
    setDrawings: ReturnType<typeof attachDrawings>;
    /** Drawings shared from other periods: dashed and read-only. */
    setShared: ReturnType<typeof attachDrawings>;
    markers: ISeriesMarkersPluginApi<Time>;
    /** What the structure primitive paints; replaced per content pass. */
    structure: { czsc: CzscResult | null; bars: Bar[]; start: number };
    bars: Bar[];
    start: number;
    asOf: number;
    byTime: Map<Time, number>;
    renderBase: () => void;
    renderIndicators: () => void;
    baseLines: ISeriesApi<"Line">[];
    compareLines: ISeriesApi<"Line">[];
    indicatorLines: ISeriesApi<"Line">[];
    /** One pane per selected subchart, identified by its anchor series. */
    panes: Map<
      Subchart,
      { anchor: ISeriesApi<SeriesType>; threshold: IPriceLine | null }
    >;
    costLine: IPriceLine | null;
    /** Keyboard cursor bar index (TDX ←/→), null when not in cursor mode. */
    cursor: number | null;
    /** Range to apply after the next data change; undefined = keep. */
    pendingRange?: LogicalRange | null;
  } | null>(null);
  const linkRef = useRef(link);
  linkRef.current = link;
  /** True while applying a position received from the link. */
  const linking = useRef(false);
  useEffect(() => {
    if (!link) return;
    return link.hub.subscribe((from, instant) => {
      const n = native.current;
      if (from === link.id || !n) return;
      const index =
        instant === null ? null : linkedIndex(n.bars, period, instant);
      linking.current = true;
      try {
        if (index === null || index < n.start) {
          n.chart.clearCrosshairPosition();
          setHover(null);
          return;
        }
        const bar = n.bars[index]!;
        // Bring the linked bar into view, keeping the zoom.
        const scale = n.chart.timeScale();
        const range = scale.getVisibleLogicalRange();
        const logical = index - n.start;
        if (range && (logical < range.from || logical > range.to)) {
          const half = (range.to - range.from) / 2;
          scale.setVisibleLogicalRange({
            from: logical - half,
            to: logical + half,
          });
        }
        n.chart.setCrosshairPosition(
          bar.close,
          chartTime(bar.date, period),
          n.candles,
        );
        setHover({ bars: n.bars, index });
      } finally {
        linking.current = false;
      }
    });
  }, [link, period]);

  useEffect(() => {
    if (!ref.current) return;
    const chart = createNocturneChart(ref.current, {
      localization: chineseChartLocalization,
      autoSize: true,
      layout: { attributionLogo: true },
      rightPriceScale: {
        borderColor: chartColor.muted,
        mode: 0,
      },
      handleScale: {
        axisPressedMouseMove: { time: true, price: true },
        mouseWheel: true,
        pinch: true,
      },
      handleScroll: {
        pressedMouseMove: true,
        mouseWheel: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      timeScale: {
        tickMarkFormatter: chineseTickMark,
        timeVisible: period.endsWith("m"),
        secondsVisible: false,
        borderColor: chartColor.border,
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
      upColor: chartColor.up,
      downColor: chartColor.down,
      borderVisible: false,
      wickUpColor: chartColor.up,
      wickDownColor: chartColor.down,
    });
    const setDrawings = attachDrawings(chart, candles, [], period, []);
    const updatePreview = attachDrawings(chart, candles, [], period, [], true);
    const setShared = attachDrawings(chart, candles, [], period, [], true);
    const markers = createSeriesMarkers(candles, []);
    const state: NonNullable<typeof native.current> = {
      chart,
      candles,
      setDrawings,
      setShared,
      markers,
      structure: { czsc: null, bars: [], start: 0 },
      bars: [],
      start: 0,
      asOf: -1,
      byTime: new Map(),
      renderBase: () => {},
      renderIndicators: () => {},
      baseLines: [],
      compareLines: [],
      indicatorLines: [],
      panes: new Map(),
      costLine: null,
      cursor: null,
    };
    native.current = state;
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
      return drawingAnchor(chart, candles, state.bars, period, x, y);
    };
    // Chart crosshair events quantize x to a bar even in Normal mode.
    // Native coordinates preserve the actual pointer location between bars.
    const moveDrawing = (event: MouseEvent) => {
      const {
        drawingTool: tool,
        drawingPoints: from,
        drawingText,
      } = live.current;
      if (tool === "none") return;
      updatePreview(
        drawingPreview(
          tool,
          from ?? [],
          anchorAt(event),
          chartColor.accentLight,
          drawingText,
        ),
      );
    };
    const clickDrawing = (event: MouseEvent) => {
      const { drawingTool: tool, onAnchor: anchor } = live.current;
      if (!anchor || tool === "none" || event.button !== 0) return;
      const point = anchorAt(event);
      if (point) {
        updatePreview(null);
        anchor(point);
      }
    };
    const clearPreview = () => updatePreview(null);
    drawingContainer.addEventListener("mousemove", moveDrawing);
    drawingContainer.addEventListener("click", clickDrawing);
    drawingContainer.addEventListener("mouseleave", clearPreview);
    // Browsing (no tool): pointing at a saved drawing selects it; dragging a
    // handle reshapes it, dragging the body moves it. Anchors are recomputed
    // from the moved pixels so they stay on real bars and prices.
    let edit: {
      id: string;
      handle: DrawingHandle | null;
      x: number;
      y: number;
      original: Drawing;
      next: Drawing | null;
    } | null = null;
    const local = (event: MouseEvent) => {
      const bounds = drawingContainer.getBoundingClientRect();
      return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    };
    const shift = (p: Drawing["a"], dx: number, dy: number) => {
      const x = drawingX(chart, p, period),
        y = candles.priceToCoordinate(p.price);
      return x === null || y === null
        ? null
        : drawingAnchor(chart, candles, state.bars, period, x + dx, y + dy);
    };
    const reshape = (
      d: Drawing,
      handle: DrawingHandle | null,
      dx: number,
      dy: number,
    ): Drawing | null => {
      const keys: DrawingHandle[] =
        handle && d.kind !== "horizontal"
          ? [handle]
          : (["a", "b", "c"] as const).filter((k) => d[k]);
      const next: Drawing = { ...d };
      for (const key of keys) {
        const moved = shift(d[key]!, dx, dy);
        if (!moved) return null;
        next[key] = moved;
      }
      return next;
    };
    const beginEdit = (event: PointerEvent) => {
      const {
        drawingTool: tool,
        view: current,
        onViewChange: save,
      } = live.current;
      if (tool !== "none" || event.button !== 0 || !current || !save) return;
      const p = local(event);
      if (p.y > chart.panes()[0]!.getHeight()) return;
      const hit = hitDrawing(setDrawings.geometries(), p.x, p.y);
      setSelected(hit?.id ?? null);
      const original = hit && current.drawings.find((d) => d.id === hit.id);
      if (!hit || !original) return;
      edit = { id: hit.id, handle: hit.handle, ...p, original, next: null };
      // Keep the chart from panning under the drag.
      chart.applyOptions({
        handleScroll: { pressedMouseMove: false },
        handleScale: { axisPressedMouseMove: false },
      });
      event.stopPropagation();
    };
    const blockPan = (event: MouseEvent) => {
      if (edit) event.stopPropagation();
    };
    const moveEdit = (event: PointerEvent) => {
      if (!edit) return;
      const p = local(event);
      const next = reshape(
        edit.original,
        edit.handle,
        p.x - edit.x,
        p.y - edit.y,
      );
      const current = live.current.view;
      if (!next || !current) return;
      edit.next = next;
      setDrawings(
        current.drawings.map((d) => (d.id === next.id ? next : d)),
        next.id,
      );
    };
    const endEdit = () => {
      if (!edit) return;
      const { next } = edit;
      edit = null;
      const {
        view: current,
        onViewChange: save,
        drawingTool: tool,
      } = live.current;
      chart.applyOptions({
        handleScroll: { pressedMouseMove: tool === "none" },
        handleScale: {
          axisPressedMouseMove: {
            time: true,
            price: !current?.subchart.includes("rps"),
          },
        },
      });
      if (next && current && save)
        save({
          ...current,
          drawings: current.drawings.map((d) => (d.id === next.id ? next : d)),
        });
    };
    drawingContainer.addEventListener("pointerdown", beginEdit, true);
    drawingContainer.addEventListener("mousedown", blockPan, true);
    window.addEventListener("pointermove", moveEdit);
    window.addEventListener("pointerup", endEdit);
    // A series primitive follows the chart's own pan/zoom/price-scale paint cycle.
    // Rectangles use DLL boundaries and ZG/ZD; no chart-side structure calculation.
    const primitive: ISeriesPrimitive<Time> = {
      paneViews: () => [
        {
          zOrder: () => "normal",
          renderer: () => ({
            draw: (target) =>
              target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
                const { czsc: structure, bars: shown, start } = state.structure;
                if (!structure) return;
                const x = (index: number) =>
                  chart
                    .timeScale()
                    .timeToCoordinate(chartTime(shown[index]!.date, period));
                for (const family of structure.families) {
                  const color =
                    family.config === 0
                      ? chartColor.series1
                      : chartColor.accent;
                  for (const center of family.centers) {
                    // The DLL projection already ends the box at the first three members or the extension.
                    const end = center.end;
                    if (end < start) continue;
                    const x1 = x(Math.max(start, center.start)),
                      x2 = x(end);
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
                    const x1 = x(Math.max(start, interval.start)),
                      x2 = x(interval.end);
                    if (x1 === null || x2 === null) continue;
                    ctx.fillStyle =
                      interval.direction > 0
                        ? chartColor.upFaint
                        : chartColor.downFaint;
                    ctx.fillRect(x1, 0, x2 - x1, mediaSize.height);
                  }
                }
              }),
          }),
        },
      ],
    };
    candles.attachPrimitive(primitive);
    chart.subscribeCrosshairMove((event) => {
      const index =
        event.time === undefined ? undefined : state.byTime.get(event.time);
      // Arrow keys continue from wherever the pointer last left the cursor.
      if (index !== undefined) state.cursor = index;
      setHover(index === undefined ? null : { bars: state.bars, index });
      // Echoes of a position applied from the link are not published again.
      if (linking.current || !linkRef.current) return;
      const bar = index === undefined ? undefined : state.bars[index];
      linkRef.current.hub.publish(
        linkRef.current.id,
        bar ? barInstant(bar.date, period) : null,
      );
    });
    let frame = 0;
    let updating = false;
    let dragging = false;
    const container = ref.current;
    const remember = (range: LogicalRange | null) => {
      viewport.current = {
        bars: state.bars,
        period,
        start: state.start,
        range,
        asOf: state.asOf,
      };
    };
    const beginDrag = () => {
      dragging = true;
    };
    const endDrag = () => {
      dragging = false;
      reveal(chart.timeScale().getVisibleLogicalRange());
    };
    const reveal = (range: LogicalRange | null) => {
      if (!range || updating) return;
      remember(range);
      if (dragging || range.from > 12 || frame) return;
      if (!state.start) {
        live.current.onHistoryRequest?.();
        return;
      }
      // Defer setData outside the library's range callback and shift logical
      // indices by the exact prepend count to keep the viewed dates stationary.
      frame = requestAnimationFrame(() => {
        frame = 0;
        const current = chart.timeScale().getVisibleLogicalRange();
        if (dragging || !current || current.from > 12) return;
        const next = revealHistory(state.start, current);
        updating = true;
        state.start = next.start;
        state.renderBase();
        state.renderIndicators();
        chart.timeScale().setVisibleLogicalRange(next.range);
        remember(chart.timeScale().getVisibleLogicalRange());
        setHistoryStart(state.start);
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
      container.removeEventListener("pointerdown", beginEdit, true);
      container.removeEventListener("mousedown", blockPan, true);
      window.removeEventListener("pointermove", moveEdit);
      window.removeEventListener("pointerup", endEdit);
      container.removeEventListener("pointerdown", beginDrag, true);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
      cancelAnimationFrame(frame);
      const range = chart.timeScale().getVisibleLogicalRange();
      remember(range);
      if (viewportKey)
        rememberChartRange(viewportKey, state.bars, state.start, range);
      native.current = null;
      chartApi.current = null;
      chart.remove();
    };
  }, [period, pricePrecision, viewportKey]);

  // Appearance and gesture options: applied in place.
  useEffect(() => {
    const n = native.current;
    if (!n) return;
    n.chart.applyOptions({
      layout: {
        background: {
          type: ColorType.Solid,
          color: dark ? chartColor.groundDeep : chartColor.ground,
        },
        textColor: dark ? chartColor.textStrong : chartColor.text,
      },
      grid: {
        vertLines: { color: dark ? chartColor.gridDeep : chartColor.grid },
        horzLines: { color: dark ? chartColor.gridDeep : chartColor.grid },
      },
      handleScale: {
        axisPressedMouseMove: { time: true, price: !hasRps },
      },
      handleScroll: { pressedMouseMove: drawingTool === "none" },
    });
  }, [period, pricePrecision, viewportKey, dark, hasRps, drawingTool]);

  // Log prices only: oscillators can be negative and must retain their linear
  // scale. A comparison switches the main scale to percent from the first
  // visible bar (TradingView compare), so different price levels line up.
  const comparing = (compare?.length ?? 0) > 0;
  useEffect(() => {
    native.current?.candles.priceScale().applyOptions({
      mode: comparing ? 2 : view && logarithmic ? 1 : 0,
    });
  }, [
    period,
    pricePrecision,
    viewportKey,
    view === undefined,
    logarithmic,
    comparing,
  ]);

  const selectedId =
    selected && drawings?.some((d) => d.id === selected) ? selected : null;
  useEffect(() => {
    native.current?.setDrawings(drawings ?? [], selectedId);
  }, [period, pricePrecision, viewportKey, drawings, selectedId]);
  useEffect(() => {
    native.current?.setShared(sharedDrawings ?? [], null);
  }, [period, viewportKey, sharedDrawings]);

  // Content is replaced in place on the existing chart, in two independent
  // layers so an indicator or pane toggle never rewrites the price data:
  //   base: candles, structure/breakout lines, markers and the cost line;
  //   indicators: secondary panes and indicator lines.
  // The viewport is only reset when the data itself changes.
  useEffect(() => {
    const n = native.current;
    if (!n) return;
    const { chart, candles } = n;
    if (n.bars !== bars || n.asOf !== breakoutIndex) {
      const saved = viewport.current;
      const restored = viewportKey
        ? restoreChartRange(viewportKey, bars)
        : null;
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
  }, [
    period,
    pricePrecision,
    viewportKey,
    bars,
    czsc,
    showCzsc,
    breakout,
    showBreakout,
    breakoutIndex,
    cost,
    compare,
  ]);

  // Secondary panes are diffed by identity: each subchart owns one anchor
  // series, and its pane is wherever that series lives. Unselected panes are
  // removed, new ones appended, and panes reordered only when the selection
  // order changed, so toggling one pane leaves the others untouched.
  useEffect(() => {
    const n = native.current;
    if (!n) return;
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
      chart
        .panes()
        [index + 1]?.setStretchFactor(subchart === "rps" ? 1.2 : 1.4);
    });
  }, [
    period,
    pricePrecision,
    viewportKey,
    visibleSubcharts,
    rpsOptions.threshold,
  ]);

  // Indicator lines and the pane anchors' data. Lines are cheap to replace;
  // panes are not touched here.
  useEffect(() => {
    const n = native.current;
    if (!n) return;
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
  }, [
    period,
    pricePrecision,
    viewportKey,
    bars,
    values,
    names,
    visibleSubcharts,
    rps,
    rpsOptions,
  ]);

  // TDX keys: ←/→ step a bar cursor (scrolling when it leaves the view),
  // ↑/↓ zoom, PageUp/PageDown page, Home/End jump, Esc leaves cursor mode.
  const chartKey = (key: string) => {
    if (selectedId && view && onViewChange) {
      if (key === "Delete" || key === "Backspace") {
        onViewChange({
          ...view,
          drawings: view.drawings.filter((d) => d.id !== selectedId),
        });
        setSelected(null);
        return true;
      }
      if (key === "Escape") {
        setSelected(null);
        return true;
      }
    }
    const n = native.current;
    const range = n?.chart.timeScale().getVisibleLogicalRange();
    if (!n || !range) return false;
    const scale = n.chart.timeScale();
    if (key === "ArrowLeft" || key === "ArrowRight") {
      const last = n.bars.length - 1;
      if (last < n.start) return false;
      const move = keyboardCursor(
        range,
        key === "ArrowLeft" ? -1 : 1,
        n.cursor,
        n.start,
        last,
      );
      n.cursor = move.index;
      if (move.range) scale.setVisibleLogicalRange(move.range);
      const bar = n.bars[move.index]!;
      n.chart.setCrosshairPosition(
        bar.close,
        chartTime(bar.date, period),
        n.candles,
      );
      setHover({ bars: n.bars, index: move.index });
      return true;
    }
    if (key === "Escape") {
      if (n.cursor === null) return false;
      n.cursor = null;
      n.chart.clearCrosshairPosition();
      setHover(null);
      return true;
    }
    const next =
      keyboardRange(range, key) ??
      keyboardPage(range, key, n.bars.length - n.start);
    if (!next) return false;
    scale.setVisibleLogicalRange(next);
    return true;
  };
  const chartKeyRef = useRef(chartKey);
  chartKeyRef.current = chartKey;
  useEffect(() => {
    if (!hotkeys) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        // Keys inside the chart are handled by its own onKeyDown.
        (target?.nodeType !== undefined && ref.current?.contains(target)) ||
        target?.closest?.(
          "input, textarea, select, [contenteditable=true], [role=dialog], [role=listbox], [role=combobox], [role=menu]",
        )
      )
        return;
      if (chartKeyRef.current(event.key)) event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hotkeys]);

  return (
    <div
      data-testid="market-chart"
      data-period={period}
      data-dark={view?.dark ?? false}
      style={{
        background: view?.dark ? chartColor.groundDeep : undefined,
        color: view?.dark ? chartColor.textStrong : undefined,
        padding: 8,
      }}
    >
      <div
        className="flex items-center gap-3 overflow-x-auto py-2 text-sm whitespace-nowrap"
        data-testid="chart-secondary-controls"
      >
        <div
          role="group"
          aria-label="主图指标"
          className="flex shrink-0 items-center gap-1"
        >
          <span className="text-xs opacity-70">主图</span>
          {(
            Object.entries(mainIndicatorLabels) as [MainIndicator, string][]
          ).map(([value, label]) => (
            <IndicatorChip
              key={value}
              label={label}
              title={indicatorCatalog[value].title}
              active={selectedMainIndicators.includes(value)}
              editing={editing === value}
              onToggle={() =>
                setMainIndicators(
                  selectedMainIndicators.includes(value)
                    ? selectedMainIndicators.filter((item) => item !== value)
                    : [...selectedMainIndicators, value],
                )
              }
              onEdit={() => setEditing(editing === value ? null : value)}
            />
          ))}
        </div>
        <div
          role="group"
          aria-label="副图指标"
          className="flex shrink-0 items-center gap-1"
        >
          <span className="text-xs opacity-70">副图</span>
          {subchartOptions.map((value) => {
            const disabled =
              value === "rps" &&
              period !== "day" &&
              !selectedSubcharts.includes(value);
            const key =
              value in indicatorCatalog
                ? (value as keyof IndicatorParameters)
                : null;
            return (
              <IndicatorChip
                key={value}
                label={subchartLabels[value]}
                title={
                  key
                    ? indicatorCatalog[key].title
                    : value === "volume"
                      ? "成交量"
                      : value === "obv"
                        ? "能量潮"
                        : "相对强度排名（仅日线）"
                }
                active={selectedSubcharts.includes(value)}
                disabled={disabled}
                editing={key != null && editing === key}
                onToggle={() =>
                  setSubcharts(
                    selectedSubcharts.includes(value)
                      ? selectedSubcharts.filter((item) => item !== value)
                      : [...selectedSubcharts, value],
                  )
                }
                onEdit={
                  key
                    ? () => setEditing(editing === key ? null : key)
                    : undefined
                }
              />
            );
          })}
        </div>
        {annotations && (
          <>
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
          </>
        )}
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
      {editing && (
        <IndicatorParameterPanel
          key={editing}
          indicator={editing}
          parameters={parameters}
          onChange={setParameters}
          onClose={() => setEditing(null)}
        />
      )}
      <div className="flex flex-wrap gap-3 text-sm">
        {annotations &&
          (showBreakout || breakoutMessage?.startsWith("双突破计算失败")) && (
            // Only loading/failure is shown; the summary is for screen readers.
            <span
              data-testid="breakout-status"
              className={breakoutMessage ? undefined : "sr-only"}
            >
              {breakoutMessage ??
                (breakout
                  ? (() => {
                      const p = breakout.points.find(
                        (p) => p.index === breakoutIndex,
                      );
                      return p
                        ? `${wallClockLabel(p.date)} · 多 ${p.long.status} ${p.long.quality} · 空 ${p.short.status} ${p.short.quality} · 紫色虚线/箭头 · 关键位按来源标注`
                        : "无日线数据";
                    })()
                  : "")}
            </span>
          )}
        {annotations &&
          (showCzsc || czscMessage?.startsWith("缠论计算失败")) && (
            <span
              data-testid="czsc-status"
              className={czscMessage ? undefined : "sr-only"}
            >
              {czscMessage ??
                (czsc?.status === "no-structure"
                  ? "无结构"
                  : czsc
                    ? `笔 ${Math.max(0, (czsc.families.find((f) => f.config === 0)?.points.length ?? 0) - 1)} · 线段端点 ${czsc.families.find((f) => f.config === 1100)?.points.length ?? 0} · 中枢 ${czsc.families.reduce((n, f) => n + f.centers.length, 0)} · 金色笔 / 紫色线段 · 阴影背驰`
                    : "")}
            </span>
          )}
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
            {compare?.map((item, i) => {
              const bar = item.bars.find((b) => b.date === legend.bar.date);
              return (
                <span
                  key={item.symbol}
                  style={{ color: compareColors[i % compareColors.length] }}
                >
                  {item.label}{" "}
                  {bar ? formatValue(bar.close, pricePrecision) : "—"}
                </span>
              );
            })}
            {legendGroups.map(({ key, names: group }) => {
              const items = legend.indicators.filter(({ name }) =>
                group.includes(name),
              );
              if (!items.length) return null;
              return (
                <span key={key} className="inline-flex gap-2">
                  {key === "obv" ? (
                    <span className="opacity-70">OBV</span>
                  ) : (
                    <Button
                      variant="plain"
                      type="button"
                      className="cursor-pointer opacity-70 hover:underline"
                      title="点击修改参数"
                      onClick={() => setEditing(editing === key ? null : key)}
                    >
                      {parameterSummary(key, parameters)}
                    </Button>
                  )}
                  {items.map(({ name, value }) => (
                    <span key={name} style={{ color: colors[name] }}>
                      {indicatorLabel(name, parameters)}{" "}
                      {formatValue(value, name === "OBV" ? 0 : 2)}
                    </span>
                  ))}
                </span>
              );
            })}
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
        aria-label="行情图：按住鼠标左键拖动；←→ 逐根移动光标，↑↓ 缩放，PageUp/PageDown 翻页，Home/End 到最早/最新，Esc 退出光标"
        onPointerDown={(event) => event.currentTarget.focus()}
        onKeyDown={(event) => {
          // Already taken (e.g. PageUp/PageDown stepping a browse list).
          if (event.defaultPrevented) return;
          if (chartKey(event.key)) event.preventDefault();
        }}
        className="price-chart"
        style={{
          // Fill the window below the toolbar instead of a fixed height, so the
          // chart is fully visible on a laptop screen and grows on a large one.
          // 660px is the application chrome above and below the canvas; the
          // clamp keeps the main pane usable on short windows.
          height:
            height ??
            `clamp(${
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

function IndicatorChip({
  label,
  title,
  active,
  disabled,
  editing,
  onToggle,
  onEdit,
}: {
  label: string;
  title: string;
  active: boolean;
  disabled?: boolean;
  editing?: boolean;
  onToggle: () => void;
  onEdit?: () => void;
}) {
  return (
    <span
      className={`inline-flex items-center overflow-hidden rounded border text-xs ${
        active
          ? "border-primary bg-primary/15 text-primary"
          : "border-border opacity-80"
      } ${editing ? "ring-1 ring-primary" : ""}`}
    >
      <Button
        variant="plain"
        type="button"
        className="px-2 py-0.5 disabled:cursor-not-allowed disabled:opacity-40"
        aria-pressed={active}
        disabled={disabled}
        title={`${title}${disabled ? "（当前周期不可用）" : ""}`}
        onClick={onToggle}
        onDoubleClick={onEdit}
      >
        {label}
      </Button>
      {onEdit && (
        <Button
          variant="plain"
          type="button"
          className="border-l border-inherit px-1 py-0.5 hover:bg-primary/20"
          aria-label={`${label} 参数`}
          aria-expanded={editing}
          title={`${label} 参数`}
          onClick={onEdit}
        >
          ⚙
        </Button>
      )}
    </span>
  );
}

/** Inline parameter editor: valid values apply immediately, as in broker
 *  terminals; invalid drafts stay local until corrected. */
function IndicatorParameterPanel({
  indicator,
  parameters,
  onChange,
  onClose,
}: {
  indicator: keyof IndicatorParameters;
  parameters: IndicatorParameters;
  onChange: (value: IndicatorParameters) => void;
  onClose: () => void;
}) {
  const meta = indicatorCatalog[indicator];
  const [draft, setDraft] = useState<string[]>(
    parameters[indicator].map(String),
  );
  const [error, setError] = useState("");
  const apply = (values: string[]) => {
    setDraft(values);
    const parsed = indicatorParametersSchema.safeParse({
      ...parameters,
      [indicator]: values.map(Number),
    });
    if (values.some((v) => v.trim() === "") || !parsed.success) {
      setError(
        meta.fields
          .map(
            (f) => `${f.label} ${f.min}–${f.max}${f.step === 1 ? " 整数" : ""}`,
          )
          .join("，"),
      );
      return;
    }
    setError("");
    onChange(parsed.data);
  };
  return (
    <div
      role="dialog"
      aria-label={`${meta.label} 参数`}
      className="flex flex-wrap items-center gap-3 rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground"
      onKeyDown={(event) => {
        if (event.key === "Escape" || event.key === "Enter") onClose();
      }}
    >
      <strong>
        {meta.label} · {meta.title}
      </strong>
      {meta.fields.map((field, i) => (
        <label key={field.label} className="flex items-center gap-1">
          {field.label}
          <Input
            aria-label={`${meta.label} 参数 ${field.label}`}
            type="number"
            className="h-7 w-16"
            min={field.min}
            max={field.max}
            step={field.step}
            value={draft[i] ?? ""}
            autoFocus={i === 0}
            onChange={(e) =>
              apply(draft.map((v, j) => (j === i ? e.target.value : v)))
            }
          />
        </label>
      ))}
      <Button
        variant="plain"
        size="sm"
        onClick={() => apply(defaultParameters[indicator].map(String))}
      >
        恢复默认
      </Button>
      <Button variant="plain" size="sm" onClick={onClose}>
        完成
      </Button>
      <span role="status" className="text-destructive">
        {error}
      </span>
      <span className="opacity-60">
        修改即时生效；缠论与双突破标注仍按原策略参数计算
      </span>
    </div>
  );
}
