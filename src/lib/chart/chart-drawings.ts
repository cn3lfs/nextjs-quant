import type {
  IChartApi,
  ISeriesApi,
  ISeriesPrimitive,
  Time,
  Logical,
} from "lightweight-charts";
import type { Bar } from "../domain";
import { chartTime } from "./chart-data";
import type { ChartPeriod, Drawing } from "./chart-view";
export const fibonacciLevels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
/** Anchor clicks each drawing kind needs. */
export const drawingPointCount = (kind: Drawing["kind"]) =>
  kind === "horizontal" || kind === "text" ? 1 : kind === "channel" ? 3 : 2;
// Retracements are drawing geometry, not indicators or strategy evidence.
export function drawingSegments(d: Drawing) {
  if (d.kind === "horizontal")
    return [{ a: d.a, b: { ...d.b, price: d.a.price }, label: "水平" }];
  if (d.kind === "fibonacci")
    return fibonacciLevels.map((r) => ({
      a: { ...d.a, price: d.a.price + (d.b.price - d.a.price) * r },
      b: { ...d.b, price: d.a.price + (d.b.price - d.a.price) * r },
      label: `${(r * 100).toFixed(1)}%`,
    }));
  return [{ a: d.a, b: d.b, label: d.kind === "trend" ? "趋势线" : "矩形" }];
}
export function drawingX(
  chart: IChartApi,
  anchor: Drawing["a"],
  period: ChartPeriod,
) {
  const scale = chart.timeScale();
  const x = scale.timeToCoordinate(chartTime(anchor.date, period));
  if (x === null || !anchor.offset) return x;
  const spacing = drawingSpacing(chart);
  return spacing === null ? null : x + anchor.offset * spacing;
}
function drawingSpacing(chart: IChartApi) {
  const scale = chart.timeScale();
  const x0 = scale.logicalToCoordinate(0 as Logical),
    x1 = scale.logicalToCoordinate(1 as Logical);
  return x0 === null || x1 === null || x1 <= x0 ? null : x1 - x0;
}
export function drawingAnchor(
  chart: IChartApi,
  candles: ISeriesApi<"Candlestick">,
  bars: Bar[],
  period: ChartPeriod,
  x: number,
  y: number,
): Drawing["a"] | null {
  const scale = chart.timeScale(),
    spacing = drawingSpacing(chart),
    price = candles.coordinateToPrice(y);
  if (
    spacing === null ||
    price === null ||
    !Number.isFinite(price) ||
    price <= 0
  )
    return null;
  // coordinateToLogical rounds to whole bars; derive fractional offsets from pixels instead.
  // Bars not yet loaded into the series have no coordinate and form a prefix;
  // the rest are strictly increasing in x. Two binary searches find the same
  // nearest bar (earliest on a tie) as a linear scan, in O(log n) conversions
  // instead of converting every date on every pointer move.
  const at = (i: number) =>
    scale.timeToCoordinate(chartTime(bars[i]!.date, period));
  let lo = 0,
    hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (at(mid) === null) lo = mid + 1;
    else hi = mid;
  }
  const first = lo;
  hi = bars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (at(mid)! < x) lo = mid + 1;
    else hi = mid;
  }
  let nearest: { date: string; x: number } | null = null;
  for (const i of [lo - 1, lo]) {
    if (i < first || i >= bars.length) continue;
    const bx = at(i);
    if (bx !== null && (!nearest || Math.abs(bx - x) < Math.abs(nearest.x - x)))
      nearest = { date: bars[i]!.date, x: bx };
  }
  return nearest
    ? { date: nearest.date, price, offset: (x - nearest.x) / spacing }
    : null;
}
/** Preview while placing: fixed points so far, then the cursor. */
export function drawingPreview(
  kind: Drawing["kind"],
  points: readonly Drawing["a"][] | Drawing["a"] | null,
  cursor: Drawing["a"] | null,
  color: string,
  text?: string,
): Drawing | null {
  if (!cursor) return null;
  const fixed =
    points === null ? [] : Array.isArray(points) ? points : [points];
  return {
    id: "preview",
    kind,
    a: fixed[0] ?? cursor,
    b: fixed[1] ?? cursor,
    ...(kind === "channel" && fixed.length >= 2 ? { c: cursor } : {}),
    ...(kind === "text" ? { text: text || "标注" } : {}),
    color,
  };
}

type Point = { x: number; y: number };
export type DrawingHandle = "a" | "b" | "c";
/** Pixel geometry of one drawing, shared by painting and hit-testing. */
export type DrawingGeometry = {
  handles: (Point & { key: DrawingHandle })[];
  lines: [Point, Point][];
  box?: { x: number; y: number; w: number; h: number };
  fill?: Point[];
  labels: (Point & { text: string })[];
};
const textWidth = (text: string) =>
  [...text].reduce((w, c) => w + (c.charCodeAt(0) > 255 ? 12 : 7), 0);

