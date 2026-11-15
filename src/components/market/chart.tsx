"use client";
import { usePlanLevels } from "./plan-levels";
import { formatNumber } from "~/lib/common/format-number";
import { MarketChartLegend } from "./market-chart-legend";
import { rpsPeriods } from "quant-rps";
import { createMarketChartInstance } from "./market-chart-instance";
import { updateMarketBase } from "./market-chart-base";
import {
  updateIndicatorPanes,
  updateIndicatorLines,
} from "./market-chart-indicators";
import { rpsColors } from "./market-chart-palette";
import type { MarketChartState, ChartCompare } from "./market-chart-state";
import { capabilityAllows } from "~/lib/common/capabilities";

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
import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";
import { PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { PanelPopover as Popover } from "../workbench/panel-popover";
import { rpsPeriodLabel } from "~/lib/screening/rps";
import { type RpsCurve } from "~/lib/chart/chart-data";
import { Checkbox } from "~/components/ui/checkbox";

import {
  chineseChartLocalization,
  chineseTickMark,
} from "~/lib/chart/chart-localization";
import {
  defaultChartView,
  defaultParameters,
  indicatorCatalog,
  indicatorParametersSchema,
  type IndicatorParameters,
  keyboardRange,
  keyboardPage,
  keyboardCursor,
  normalizeSubcharts,
  type MainIndicator,
  type Subchart,
  type ChartPeriod as Period,
  type ChartView,
  type Drawing,
} from "~/lib/chart/chart-view";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  type Time,
  ColorType,
  type LogicalRange,
} from "lightweight-charts";
import type { Bar } from "~/lib/domain";
import type { ChartAdjustment } from "~/lib/chart/chart-adjustment";
import type { CzscResult } from "trading-strategies/research/chan/czsc";
import type { BreakoutResult } from "trading-strategies/research/breakout/breakout";
import { linkedIndex, type CrosshairLink } from "~/lib/chart/crosshair-link";
import { api } from "~/trpc/react";
import {
  chartIndicators,
  chartLegend,
  chartTime,
  wallClockLabel,
  enabledIndicators,
  initialHistoryStart,
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
  const [annotationVisibility, setAnnotationVisibility] =
    useState<ChartAnnotationVisibility>({ breakout: true, czsc: true });
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
    enabled: visible && annotations && annotationVisibility.czsc,
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
      enabled: annotationsReady && annotations && annotationVisibility.czsc,
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
      enabled:
        annotationsReady &&
        annotations &&
        annotationVisibility.breakout &&
        capabilityAllows("breakout", "compute"),
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
      annotationVisibility={annotationVisibility}
      onAnnotationVisibilityChange={setAnnotationVisibility}
      czsc={annotations && annotationVisibility.czsc ? czscView : undefined}
      breakout={
        annotations && annotationVisibility.breakout ? breakout.data : undefined
      }
      breakoutMessage={
        !annotationsReady || !annotations || !annotationVisibility.breakout
          ? undefined
          : breakout.error
            ? `双突破计算失败：${breakout.error.message}`
            : breakout.isPending
              ? "双突破标注后台加载中，K 线可正常浏览"
              : undefined
      }
      czscMessage={
        !annotationsReady || !annotations || !annotationVisibility.czsc
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

type ChartAnnotationVisibility = { breakout: boolean; czsc: boolean };
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
  annotationVisibility,
  onAnnotationVisibilityChange,
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
  annotationVisibility?: ChartAnnotationVisibility;
  onAnnotationVisibilityChange?: (value: ChartAnnotationVisibility) => void;
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
  const [localAnnotations, setLocalAnnotations] =
    useState<ChartAnnotationVisibility>({ breakout: true, czsc: true });
  const shownAnnotations = annotationVisibility ?? localAnnotations;
  const { czsc: showCzsc, breakout: showBreakout } = shownAnnotations;
  const changeAnnotation = (patch: Partial<ChartAnnotationVisibility>) => {
    const next = { ...shownAnnotations, ...patch };
    if (onAnnotationVisibilityChange) onAnnotationVisibilityChange(next);
    else setLocalAnnotations(next);
  };
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
  const [indicatorSettingsOpen, setIndicatorSettingsOpen] = useState(false);
  const parameterReturnTarget = useRef<HTMLElement | null>(null);
  const editParameters = (key: keyof IndicatorParameters) => {
    parameterReturnTarget.current = document.activeElement as HTMLElement;
    setEditing(editing === key ? null : key);
  };
  const closeParameters = () => {
    setEditing(null);
    parameterReturnTarget.current?.focus();
  };
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
  const dark = false;
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
  const native = useRef<MarketChartState | null>(null);
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
    const instance = createMarketChartInstance(ref.current, {
      period,
      pricePrecision,
      viewportKey,
      live,
      viewport,
      linkRef,
      linking,
      setHover,
      setSelected,
      setHistoryStart,
    });
    native.current = instance.state;
    return () => {
      instance.dispose();
      native.current = null;
    };
  }, [period, pricePrecision, viewportKey]);

  const planLevels = usePlanLevels();
  useEffect(() => {
    const n = native.current;
    if (
      !n ||
      !planLevels ||
      adjustment !== "none" ||
      viewportKey?.split(":")[0]?.replace(/^cx/, "") !==
        planLevels.symbol.replace(/^cx/, "")
    )
      return;
    const lines = (
      [
        ["入场参考", planLevels.entry, chartColor.accent],
        ["止损", planLevels.stop, chartColor.down],
        ["目标", planLevels.target, chartColor.up],
      ] as const
    ).flatMap(([title, price, color]) =>
      price !== null && price > 0
        ? [
            n.candles.createPriceLine({
              title,
              price,
              color,
              lineWidth: 2,
              lineStyle: 2,
              axisLabelVisible: true,
            }),
          ]
        : [],
    );
    return () => {
      if (native.current === n)
        for (const line of lines) n.candles.removePriceLine(line);
    };
  }, [planLevels, adjustment, period, pricePrecision, viewportKey]);

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
  }, [period, pricePrecision, viewportKey, sharedDrawings]);

  // Content is replaced in place on the existing chart, in two independent
  // layers so an indicator or pane toggle never rewrites the price data:
  //   base: candles, structure/breakout lines, markers and the cost line;
  //   indicators: secondary panes and indicator lines.
  // The viewport is only reset when the data itself changes.
  useEffect(() => {
    const n = native.current;
    if (!n) return;
    updateMarketBase(n, {
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
    });
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
    updateIndicatorPanes(n, { visibleSubcharts, rpsOptions });
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
    updateIndicatorLines(n, { bars, period, values, names, rps, rpsOptions });
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
      data-dark={false}
      style={{
        background: chartColor.ground,
        color: chartColor.text,
        padding: "0 8px 8px",
      }}
    >
      <div
        className="flex flex-wrap items-center gap-x-3 gap-y-2 py-1 text-sm"
        data-testid="chart-secondary-controls"
      >
        <Popover
          open={indicatorSettingsOpen}
          onOpenChange={(open) => {
            setIndicatorSettingsOpen(open);
            if (!open) setEditing(null);
          }}
        >
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm">
              指标设置（
              {selectedMainIndicators.length + selectedSubcharts.length}）
            </Button>
          </PopoverTrigger>
          <PopoverContent
            aria-label="指标设置"
            className="w-[32rem] space-y-3"
            onEscapeKeyDown={(event) => {
              if (!editing) return;
              event.preventDefault();
              closeParameters();
            }}
          >
            <div
              role="group"
              aria-label="主图指标"
              className="flex flex-wrap items-center gap-1"
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
                        ? selectedMainIndicators.filter(
                            (item) => item !== value,
                          )
                        : [...selectedMainIndicators, value],
                    )
                  }
                  onEdit={() => editParameters(value)}
                />
              ))}
            </div>
            <div
              role="group"
              aria-label="副图指标"
              className="flex flex-wrap items-center gap-1"
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
                    onEdit={key ? () => editParameters(key) : undefined}
                  />
                );
              })}
            </div>
            {editing && (
              <IndicatorParameterPanel
                key={editing}
                indicator={editing}
                parameters={parameters}
                onChange={setParameters}
                onClose={closeParameters}
              />
            )}
          </PopoverContent>
        </Popover>
        {annotations && (
          <>
            <label>
              <Checkbox
                checked={showBreakout}
                onCheckedChange={(checked) =>
                  changeAnnotation({ breakout: checked === true })
                }
              />{" "}
              双突破
            </label>
            <label>
              <Checkbox
                checked={showCzsc}
                onCheckedChange={(checked) =>
                  changeAnnotation({ czsc: checked === true })
                }
              />{" "}
              缠论结构
            </label>
          </>
        )}
        {selectedSubcharts.includes("rps") && period === "day" && (
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm">
                RPS 设置
              </Button>
            </PopoverTrigger>
            <PopoverContent aria-label="RPS 设置" className="space-y-3">
              <div
                className="flex flex-wrap items-center gap-3 text-xs"
                data-testid="rps-controls"
              >
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
                    {rpsPeriodLabel(window)}
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
              </div>
            </PopoverContent>
          </Popover>
        )}
      </div>
      {selectedSubcharts.includes("rps") && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span role="status">
            {period !== "day"
              ? "RPS仅支持日线，当前周期不可用"
              : (rpsMessage ??
                (rps?.some((row) => row.values.some((value) => value != null))
                  ? ""
                  : "暂无已落库RPS数据"))}
          </span>
          {period === "day" &&
            rpsMessage?.startsWith("RPS读取失败") &&
            onRpsRetry && (
              <Button variant="plain" size="sm" onClick={onRpsRetry}>
                重试RPS
              </Button>
            )}
        </div>
      )}
      <div className="flex flex-wrap gap-3 text-sm">
        {annotations && showBreakout && (
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
        {annotations && showCzsc && (
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
      <MarketChartLegend
        legend={legend}
        period={period}
        pricePrecision={pricePrecision}
        showVolume={selectedSubcharts.includes("volume")}
        volumeUnit={volumeUnit}
        compare={compare}
        parameters={parameters}
        onEdit={(key) => {
          parameterReturnTarget.current = document.activeElement as HTMLElement;
          setEditing(key);
          setIndicatorSettingsOpen(true);
        }}
        showBreakout={showBreakout}
        breakout={breakout}
        bars={bars}
        breakoutIndex={breakoutIndex}
      />
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
          // Reserve most of the viewport for the chart, with a readable minimum
          // for each selected pane. Expanded settings do not change this budget.
          height:
            height ??
            `clamp(${
              visibleSubcharts.length === 0
                ? 320
                : 320 + visibleSubcharts.length * 120
            }px, 60dvh, 1200px)`,
          cursor: drawingTool === "none" ? "grab" : "crosshair",
        }}
      />
      <div className="flex flex-wrap justify-between gap-2 text-xs text-slate-500">
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
        if (event.key === "Escape" || event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
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
