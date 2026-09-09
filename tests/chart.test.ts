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
  panes: () => { setStretchFactor: () => void }[];
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
      h.slots[i] ??= { current: i === 0 ? {} : value };
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
      panes: () => [{ setStretchFactor() {} }, { setStretchFactor() {} }],
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
import { PriceChart } from "../src/components/chart";
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
  it("actual crosshair callbacks render OHLCV and M1 reads for three bars", () => {
    const input = bars(90);
    let ui = render(input);
    const select = elements(ui).find((e) => e.props["aria-label"] === "副图")!;
    (select.props.onChange as (event: unknown) => void)({
      target: { value: "macd" },
    });
    render(input);
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
