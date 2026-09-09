"use client";
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
import type { Bar, Period } from "~/lib/domain";
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
const subcharts = {
  none: "隐藏副图",
  volume: "成交量",
  macd: "MACD",
  kdj: "KDJ",
  rsi: "RSI",
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

function CzscMarketChart({
  bars,
  period,
  snapshotId,
}: {
  bars: Bar[];
  period: Period;
  snapshotId: string;
}) {
  const result = api.czsc.useQuery(
    { snapshotId },
    { staleTime: Infinity, retry: false },
  );
  const breakout = api.breakout.useQuery(
    { snapshotId },
    { enabled: period === "day", staleTime: Infinity, retry: false },
  );
  return (
    <MarketChart
      bars={bars}
      period={period}
      czsc={result.data}
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
        result.error
          ? `缠论计算失败：${result.error.message}`
          : result.isPending
            ? "缠论计算中…"
            : undefined
      }
    />
  );
}

function MarketChart({
  bars,
  period,
  czsc,
  czscMessage,
  breakout,
  breakoutMessage,
}: {
  bars: Bar[];
  period: Period;
  czsc?: CzscResult;
  czscMessage?: string;
  breakout?: BreakoutResult;
  breakoutMessage?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const viewport = useRef<{
    bars: Bar[];
    period: Period;
    start: number;
    asOf: number;
    range: LogicalRange | null;
  } | null>(null);
  const [showBoll, setShowBoll] = useState(false);
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
  const [subchart, setSubchart] = useState<Subchart>("volume");
  const [hover, setHover] = useState<{ bars: Bar[]; index: number } | null>(
    null,
  );
  const [historyStart, setHistoryStart] = useState(
    initialHistoryStart(bars.length),
  );
  const values = useMemo(() => chartIndicators(bars), [bars, period]);
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
        background: { type: ColorType.Solid, color: "#ffffff" },
        textColor: "#52677c",
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: "#f0f3f7" },
        horzLines: { color: "#f0f3f7" },
      },
      rightPriceScale: { borderColor: "#e5ebf2" },
      timeScale: {
        timeVisible: period === "5m",
        secondsVisible: false,
        borderColor: "#e5ebf2",
      },
      crosshair: { mode: CrosshairMode.Normal },
    });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: "#cf5562",
      downColor: "#28977f",
      borderVisible: false,
      wickUpColor: "#cf5562",
      wickDownColor: "#28977f",
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
    // A whitespace-only anchor keeps an all-null subchart present during warmup.
    const anchor =
      subchart === "none"
        ? null
        : chart.addSeries(
            LineSeries,
            { lastValueVisible: false, priceLineVisible: false },
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
    let lines: ISeriesApi<"Line">[] = [];
    const render = () => {
      const visible = bars.slice(start);
      candles.setData(
        visible.map((bar) => ({ ...bar, time: chartTime(bar.date, period) })),
      );
      anchor?.setData(
        visible.map((bar) => ({ time: chartTime(bar.date, period) })),
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
      chart
        .timeScale()
        .setVisibleLogicalRange(
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
  ]);

  return (
    <div data-testid="market-chart" data-period={period}>
      <div className="flex flex-wrap items-center gap-3 py-2 text-sm">
        <label>
          <input
            type="checkbox"
            checked={showBreakout}
            onChange={(e) => setShowBreakout(e.target.checked)}
          />{" "}
          双突破
        </label>
        {breakout && (
          <label>
            双突破观察日{" "}
            <select
              aria-label="双突破观察日"
              value={breakoutDate}
              onChange={(e) => setBreakoutDate(e.target.value)}
            >
              <option value="">最新</option>
              {breakout.points.map((p) => (
                <option key={p.date} value={p.date}>
                  {p.date}
                  {p.long.status === "是"
                    ? " ↑"
                    : p.short.status === "是"
                      ? " ↓"
                      : ""}
                </option>
              ))}
            </select>
          </label>
        )}
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
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={showBoll}
            onChange={(e) => setShowBoll(e.target.checked)}
          />
          BOLL
        </label>
        <label>
          副图{" "}
          <select
            aria-label="副图"
            value={subchart}
            onChange={(e) => setSubchart(e.target.value as Subchart)}
          >
            {Object.entries(subcharts).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={showCzsc}
            onChange={(e) => setShowCzsc(e.target.checked)}
          />{" "}
          缠论结构
        </label>
        <span data-testid="czsc-status">
          {czscMessage ??
            (czsc?.status === "no-structure"
              ? "无结构"
              : czsc
                ? `笔 ${Math.max(0, (czsc.families[0]?.points.length ?? 0) - 1)} · 线段端点 ${czsc.families[1]?.points.length ?? 0} · 中枢 ${czsc.families.reduce((n, f) => n + f.centers.length, 0)} · 金色笔 / 紫色线段 · 阴影背驰`
                : "")}
        </span>
        <span>
          {period === "day" ? "日线" : "5分钟"} · 不复权 · {subcharts[subchart]}
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
                {name} {formatValue(value)}
              </span>
            ))}
          </>
        ) : (
          <span>暂无行情</span>
        )}
      </div>
      <div
        ref={ref}
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
