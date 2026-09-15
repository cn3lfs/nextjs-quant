import { expect, it, vi } from "vitest";
import type {
  IChartApi,
  ISeriesApi,
  ISeriesPrimitive,
  Time,
  IHorzScaleBehavior,
} from "lightweight-charts";
import {
  attachDrawings,
  drawingAnchor,
  drawingPreview,
  drawingX,
} from "../src/lib/chart-drawings";
import { drawingSchema, type Drawing } from "../src/lib/chart-view";
import type { Bar } from "../src/lib/domain";

function fixture() {
  let spacing = 20,
    shift = 0;
  const bars = ["2026-09-10", "2026-09-11"].map((date) => ({ date })) as Bar[];
  const scale = {
    timeToCoordinate: (date: string) => {
      const i = bars.findIndex((b) => b.date === date);
      return i < 0 ? null : (i + shift) * spacing;
    },
    coordinateToLogical: (x: number) => Math.ceil(x / spacing),
    logicalToCoordinate: (x: number) => x * spacing,
  };
  const chart = { timeScale: () => scale } as unknown as IChartApi;
  let primitive: ISeriesPrimitive<Time>;
  const requestUpdate = vi.fn();
  const candles = {
    coordinateToPrice: (y: number) => 100 - y / 10,
    priceToCoordinate: (price: number) => (100 - price) * 10,
    attachPrimitive: (p: ISeriesPrimitive<Time>) => {
      primitive = p;
      p.attached?.({
        chart,
        series: candles,
        requestUpdate,
        horzScaleBehavior: {} as IHorzScaleBehavior<Time>,
      });
    },
  } as unknown as ISeriesApi<"Candlestick">;
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    setLineDash: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fillText: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
  };
  const paint = () =>
    primitive.paneViews!()[0]!
      .renderer()!
      .draw({
        useMediaCoordinateSpace: (fn: (scope: unknown) => void) =>
          fn({ context: ctx, mediaSize: { width: 400, height: 300 } }),
      } as never);
  return {
    bars,
    chart,
    candles,
    ctx,
    paint,
    requestUpdate,
    panZoom: () => {
      shift = 5;
      spacing = 40;
    },
  };
}
it("free anchors retain fractional positions and right whitespace across pan/zoom and save", () => {
  const f = fixture();
  const between = drawingAnchor(f.chart, f.candles, f.bars, "day", 7, 123)!;
  expect(between).toEqual({ date: "2026-09-10", price: 87.7, offset: 0.35 });
  const right = drawingAnchor(f.chart, f.candles, f.bars, "day", 70, 100)!;
  expect(right).toEqual({ date: "2026-09-11", price: 90, offset: 2.5 });
  expect(drawingX(f.chart, between, "day")).toBe(7);
  expect(drawingX(f.chart, right, "day")).toBe(70);
  f.panZoom();
  expect(drawingX(f.chart, between, "day")).toBe(214);
  expect(drawingX(f.chart, right, "day")).toBe(340);
  const drawing = {
    id: crypto.randomUUID(),
    kind: "trend",
    a: between,
    b: right,
    color: "#2563eb",
  };
  expect(drawingSchema.parse(JSON.parse(JSON.stringify(drawing)))).toEqual(
    drawing,
  );
  expect(
    drawingSchema.safeParse({ ...drawing, a: { ...between, offset: Infinity } })
      .success,
  ).toBe(false);
  expect(drawingAnchor(f.chart, f.candles, [], "day", 10, 10)).toBeNull();
  expect(drawingAnchor(f.chart, f.candles, f.bars, "day", 10, 1000)).toBeNull();
});
it.each(["horizontal", "trend", "rectangle", "fibonacci"] as const)(
  "%s previews follow cursor, clear without persistence, and render solid only when completed",
  (kind) => {
    const f = fixture();
    const a = { date: "2026-09-10", price: 90, offset: 0.2 },
      b = { date: "2026-09-11", price: 80, offset: 0.4 };
    const saved: Drawing[] = [];
    const update = attachDrawings(
      f.chart,
      f.candles,
      f.bars,
      "day",
      saved,
      true,
    );
    const first = drawingPreview(kind, null, a, "#2563eb")!;
    expect(first.a).toEqual(a);
    expect(first.b).toEqual(a);
    const preview = drawingPreview(
      kind,
      kind === "horizontal" ? null : a,
      b,
      "#2563eb",
    )!;
    expect(preview.a).toEqual(kind === "horizontal" ? b : a);
    expect(preview.b).toEqual(b);
    update(preview);
    f.paint();
    expect(f.ctx.setLineDash).toHaveBeenCalledWith([6, 4]);
    if (kind === "horizontal")
      expect(f.ctx.lineTo).toHaveBeenCalledWith(400, 200);
    expect(saved).toEqual([]);
    f.ctx.setLineDash.mockClear();
    update(drawingPreview(kind, a, null, "#2563eb"));
    f.paint();
    expect(f.ctx.setLineDash).not.toHaveBeenCalled();
    expect(f.requestUpdate).toHaveBeenCalledTimes(2);
    attachDrawings(f.chart, f.candles, f.bars, "day", [
      { ...preview, id: crypto.randomUUID() },
    ]);
    f.paint();
    expect(f.ctx.setLineDash).toHaveBeenCalledWith([]);
    expect(f.ctx.save.mock.calls.length).toBe(f.ctx.restore.mock.calls.length);
  },
);
it("legacy anchors remain on their exact timestamp", () => {
  const f = fixture();
  expect(drawingX(f.chart, { date: "2026-09-11", price: 80 }, "day")).toBe(20);
  expect(
    drawingX(f.chart, { date: "2025-01-01", price: 80 }, "day"),
  ).toBeNull();
});
