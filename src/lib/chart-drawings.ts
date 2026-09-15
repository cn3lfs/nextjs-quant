import type {
  IChartApi,
  ISeriesApi,
  ISeriesPrimitive,
  Time,
  Logical,
} from "lightweight-charts";
import type { Bar } from "./domain";
import { chartTime } from "./chart-data";
import type { ChartPeriod, Drawing } from "./chart-view";
export const fibonacciLevels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
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
  let nearest: { date: string; x: number } | null = null;
  for (const bar of bars) {
    const bx = scale.timeToCoordinate(chartTime(bar.date, period));
    if (bx !== null && (!nearest || Math.abs(bx - x) < Math.abs(nearest.x - x)))
      nearest = { date: bar.date, x: bx };
  }
  return nearest
    ? { date: nearest.date, price, offset: (x - nearest.x) / spacing }
    : null;
}
export function drawingPreview(
  kind: Drawing["kind"],
  anchor: Drawing["a"] | null,
  cursor: Drawing["a"] | null,
  color: string,
): Drawing | null {
  return cursor
    ? { id: "preview", kind, a: anchor ?? cursor, b: cursor, color }
    : null;
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
              for (const d of drawings)
                for (const segment of drawingSegments(d)) {
                  // Resolve anchors against the current time scale so pan, log and axis drags stay aligned.
                  const x1 = drawingX(chart, segment.a, period),
                    x2 = drawingX(chart, segment.b, period);
                  const y1 = candles.priceToCoordinate(segment.a.price),
                    y2 = candles.priceToCoordinate(segment.b.price);
                  if (y1 === null || y2 === null) continue;
                  ctx.save();
                  ctx.setLineDash(preview ? [6, 4] : []);
                  ctx.strokeStyle = d.color;
                  ctx.fillStyle = d.color;
                  ctx.lineWidth = 2;
                  if (d.kind === "horizontal") {
                    ctx.beginPath();
                    ctx.moveTo(0, y1);
                    ctx.lineTo(mediaSize.width, y1);
                    ctx.stroke();
                    ctx.fillText(`水平 ${d.a.price.toFixed(2)}`, 8, y1 - 5);
                    ctx.restore();
                    continue;
                  }
                  if (x1 === null || x2 === null) {
                    ctx.restore();
                    continue;
                  }
                  if (d.kind === "rectangle") {
                    ctx.globalAlpha = 0.12;
                    ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
                    ctx.globalAlpha = 1;
                    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
                  } else {
                    ctx.beginPath();
                    ctx.moveTo(x1, y1);
                    ctx.lineTo(x2, y2);
                    ctx.stroke();
                    if (d.kind === "fibonacci")
                      ctx.fillText(segment.label, Math.min(x1, x2) + 4, y1 - 4);
                  }
                  for (const [x, y] of [
                    [x1, y1],
                    [x2, y2],
                  ]) {
                    ctx.beginPath();
                    ctx.arc(x!, y!, 3, 0, Math.PI * 2);
                    ctx.fill();
                  }
                  ctx.restore();
                }
            }),
        }),
      },
    ],
  };
  candles.attachPrimitive(primitive);
  return (next: Drawing | null) => {
    drawings = next ? [next] : [];
    requestUpdate();
  };
}
