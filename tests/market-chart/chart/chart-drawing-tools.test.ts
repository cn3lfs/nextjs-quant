import { expect, it } from "vitest";
import type { IChartApi, ISeriesApi } from "lightweight-charts";
import {
  drawingGeometry,
  drawingPointCount,
  drawingPreview,
  hitDrawing,
} from "../../../src/lib/chart/chart-drawings";
import {
  chartViewSchema,
  defaultChartView,
  type Drawing,
} from "../../../src/lib/chart/chart-view";

// x = bar index × 20 px (2026-09-01 is bar 0); y = (100 − price) × 10 px.
const day = (i: number) => `2026-09-${String(i + 1).padStart(2, "0")}`;
const chart = {
  timeScale: () => ({
    timeToCoordinate: (date: string) => (Number(date.slice(8)) - 1) * 20,
    logicalToCoordinate: (logical: number) => logical * 20,
  }),
} as unknown as IChartApi;
const candles = {
  priceToCoordinate: (price: number) => (100 - price) * 10,
} as unknown as ISeriesApi<"Candlestick">;
const at = (i: number, price: number) => ({ date: day(i), price });
const make = (d: Partial<Drawing> & Pick<Drawing, "kind">): Drawing => ({
  id: crypto.randomUUID(),
  a: at(1, 90),
  b: at(5, 80),
  color: "#123456",
  ...d,
});
const geometry = (d: Drawing) =>
  drawingGeometry(chart, candles, "day", d, 400)!;

it("new tools keep earlier saved views valid and need 1–3 clicks", () => {
  expect(
    chartViewSchema.parse({
      ...defaultChartView,
      drawings: [make({ kind: "trend" })],
    }).drawings[0]!.c,
  ).toBeUndefined();
  expect(
    chartViewSchema.safeParse({
      ...defaultChartView,
      drawings: [make({ kind: "text", text: "x".repeat(81) })],
    }).success,
  ).toBe(false);
  expect(
    (["horizontal", "text", "trend", "ray", "measure", "channel"] as const).map(
      drawingPointCount,
    ),
  ).toEqual([1, 1, 2, 2, 2, 3]);
});

it("a ray extends through b to the chart edge", () => {
  const g = geometry(make({ kind: "ray" }));
  // a (20,100) → b (100,200): slope 1.25 px/px, reaches x=400 at y=575.
  expect(g.lines).toEqual([
    [
      { x: 20, y: 100 },
      { x: 400, y: 575 },
    ],
  ]);
});

it("a channel's parallel line keeps the slope and passes through c", () => {
  const g = geometry(make({ kind: "channel", c: at(3, 95) }));
  // Base line at x=60 is y=150; c is at y=50, so the copy is 100px higher.
  expect(g.lines[1]).toEqual([
    { x: 20, y: 0 },
    { x: 100, y: 100 },
  ]);
  expect(g.handles.map((h) => h.key)).toEqual(["a", "b", "c"]);
  expect(g.fill).toHaveLength(4);
});

it("measure labels price change, percent and bar count", () => {
  const g = geometry(make({ kind: "measure" }));
  expect(g.labels[0]!.text).toBe("-10.00 (-11.11%) · 4 根");
  expect(g.box).toEqual({ x: 20, y: 100, w: 80, h: 100 });
});

it("hit-testing prefers handles, then lines, boxes and channel fills", () => {
  const trend = make({ kind: "trend" }),
    box = make({ kind: "rectangle", a: at(10, 70), b: at(14, 60) }),
    channel = make({
      kind: "channel",
      a: at(1, 50),
      b: at(5, 50),
      c: at(3, 40),
    });
  const all = [trend, box, channel].map((d) => ({
    id: d.id,
    geometry: geometry(d),
  }));
  expect(hitDrawing(all, 21, 101)).toEqual({ id: trend.id, handle: "a" });
  expect(hitDrawing(all, 60, 151)).toEqual({ id: trend.id, handle: null });
  expect(hitDrawing(all, 250, 350)).toEqual({ id: box.id, handle: null });
  // Between the two channel lines (y 500 and 600).
  expect(hitDrawing(all, 60, 550)).toEqual({ id: channel.id, handle: null });
  expect(hitDrawing(all, 390, 10)).toBeNull();
});

it("placement preview follows the clicks: third point shapes the channel", () => {
  const cursor = at(4, 70);
  expect(drawingPreview("trend", [], cursor, "#fff")).toMatchObject({
    a: cursor,
    b: cursor,
  });
  expect(
    drawingPreview("channel", [at(1, 90), at(5, 80)], cursor, "#fff"),
  ).toMatchObject({ a: at(1, 90), b: at(5, 80), c: cursor });
  expect(drawingPreview("text", [], cursor, "#fff", "")!.text).toBe("标注");
});