export function drawingGeometry(
  chart: IChartApi,
  candles: ISeriesApi<"Candlestick">,
  period: ChartPeriod,
  d: Drawing,
  width: number,
): DrawingGeometry | null {
  const px = (p: Drawing["a"]): Point | null => {
    const x = drawingX(chart, p, period),
      y = candles.priceToCoordinate(p.price);
    return x === null || y === null ? null : { x, y };
  };
  const y1 = candles.priceToCoordinate(d.a.price);
  if (y1 === null) return null;
  if (d.kind === "horizontal") {
    const a = px(d.a);
    return {
      handles: [{ key: "a", x: a?.x ?? 24, y: y1 }],
      lines: [
        [
          { x: 0, y: y1 },
          { x: width, y: y1 },
        ],
      ],
      labels: [{ text: `水平 ${d.a.price.toFixed(2)}`, x: 8, y: y1 - 5 }],
    };
  }
  const a = px(d.a);
  if (!a) return null;
  if (d.kind === "text") {
    const text = d.text ?? "标注";
    return {
      handles: [{ key: "a", ...a }],
      lines: [],
      box: { x: a.x - 2, y: a.y - 16, w: textWidth(text) + 4, h: 20 },
      labels: [{ text, x: a.x, y: a.y }],
    };
  }
  const b = px(d.b);
  if (!b) return null;
  const handles: DrawingGeometry["handles"] = [
    { key: "a", ...a },
    { key: "b", ...b },
  ];
  if (d.kind === "rectangle" || d.kind === "measure") {
    const box = {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      w: Math.abs(b.x - a.x),
      h: Math.abs(b.y - a.y),
    };
    const labels: DrawingGeometry["labels"] = [];
    if (d.kind === "measure") {
      const change = d.b.price - d.a.price;
      const spacing = drawingSpacing(chart);
      const bars = spacing ? Math.round((b.x - a.x) / spacing) : null;
      labels.push({
        text: `${change >= 0 ? "+" : ""}${change.toFixed(2)} (${change >= 0 ? "+" : ""}${((change / d.a.price) * 100).toFixed(2)}%)${bars === null ? "" : ` · ${bars} 根`}`,
        x: box.x + 4,
        y: box.y - 6,
      });
    }
    return { handles, lines: [], box, labels };
  }
  if (d.kind === "fibonacci")
    return {
      handles,
      lines: drawingSegments(d).flatMap((s) => {
        const y = candles.priceToCoordinate(s.a.price);
        return y === null
          ? []
          : [
              [
                { x: a.x, y },
                { x: b.x, y },
              ] as [Point, Point],
            ];
      }),
      labels: drawingSegments(d).flatMap((s) => {
        const y = candles.priceToCoordinate(s.a.price);
        return y === null
          ? []
          : [{ text: s.label, x: Math.min(a.x, b.x) + 4, y: y - 4 }];
      }),
    };
  if (d.kind === "ray") {
    // Extend a→b to the chart edge in its horizontal direction.
    const dx = b.x - a.x,
      edge = dx >= 0 ? width : 0,
      t = dx === 0 ? 0 : (edge - a.x) / dx;
    const end = dx === 0 ? b : { x: edge, y: a.y + (b.y - a.y) * t };
    return { handles, lines: [[a, end]], labels: [] };
  }
  if (d.kind === "channel" && d.c) {
    const c = px(d.c);
    if (c) {
      // The parallel line keeps a→b's slope and passes through c.
      const slope = b.x === a.x ? 0 : (b.y - a.y) / (b.x - a.x);
      const dy = c.y - (a.y + (c.x - a.x) * slope);
      const a2 = { x: a.x, y: a.y + dy },
        b2 = { x: b.x, y: b.y + dy };
      return {
        handles: [...handles, { key: "c", ...c }],
        lines: [
          [a, b],
          [a2, b2],
        ],
        fill: [a, b, b2, a2],
        labels: [],
      };
    }
  }
  return { handles, lines: [[a, b]], labels: [] };
}

