import type { ISeriesPrimitive, Time } from "lightweight-charts";
import { chartColor } from "~/lib/chart/chart-theme";
import { chartTime } from "~/lib/chart/chart-data";
import type { ChartPeriod } from "~/lib/chart/chart-view";
import type { MarketChartState } from "./market-chart-state";

export function attachChartStructure(
  state: MarketChartState,
  period: ChartPeriod,
) {
  const { chart, candles } = state;
  // A series primitive follows the chart's own pan/zoom/price-scale paint cycle.
  // Rectangles use DLL boundaries and ZG/ZD; no chart-side structure calculation.
  const primitive: ISeriesPrimitive<Time> = {
    paneViews: () => [
      {
        zOrder: () => "normal",
        renderer: () => ({
          draw: (target) =>
            target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
              const { czsc: structure, bars: shown, start } = state.structure;
              if (!structure) return;
              const x = (index: number) =>
                chart
                  .timeScale()
                  .timeToCoordinate(chartTime(shown[index]!.date, period));
              for (const family of structure.families) {
                const color =
                  family.config === 0 ? chartColor.series1 : chartColor.accent;
                for (const center of family.centers) {
                  // The DLL projection already ends the box at the first three members or the extension.
                  const end = center.end;
                  if (end < start) continue;
                  const x1 = x(Math.max(start, center.start)),
                    x2 = x(end);
                  const y1 = candles.priceToCoordinate(center.ZG),
                    y2 = candles.priceToCoordinate(center.ZD);
                  if (x1 === null || x2 === null || y1 === null || y2 === null)
                    continue;
                  ctx.fillStyle = `${color}18`;
                  ctx.strokeStyle = color;
                  ctx.lineWidth = 1;
                  ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
                  ctx.strokeRect(x1, y1, x2 - x1, Math.max(1, y2 - y1));
                }
                for (const interval of family.divergences) {
                  if (interval.end < start) continue;
                  const x1 = x(Math.max(start, interval.start)),
                    x2 = x(interval.end);
                  if (x1 === null || x2 === null) continue;
                  ctx.fillStyle =
                    interval.direction > 0
                      ? chartColor.upFaint
                      : chartColor.downFaint;
                  ctx.fillRect(x1, 0, x2 - x1, mediaSize.height);
                }
              }
            }),
        }),
      },
    ],
  };
  candles.attachPrimitive(primitive);
}
