import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type { Bar, Period } from "../src/lib/domain";
import { macd, ma } from "../src/lib/indicators";

// A hook/imperative-chart harness tests the component's actual event wiring in
// Node; the milestone Playwright run separately verifies real canvas rendering.
const h = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  effects: [] as (() => void)[],
  charts: [] as FakeChart[],
  frames: [] as FrameRequestCallback[],
}));
type Range = { from: number; to: number };
type Point = { time: string | number; value?: number };
type FakeSeries = {
  kind: string;
  pane: number;
  data: Point[];
  options: Record<string, unknown>;
  setData: (data: Point[]) => void;
  attachPrimitive: () => void;
  priceScale: () => {
    applyOptions: (options: Record<string, unknown>) => void;
  };
  createPriceLine: (options: Record<string, unknown>) => void;
};
type FakePane = {
  setStretchFactor: () => void;
  scale: Record<string, unknown>;
  priceScale: () => {
    applyOptions: (options: Record<string, unknown>) => void;
  };
};
type FakeChart = {
  series: FakeSeries[];
  options: Record<string, unknown>;
  range: Range | null;
  removed: boolean;
  crosshair?: (event: { time?: string | number }) => void;
  rangeChanged?: (range: Range) => void;
  timeScale: () => {
    getVisibleLogicalRange: () => Range | null;
    setVisibleLogicalRange: (range: Range) => void;
    subscribeVisibleLogicalRangeChange: (
      callback: (range: Range) => void,
    ) => void;
  };
  addSeries: (
    kind: string,
    options: Record<string, unknown>,
    pane?: number,
  ) => FakeSeries;
  removeSeries: (series: FakeSeries) => void;
  panes: () => FakePane[];
  subscribeCrosshairMove: (
    callback: (event: { time?: string | number }) => void,
  ) => void;
  remove: () => void;
};
vi.mock("react", async (importOriginal) => {
  const original = await importOriginal<typeof import("react")>();
  const same = (a: unknown[], b: unknown[]) =>
    a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  return {
    ...original,
    useRef: (value: unknown) => {
      const i = h.cursor++;
      h.slots[i] ??= { current: i === 0 ? new EventTarget() : value };
      return h.slots[i];
    },
    useState: (value: unknown) => {
      const i = h.cursor++;
      if (!(i in h.slots)) h.slots[i] = value;
      return [
        h.slots[i],
        (next: unknown) => {
          h.slots[i] = next;
        },
      ];
    },
    useMemo: (fn: () => unknown, deps: unknown[]) => {
      const i = h.cursor++,
        previous = h.slots[i] as
          { deps: unknown[]; value: unknown } | undefined;
      if (!previous || !same(previous.deps, deps))
        h.slots[i] = { deps, value: fn() };
      return (h.slots[i] as { value: unknown }).value;
    },
    useEffect: (fn: () => () => void, deps: unknown[]) => {
      const i = h.cursor++,
        previous = h.slots[i] as
          { deps: unknown[]; cleanup: () => void } | undefined;
      if (!previous || !same(previous.deps, deps))
        h.effects.push(() => {
          previous?.cleanup();
          h.slots[i] = { deps, cleanup: fn() };
        });
    },
  };
});
vi.mock("lightweight-charts", () => ({
  CandlestickSeries: "Candlestick",
  LineSeries: "Line",
  HistogramSeries: "Histogram",
  ColorType: { Solid: "solid" },
  CrosshairMode: { Normal: 0 },
  createChart: (_element: unknown, options: Record<string, unknown>) => {
    const panes: FakePane[] = Array.from({ length: 3 }, () => {
      const pane: FakePane = {
        setStretchFactor() {},
        scale: {},
        priceScale() {
          return {
            applyOptions: (options) => Object.assign(pane.scale, options),
          };
        },
      };
      return pane;
    });
    const chart: FakeChart = {
      options,
      series: [],
      range: null,
      removed: false,
      addSeries(kind, opts, pane = 0) {
        const series: FakeSeries = {
          kind,
          pane,
          options: opts,
          data: [],
          attachPrimitive() {},
          priceScale() {
            return {
              applyOptions: (options) => {
                this.options.scale = options;
              },
            };
          },
          createPriceLine(options) {
            this.options.costLine = options;
          },
          setData(data) {
            this.data = data;
          },
        };
        this.series.push(series);
        return series;
      },
      removeSeries(series) {
        this.series = this.series.filter((s) => s !== series);
      },
      panes: () => panes,
      timeScale: () => ({
        getVisibleLogicalRange: () => chart.range,
        setVisibleLogicalRange: (range) => {
          chart.range = range;
          chart.rangeChanged?.(range);
        },
        subscribeVisibleLogicalRangeChange: (callback) => {
          chart.rangeChanged = callback;
        },
      }),
      subscribeCrosshairMove(callback) {
        this.crosshair = callback;
      },
      remove() {
        this.removed = true;
      },
    };
    h.charts.push(chart);
    return chart;
  },
}));
import { defaultChartView } from "../src/lib/chart-view";
import { MarketChart, PriceChart } from "../src/components/chart";
function render(bars: Bar[], period: Period = "day") {
  h.cursor = 0;
  const element = PriceChart({ bars, period }) as ReactElement<{
    bars: Bar[];
    period: Period;
  }>;
  const result = (
    element.type as (props: typeof element.props) => ReactElement
  )(element.props);
  h.effects.splice(0).forEach((effect) => effect());
  return result;
}
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!("props" in node)) return [];
  const element = node as ReactElement<Record<string, unknown>>;
  return [element, ...elements(element.props.children as ReactNode)];
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (node && typeof node === "object" && "props" in node)
    return text((node as ReactElement<{ children: ReactNode }>).props.children);
  return node == null ? "" : String(node);
}
function bars(length: number): Bar[] {
  return Array.from({ length }, (_, i) => ({
    date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
    open: 20 + i,
    high: 22 + i,
    low: 19 + i,
    close: 21 + i,
    volume: 100 * i,
    amount: 2000 * i,
  }));
}
beforeEach(() => {
  vi.stubGlobal("window", new EventTarget());
  h.slots = [];
  h.cursor = 0;
  h.charts = [];
  h.effects = [];
  h.frames = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    h.frames.push(callback);
    return h.frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
describe("M2 chart event wiring", () => {
  it("keeps the native drag intact and reveals history only after pointer release", () => {
    render(bars(601));
    const chart = h.charts.at(-1)!;
    const container = (h.slots[0] as { current: EventTarget }).current;
    expect(chart.options.handleScroll).toMatchObject({
      pressedMouseMove: true,
    });
    container.dispatchEvent(new Event("pointerdown"));
    chart.timeScale().setVisibleLogicalRange({ from: -10, to: 80 });
    h.frames.splice(0).forEach((fn) => fn(0));
    expect(chart.series[0]!.data).toHaveLength(180);
    window.dispatchEvent(new Event("pointerup"));
    h.frames.splice(0).forEach((fn) => fn(0));
    expect(chart.series[0]!.data).toHaveLength(360);
    expect(chart.range).toEqual({ from: 170, to: 260 });
  });
  it("keeps the native chart instance across parent rerenders", () => {
    const input = bars(90);
    render(input);
    const chart = h.charts.at(-1)!;
    render(input);
    expect(h.charts).toHaveLength(1);
    expect(h.charts.at(-1)).toBe(chart);
  });
  it("actual crosshair callbacks render OHLCV and M1 reads for three bars", () => {
    const input = bars(90);
    let ui = render(input);
    expect(text(ui)).toContain("主图：均线");
    expect(text(ui)).toContain("副图：成交量 + MACD");
    for (const i of [0, 19, 89]) {
      h.charts.at(-1)!.crosshair!({ time: input[i]!.date });
      ui = render(input);
      const legend = text(
        elements(ui).find((e) => e.props["data-testid"] === "chart-legend"),
      );
      expect(legend).toContain(input[i]!.date);
      expect(legend).toContain(`收 ${input[i]!.close.toFixed(2)}`);
      expect(legend).toContain(`量 ${input[i]!.volume.toFixed(2)} 股`);
      expect(legend).toContain(`MA20 ${ma(input, 20)[i]?.toFixed(2) ?? "—"}`);
      expect(legend).toContain(`MACD ${macd(input)[i]!.macd!.toFixed(2)}`);
    }
    expect(
      h.charts.at(-1)!.series.find((s) => s.kind === "Histogram")!.pane,
    ).toBe(1);
    expect(
      (h.charts.at(-1)!.options.layout as { attributionLogo: boolean })
        .attributionLogo,
    ).toBe(true);
    expect(
      elements(ui).some((e) => e.props.href === "https://www.tradingview.com/"),
    ).toBe(true);
  });
  it("scroll callbacks submit a gapless full snapshot and switching period removes all old series", () => {
    const input = bars(601);
    render(input);
    const chart = h.charts.at(-1)!;
    expect(chart.series[0]!.data).toHaveLength(180);
    for (let i = 0; i < 3; i++) {
      chart.timeScale().setVisibleLogicalRange({ from: 0, to: 50 });
      h.frames.splice(0).forEach((fn) => fn(0));
    }
    expect(chart.series[0]!.data.map((p) => p.time)).toEqual(
      input.map((b) => b.date),
    );
    const minute = bars(8).map((b, i) => ({
      ...b,
      date: `2026-09-08T10:${String(i * 5).padStart(2, "0")}:00+08:00`,
    }));
    render(minute, "5m");
    const replacement = h.charts.at(-1)!;
    expect(chart.removed).toBe(true);
    expect(replacement.series[0]!.data).toHaveLength(8);
    expect(
      replacement.series.filter((s) => s.kind === "Line" && s.pane === 0),
    ).toHaveLength(1); // only MA5, no stale MA10/20/60
    expect(
      replacement.series[0]!.data.every((p) => typeof p.time === "number"),
    ).toBe(true);
    render(input, "day");
    expect(replacement.removed).toBe(true);
    expect(h.charts.at(-1)!.series[0]!.data).toHaveLength(180);
  });
});

it("only renders selected main and secondary indicators in the chart and legend", () => {
  const input = bars(90),
    view = {
      ...structuredClone(defaultChartView),
      mainIndicators: [],
      subchart: [],
    };
  h.cursor = 0;
  const ui = MarketChart({ bars: input, period: "day", view });
  h.effects.splice(0).forEach((effect) => effect());
  const chart = h.charts.at(-1)!;
  const legend = text(
    elements(ui).find((e) => e.props["data-testid"] === "chart-legend"),
  );
  expect(text(ui)).toContain("主图：无主图指标");
  expect(text(ui)).toContain("副图：无副图");
  expect(legend).not.toContain("量 ");
  expect(legend).not.toContain("MA");
  expect(legend).not.toContain("MACD");
  expect(chart.series).toHaveLength(1);
});

it("Q1 actual chart options, cost line, parameter legend and keyboard handler are wired", () => {
  const input = bars(90),
    view = structuredClone(defaultChartView);
  view.dark = true;
  view.logarithmic = true;
  view.parameters.ma[0] = 3;
  h.cursor = 0;
  const ui = MarketChart({
    bars: input,
    period: "month",
    view,
    cost: 50,
    czscMessage: "缠论结构在周/月线不可用",
    breakoutMessage: "双突破仅支持日线",
  });
  h.effects.splice(0).forEach((e) => e());
  const chart = h.charts.at(-1)!;
  expect(chart.options.rightPriceScale).toMatchObject({ mode: 0 });
  expect(chart.series[0]!.options.scale).toMatchObject({ mode: 1 });
  expect(chart.panes()[1]!.scale).toMatchObject({ mode: 0 });
  expect(chart.options.layout).toMatchObject({
    background: { color: "#111827" },
  });
  expect(chart.options.handleScale).toMatchObject({
    axisPressedMouseMove: { price: true, time: true },
  });
  expect(chart.series[0]!.options.costLine).toMatchObject({
    price: 50,
    color: "#cf5562",
  });
  expect(
    text(elements(ui).find((e) => e.props["data-testid"] === "chart-legend")),
  ).toContain("MA3");
  expect(text(ui)).toContain("周/月线不可用");
  const area = elements(ui).find((e) => e.props.role === "application")!;
  chart.range = { from: 0, to: 100 };
  const preventDefault = vi.fn();
  const focus = vi.fn();
  (area.props.onPointerDown as (e: unknown) => void)({
    currentTarget: { focus },
  });
  expect(focus).toHaveBeenCalledOnce();
  (area.props.onKeyDown as (e: unknown) => void)({
    key: "ArrowUp",
    preventDefault,
  });
  expect(chart.range).toEqual({ from: 10, to: 90 });
  expect(preventDefault).toHaveBeenCalledOnce();
});
it("Q1 no holding produces no price line", () => {
  render(bars(90));
  expect(h.charts.at(-1)!.series[0]!.options.costLine).toBeUndefined();
});