const segmentDistance = (p: Point, [s, e]: [Point, Point]) => {
  const dx = e.x - s.x,
    dy = e.y - s.y,
    length = dx * dx + dy * dy;
  const t =
    length === 0
      ? 0
      : Math.max(
          0,
          Math.min(1, ((p.x - s.x) * dx + (p.y - s.y) * dy) / length),
        );
  return Math.hypot(p.x - (s.x + t * dx), p.y - (s.y + t * dy));
};
const insidePolygon = (p: Point, polygon: Point[]) => {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!,
      b = polygon[j]!;
    if (
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
};
/** Topmost drawing under a pointer: an endpoint handle wins over the body. */
export function hitDrawing(
  geometries: readonly { id: string; geometry: DrawingGeometry | null }[],
  x: number,
  y: number,
): { id: string; handle: DrawingHandle | null } | null {
  const p = { x, y };
  for (let i = geometries.length - 1; i >= 0; i--) {
    const { id, geometry: g } = geometries[i]!;
    if (!g) continue;
    const handle = g.handles.find((h) => Math.hypot(h.x - x, h.y - y) <= 7);
    if (handle) return { id, handle: handle.key };
  }
  for (let i = geometries.length - 1; i >= 0; i--) {
    const { id, geometry: g } = geometries[i]!;
    if (!g) continue;
    if (
      g.lines.some((line) => segmentDistance(p, line) <= 5) ||
      (g.box &&
        x >= g.box.x &&
        x <= g.box.x + g.box.w &&
        y >= g.box.y &&
        y <= g.box.y + g.box.h) ||
      (g.fill && insidePolygon(p, g.fill))
    )
      return { id, handle: null };
  }
  return null;
}

export function attachDrawings(
  chart: IChartApi,
  candles: ISeriesApi<"Candlestick">,
  bars: Bar[],
  period: ChartPeriod,
  drawings: Drawing[],
  preview = false,
) {
  let requestUpdate = () => {};
  let selected: string | null = null;
  let width = 0;
  const primitive: ISeriesPrimitive<Time> = {
    attached: (parameters) => {
      requestUpdate = parameters.requestUpdate;
    },
    paneViews: () => [
      {
        zOrder: () => "top",
        renderer: () => ({
          draw: (target) =>
            target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
              width = mediaSize.width;
              for (const d of drawings) {
                // Resolve anchors against the current time scale so pan, log and axis drags stay aligned.
                const g = drawingGeometry(chart, candles, period, d, width);
                if (!g) continue;
                const active = d.id === selected;
                ctx.save();
                ctx.setLineDash(preview ? [6, 4] : []);
                ctx.strokeStyle = d.color;
                ctx.fillStyle = d.color;
                ctx.lineWidth = active ? 3 : 2;
                if (g.fill) {
                  ctx.globalAlpha = 0.1;
                  ctx.beginPath();
                  g.fill.forEach((p, i) =>
                    i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y),
                  );
                  ctx.closePath();
                  ctx.fill();
                  ctx.globalAlpha = 1;
                }
                if (g.box && d.kind !== "text") {
                  ctx.globalAlpha = d.kind === "measure" ? 0.16 : 0.12;
                  ctx.fillRect(g.box.x, g.box.y, g.box.w, g.box.h);
                  ctx.globalAlpha = 1;
                  if (d.kind === "measure") ctx.setLineDash([4, 3]);
                  ctx.strokeRect(g.box.x, g.box.y, g.box.w, g.box.h);
                  ctx.setLineDash(preview ? [6, 4] : []);
                }
                for (const [s, e] of g.lines) {
                  ctx.beginPath();
                  ctx.moveTo(s.x, s.y);
                  ctx.lineTo(e.x, e.y);
                  ctx.stroke();
                }
                ctx.font =
                  d.kind === "text" ? "13px sans-serif" : "11px sans-serif";
                for (const label of g.labels)
                  ctx.fillText(label.text, label.x, label.y);
                // Endpoints: small dots, or white-ringed handles when selected.
                for (const h of g.handles) {
                  if (d.kind === "text" && !active) continue;
                  ctx.beginPath();
                  ctx.arc(h.x, h.y, active ? 5 : 3, 0, Math.PI * 2);
                  ctx.fill();
                  if (active) {
                    ctx.lineWidth = 2;
                    ctx.strokeStyle = "#ffffff";
                    ctx.stroke();
                    ctx.strokeStyle = d.color;
                  }
                }
                ctx.restore();
              }
            }),
        }),
      },
    ],
  };
  candles.attachPrimitive(primitive);
  // Replace the painted set in place: one preview, or the saved drawings
  // with an optional selected drawing.
  const set = (
    next: Drawing | readonly Drawing[] | null,
    selectedId: string | null = null,
  ) => {
    drawings =
      next === null ? [] : Array.isArray(next) ? [...next] : [next as Drawing];
    selected = selectedId;
    requestUpdate();
  };
  /** Current pixel geometry of the painted drawings, for hit-testing. */
  set.geometries = () =>
    drawings.map((d) => ({
      id: d.id,
      geometry: drawingGeometry(chart, candles, period, d, width),
    }));
  return set;
}
