import type {
  IChartApi,
  ISeriesApi,
  ISeriesPrimitive,
  Time,
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
export function attachDrawings(
  chart: IChartApi,
  candles: ISeriesApi<"Candlestick">,
  bars: Bar[],
  period: ChartPeriod,
  drawings: Drawing[],
) {
  const primitive: ISeriesPrimitive<Time> = {
    paneViews: () => [
      {
        zOrder: () => "top",
        renderer: () => ({
          draw: (target) =>
            target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
              for (const d of drawings)
                for (const segment of drawingSegments(d)) {
                  // Resolve anchors against the current time scale so pan, log and axis drags stay aligned.
                  const x1 = chart
                      .timeScale()
                      .timeToCoordinate(chartTime(segment.a.date, period)),
                    x2 = chart
                      .timeScale()
                      .timeToCoordinate(chartTime(segment.b.date, period));
                  const y1 = candles.priceToCoordinate(segment.a.price),
                    y2 = candles.priceToCoordinate(segment.b.price);
                  if (y1 === null || y2 === null) continue;
                  ctx.strokeStyle = d.color;
                  ctx.fillStyle = d.color;
                  ctx.lineWidth = 2;
                  if (d.kind === "horizontal") {
                    ctx.beginPath();
                    ctx.moveTo(0, y1);
                    ctx.lineTo(mediaSize.width, y1);
                    ctx.stroke();
                    ctx.fillText(`水平 ${d.a.price.toFixed(2)}`, 8, y1 - 5);
                    continue;
                  }
                  if (x1 === null || x2 === null) continue;
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
                }
            }),
        }),
      },
    ],
  };
  candles.attachPrimitive(primitive);
}
