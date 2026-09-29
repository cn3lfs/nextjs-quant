"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  type IPriceLine,
  type ISeriesApi,
} from "lightweight-charts";
import { api } from "~/trpc/react";
import { chartColor, createNocturneChart } from "~/lib/chart/chart-theme";
import {
  chineseChartLocalization,
  chineseTickMark,
} from "~/lib/chart/chart-localization";
import {
  intradayRange,
  intradayRows,
  liveIntradayDay,
  type IntradayDay,
  type IntradayRow,
} from "~/lib/chart/intraday";
import { useQuoteRefreshInterval } from "./use-quote-session";
import { Button } from "../ui/button";
import { isTypingTarget } from "./chart-hotkeys";

const dayChoices = [1, 2, 3, 4, 5] as const;
const beijingDate = (now: number) =>
  new Date(now + 8 * 3600000).toISOString().slice(0, 10);

/**
 * 分时图（TDX F5）: price and volume-weighted average lines, previous-close
 * baseline, symmetric price/percent axes and minute volume, over 1–5 days.
 * Today's minutes refresh with the trading session; earlier days come from
 * TDX history minutes and the daily bars' previous closes.
 */
export function IntradayChart({
  symbol,
  snapshotId,
  pricePrecision = 2,
  dark = false,
}: {
  symbol: string;
  snapshotId: string;
  pricePrecision?: number;
  dark?: boolean;
}) {
  const [days, setDays] = useState<number>(1);
  const interval = useQuoteRefreshInterval();
  const today = api.tdxMinutes.useQuery(
    { symbol },
    {
      retry: false,
      refetchOnWindowFocus: false,
      refetchInterval: interval,
    },
  );
  const quote = api.tdxQuotes.useQuery([symbol], {
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: interval,
  });
  const daily = api.chartBars.useQuery(
    { snapshotId, period: "day", limit: 100, adjustment: "none" },
    { retry: false, refetchOnWindowFocus: false },
  );
  const bars = daily.data?.bars ?? [];
  const quotedPreClose =
    quote.data?.[0]?.preClose && quote.data[0].preClose > 0
      ? quote.data[0].preClose
      : null;
  // The live minutes carry no date; derive their trading day from the
  // previous close (see liveIntradayDay), never from the session clock.
  const live = liveIntradayDay(bars, quotedPreClose, beijingDate(Date.now()));
  const liveDate = live.date;
  const historyDates =
    days > 1
      ? bars
          .slice(0, live.previous + 1)
          .map((bar) => bar.date.slice(0, 10))
          .slice(-(days - 1))
      : [];
  const past = api.useQueries((t) =>
    historyDates.map((date) =>
      t.tdxMinutes(
        { symbol, date: Number(date.replaceAll("-", "")) },
        { retry: false, refetchOnWindowFocus: false, staleTime: Infinity },
      ),
    ),
  );
  const closeBefore = (date: string) =>
    [...bars].reverse().find((bar) => bar.date.slice(0, 10) < date)?.close;
  const livePreClose = quotedPreClose ?? bars[live.previous]?.close;
  const dayData: IntradayDay[] = useMemo(() => {
    const out: IntradayDay[] = [];
    historyDates.forEach((date, i) => {
      const points = past[i]?.data;
      const pre = closeBefore(date);
      if (points?.length && pre) out.push({ date, preClose: pre, points });
    });
    if (today.data?.length && livePreClose)
      out.push({
        date: liveDate,
        preClose: livePreClose,
        points: today.data,
      });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    today.data,
    livePreClose,
    liveDate,
    historyDates.join(),
    past.map((q) => q.dataUpdatedAt).join(),
    bars,
  ]);
  const { rows, whitespace } = useMemo(() => intradayRows(dayData), [dayData]);
  const preClose = dayData.at(-1)?.preClose ?? null;
  const [hover, setHover] = useState<IntradayRow | null>(null);
  const shown = hover ?? rows.at(-1) ?? null;

  const ref = useRef<HTMLDivElement>(null);
  const parts = useRef<{
    chart: ReturnType<typeof createNocturneChart>;
    price: ISeriesApi<"Line">;
    average: ISeriesApi<"Line">;
    percent: ISeriesApi<"Line">;
    volume: ISeriesApi<"Histogram">;
    baseline: IPriceLine | null;
    byTime: Map<number, IntradayRow>;
  } | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const chart = createNocturneChart(ref.current, {
      localization: chineseChartLocalization,
      autoSize: true,
      layout: { attributionLogo: true },
      leftPriceScale: { visible: true, borderColor: chartColor.muted },
      rightPriceScale: { visible: true, borderColor: chartColor.muted },
      timeScale: {
        tickMarkFormatter: chineseTickMark,
        timeVisible: true,
        secondsVisible: false,
        borderColor: chartColor.border,
        fixLeftEdge: true,
        fixRightEdge: true,
      },
      handleScroll: false,
      handleScale: false,
      crosshair: { mode: CrosshairMode.Magnet },
    });
    const price = chart.addSeries(LineSeries, {
      color: chartColor.textStrong,
      lineWidth: 2,
      priceFormat: {
        type: "price",
        precision: pricePrecision,
        minMove: 10 ** -pricePrecision,
      },
      priceLineVisible: false,
      title: "价格",
    });
    const average = chart.addSeries(LineSeries, {
      color: chartColor.accent,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      title: "均价",
    });
    // The percent axis is a hidden series on the left scale with the same
    // symmetric range, so both axes stay aligned around the previous close.
    const percent = chart.addSeries(LineSeries, {
      priceScaleId: "left",
      lineVisible: false,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: false,
      priceFormat: {
        type: "custom",
        formatter: (value: number) => `${value.toFixed(2)}%`,
        minMove: 0.01,
      },
    });
    const volume = chart.addSeries(
      HistogramSeries,
      {
        priceFormat: { type: "volume" },
        priceLineVisible: false,
        title: "成交量",
      },
      1,
    );
    chart.panes()[0]?.setStretchFactor(3);
    chart.panes()[1]?.setStretchFactor(1);
    const state: NonNullable<typeof parts.current> = {
      chart,
      price,
      average,
      percent,
      volume,
      baseline: null,
      byTime: new Map(),
    };
    parts.current = state;
    chart.subscribeCrosshairMove((event) => {
      setHover(
        event.time === undefined
          ? null
          : (state.byTime.get(event.time as number) ?? null),
      );
    });
    return () => {
      parts.current = null;
      chart.remove();
    };
  }, [pricePrecision]);

  useEffect(() => {
    parts.current?.chart.applyOptions({
      layout: {
        background: {
          type: ColorType.Solid,
          color: dark ? chartColor.groundDeep : chartColor.ground,
        },
        textColor: dark ? chartColor.textStrong : chartColor.text,
      },
    });
  }, [dark]);

  useEffect(() => {
    const p = parts.current;
    if (!p) return;
    p.byTime = new Map(rows.map((row) => [row.time as number, row]));
    if (!rows.length || preClose === null) {
      for (const series of [p.price, p.average, p.percent, p.volume])
        series.setData([]);
      return;
    }
    const range = intradayRange(rows, preClose);
    const scale = () => ({
      priceRange: { minValue: range.minValue, maxValue: range.maxValue },
    });
    p.price.applyOptions({ autoscaleInfoProvider: scale });
    p.average.applyOptions({ autoscaleInfoProvider: scale });
    p.percent.applyOptions({
      autoscaleInfoProvider: () => ({
        priceRange: { minValue: -range.percent, maxValue: range.percent },
      }),
    });
    const pad = whitespace.map((row) => ({ time: row.time }));
    p.price.setData([
      ...rows.map((row) => ({ time: row.time, value: row.price })),
      ...pad,
    ]);
    p.average.setData([
      ...rows.map((row) => ({ time: row.time, value: row.average })),
      ...pad,
    ]);
    p.percent.setData([
      ...rows.map((row) => ({
        time: row.time,
        value: (row.price / preClose - 1) * 100,
      })),
      ...pad,
    ]);
    p.volume.setData([
      ...rows.map((row) => ({
        time: row.time,
        value: row.volume,
        color:
          row.direction > 0
            ? chartColor.up
            : row.direction < 0
              ? chartColor.down
              : chartColor.muted,
      })),
      ...pad,
    ]);
    if (p.baseline) p.price.removePriceLine(p.baseline);
    p.baseline = p.price.createPriceLine({
      price: preClose,
      color: chartColor.muted,
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: "昨收",
    });
    p.chart.timeScale().fitContent();
  }, [rows, whitespace, preClose]);

  // TDX Alt+1…5: number of days shown.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const n = Number(event.key);
      if (
        !event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        !dayChoices.includes(n as (typeof dayChoices)[number]) ||
        isTypingTarget(event.target)
      )
        return;
      event.preventDefault();
      setDays(n);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const error = today.error ?? quote.error ?? daily.error;
  const change =
    shown && preClose ? (shown.price / shown.preClose - 1) * 100 : null;
  const tone = (value: number | null) =>
    value === null || value === 0
      ? undefined
      : value > 0
        ? chartColor.up
        : chartColor.down;
  return (
    <div data-testid="intraday-chart" className="p-2">
      <div className="flex flex-wrap items-center gap-3 py-1 text-xs">
        <span role="group" aria-label="分时天数" className="flex gap-1">
          {dayChoices.map((n) => (
            <Button
              key={n}
              size="sm"
              variant={days === n ? "outline" : "ghost"}
              aria-pressed={days === n}
              title={`Alt+${n}`}
              onClick={() => setDays(n)}
            >
              {n === 1 ? "当日" : `${n}日`}
            </Button>
          ))}
        </span>
        <span
          data-testid="intraday-legend"
          className="flex flex-wrap gap-3 tabular-nums"
        >
          {shown ? (
            <>
              <span
                title={
                  shown.date === liveDate && !live.verified
                    ? "日线尚未包含该交易日，日期按今天标注、未经核验"
                    : undefined
                }
              >
                {shown.date}
                {shown.date === liveDate && !live.verified ? "?" : ""}{" "}
                {shown.clock}
              </span>
              <span style={{ color: tone(change) }}>
                价 {shown.price.toFixed(pricePrecision)}
              </span>
              <span style={{ color: tone(change) }}>
                {change === null
                  ? "—"
                  : `${change > 0 ? "+" : ""}${change.toFixed(2)}%`}
              </span>
              <span style={{ color: chartColor.accent }}>
                均 {shown.average.toFixed(pricePrecision)}
              </span>
              <span>量 {shown.volume.toLocaleString("zh-CN")}</span>
            </>
          ) : (
            <span>
              {today.isLoading || daily.isLoading
                ? "正在读取分时…"
                : "暂无分时数据"}
            </span>
          )}
        </span>
        <span className="text-nc-text-4">
          均价 = 累计(价×量)/累计量 · 昨收为中轴 · F5 返回 K 线
        </span>
      </div>
      {error && (
        <p role="alert" className="!my-0 text-xs">
          分时读取失败：{error.message}{" "}
          <Button variant="plain" onClick={() => void today.refetch()}>
            重试
          </Button>
        </p>
      )}
      <div
        ref={ref}
        className="price-chart"
        role="img"
        aria-label="分时图：价格线、均价线与成交量"
        style={{ height: "clamp(420px, calc(100dvh - 560px), 1000px)" }}
      />
    </div>
  );
}
