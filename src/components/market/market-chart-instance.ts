import {
  CandlestickSeries,
  CrosshairMode,
  createSeriesMarkers,
  type LogicalRange,
} from "lightweight-charts";
import { chartColor, createNocturneChart } from "~/lib/chart/chart-theme";
import {
  chineseChartLocalization,
  chineseTickMark,
} from "~/lib/chart/chart-localization";
import { attachDrawings } from "~/lib/chart/chart-drawings";
import { revealHistory } from "~/lib/chart/chart-data";
import { rememberChartRange } from "~/lib/chart/chart-viewport";
import { barInstant } from "~/lib/chart/crosshair-link";
import type {
  MarketChartState,
  ChartInstanceOptions,
} from "./market-chart-state";
import { attachDrawingInteractions } from "./market-chart-drawings";
import { attachChartStructure } from "./market-chart-structure";

type HorizontalRange = { from: number; to: number };

// The chart handles native scroll/zoom synchronously. Compare the range on
// either side of that input event so an asynchronous programmatic focus,
// resize, or linked-chart update cannot turn into a saved user viewport.
export function observeRangeGesture(
  target: EventTarget,
  type: "mousemove" | "touchmove" | "wheel",
  readRange: () => HorizontalRange | null,
  onChange: () => void,
) {
  let before: HorizontalRange | null = null;
  const capture = () => {
    before = readRange();
  };
  const finish = () => {
    const after = before && readRange();
    if (
      before &&
      after &&
      (Math.abs(after.from - before.from) > 1e-6 ||
        Math.abs(after.to - before.to) > 1e-6)
    )
      onChange();
    before = null;
  };
  target.addEventListener(type, capture, { capture: true, passive: true });
  target.addEventListener(type, finish, { passive: true });
  return () => {
    target.removeEventListener(type, capture, true);
    target.removeEventListener(type, finish);
  };
}

/** One native canvas and all resources whose lifetime belongs to it. */
export function createMarketChartInstance(
  element: HTMLDivElement,
  {
    period,
    pricePrecision,
    viewportKey,
    viewportPolicy = "persisted",
    live,
    viewport,
    linkRef,
    linking,
    setHover,
    setSelected,
    setHistoryStart,
  }: ChartInstanceOptions,
) {
  const chart = createNocturneChart(element, {
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
  const state: MarketChartState = {
    chart,
    candles,
    setDrawings,
    setShared,
    markers,
    viewportPolicy,
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
    temporaryRange: false,
    cursor: null,
  };
  const removeDrawingListeners = attachDrawingInteractions(
    state,
    element,
    {
      period,
      live,
      setSelected,
    },
    updatePreview,
  );
  attachChartStructure(state, period);
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
  const container = element;
  const remember = (range: LogicalRange | null) => {
    if (viewportPolicy === "ephemeral") return;
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
    if (!dragging) return;
    dragging = false;
    reveal(chart.timeScale().getVisibleLogicalRange());
  };
  const reveal = (range: LogicalRange | null) => {
    if (!range || updating || state.temporaryRange) return;
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
      if (state.temporaryRange || dragging || !current || current.from > 12)
        return;
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
  const rangeDuringReview = () =>
    state.temporaryRange && !updating && !linking.current
      ? chart.timeScale().getVisibleLogicalRange()
      : null;
  const dragRange = () => (dragging ? rangeDuringReview() : null);
  const allowRangeSave = () => {
    state.temporaryRange = false;
    reveal(chart.timeScale().getVisibleLogicalRange());
  };
  const removeGestures = [
    observeRangeGesture(window, "mousemove", dragRange, allowRangeSave),
    observeRangeGesture(window, "touchmove", dragRange, allowRangeSave),
    observeRangeGesture(container, "wheel", rangeDuringReview, allowRangeSave),
  ];
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);
  chart.timeScale().subscribeVisibleLogicalRangeChange(reveal);
  const dispose = () => {
    removeDrawingListeners();
    container.removeEventListener("pointerdown", beginDrag, true);
    for (const remove of removeGestures) remove();
    window.removeEventListener("pointerup", endDrag);
    window.removeEventListener("pointercancel", endDrag);
    cancelAnimationFrame(frame);
    if (viewportPolicy === "persisted" && !state.temporaryRange) {
      const range = chart.timeScale().getVisibleLogicalRange();
      remember(range);
      if (viewportKey)
        rememberChartRange(viewportKey, state.bars, state.start, range);
    }
    chart.remove();
  };

  return { state, dispose };
}
