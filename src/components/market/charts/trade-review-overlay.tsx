import type { ISeriesPrimitive, SeriesMarker, Time } from "lightweight-charts";
import { chartTime } from "~/lib/chart/chart-data";
import { chartColor } from "~/lib/chart/chart-theme";
import { normalizeTradeDate } from "~/lib/chart/chart-trade-marks";
import type {
  ChartTradeReview,
  TradeReviewBox,
} from "~/lib/chart/trade-review-ref";
import type { MarketChartState } from "../market-chart-state";

export function reviewFillMarkers(
  review: ChartTradeReview,
  times: ReadonlyMap<Time, number>,
  start: number,
): SeriesMarker<Time>[] {
  return review.fills.flatMap((fill, index) => {
    const time = chartTime(normalizeTradeDate(fill.date), "day");
    if ((times.get(time) ?? -1) < start) return [];
    const buy = fill.side === "buy";
    const stop = fill.trigger === "stop" && !buy;
    return [
      {
        time,
        id: `trade-review-fill:${index}`,
        position: buy ? "belowBar" : "aboveBar",
        shape: buy ? "arrowUp" : "arrowDown",
        color: stop
          ? chartColor.series1
          : buy
            ? chartColor.up
            : chartColor.down,
        text: stop ? "止损" : buy ? "买" : "卖",
      },
    ];
  });
}

export function reviewExtremes(box: TradeReviewBox) {
  return [
    {
      label: "MAE",
      date: box.maeDate,
      price: box.maePrice,
      color: chartColor.down,
    },
    {
      label: "MFE",
      date: box.mfeDate,
      price: box.mfePrice,
      color: chartColor.up,
    },
  ];
}

export function attachTradeReviewOverlay(
  state: MarketChartState,
  boxes: readonly TradeReviewBox[],
  activeBox: number | undefined,
) {
  const { chart, candles } = state;
  const scale = chart.timeScale();
  const xAt = (date: string) => {
    const index = state.byTime.get(chartTime(date, "day"));
    return index === undefined
      ? null
      : scale.timeToCoordinate(chartTime(date, "day"));
  };
  const rectangle = (box: TradeReviewBox) => {
    const entry = xAt(box.entryDate);
    const exit = xAt(box.exitDate);
    const entryY = candles.priceToCoordinate(box.entryPrice);
    const exitY = candles.priceToCoordinate(box.exitPrice);
    if (entry === null || exit === null || entryY === null || exitY === null)
      return null;
    return {
      left: Math.min(entry, exit) - 3,
      right: Math.max(entry, exit) + 3,
      top: Math.min(entryY, exitY) - 2,
      bottom: Math.max(entryY, exitY) + 2,
      entryY,
    };
  };
  const draw = (ctx: CanvasRenderingContext2D, width: number) => {
    for (const [index, box] of boxes.entries()) {
      const rect = rectangle(box);
      if (!rect || rect.right < 0 || rect.left > width) continue;
      const { left, right, top, bottom, entryY } = rect;
      const pnl = box.pnlAmount ?? box.pnlPct;
      const positive = pnl !== null && pnl > 0;
      const negative = pnl !== null && pnl < 0;
      ctx.fillStyle = positive
        ? chartColor.upFaint
        : negative
          ? chartColor.downFaint
          : chartColor.grid;
      ctx.strokeStyle = positive
        ? chartColor.up
        : negative
          ? chartColor.down
          : chartColor.muted;
      ctx.lineWidth = index === activeBox ? 2 : 1;
      ctx.fillRect(left, top, right - left, bottom - top);
      ctx.strokeRect(left, top, right - left, bottom - top);

      ctx.font = '11px "Inter", "Microsoft YaHei", sans-serif';
      for (const { label, date, price, color } of reviewExtremes(box)) {
        if (!date || price === null) continue;
        const x = xAt(date);
        const y = candles.priceToCoordinate(price);
        if (x === null || y === null || x < 0 || x > width) continue;
        ctx.strokeStyle = ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(x, entryY);
        ctx.lineTo(x, y);
        ctx.moveTo(x - 4, y);
        ctx.lineTo(x + 4, y);
        ctx.stroke();
        ctx.fillText(label, Math.min(x + 6, width - 27), y - 4);
      }
    }
  };
  const primitive: ISeriesPrimitive<Time> = {
    paneViews: () => [
      {
        zOrder: () => "normal",
        renderer: () => ({
          draw: (target) =>
            target.useMediaCoordinateSpace(({ context, mediaSize }) => {
              context.save();
              draw(context, mediaSize.width);
              context.restore();
            }),
        }),
      },
    ],
    hitTest: (x, y) => {
      for (let index = boxes.length - 1; index >= 0; index--) {
        const box = rectangle(boxes[index]!);
        if (
          box &&
          x >= box.left &&
          x <= box.right &&
          y >= box.top &&
          y <= box.bottom
        )
          return {
            externalId: `trade-review-box:${index}`,
            zOrder: "normal",
            cursorStyle: "pointer",
          };
      }
      return null;
    },
  };
  candles.attachPrimitive(primitive);
  return () => candles.detachPrimitive(primitive);
}
