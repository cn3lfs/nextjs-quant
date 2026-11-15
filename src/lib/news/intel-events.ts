import { z } from "zod";
import type { Bar } from "~/lib/domain";
import { chartTime } from "~/lib/chart/chart-data";
import type { ChartPeriod } from "~/lib/chart/chart-view";
import { chartColor } from "~/lib/chart/chart-theme";
import type { SeriesMarker, Time } from "lightweight-charts";

export const intelEventQuerySchema = z
  .object({
    symbol: z.string().min(1).max(40),
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
  })
  .strict()
  .refine((v) => v.from <= v.to && v.to <= Date.now(), "情报区间无效");
export type IntelEvent = {
  id: string;
  publishedAt: string;
  title: string;
  preview: string;
  href: string;
  /** Date in the chart instrument's session timezone (A-share +08, crypto UTC). */
  sessionDate?: string;
};
/** Events anchor to the first bar at/after publication, never to an earlier
 * intraday decision. Non-trading days anchor to the next available bar. */
export function intelChartMarkers(
  events: readonly IntelEvent[],
  bars: readonly Bar[],
  period: ChartPeriod,
): SeriesMarker<Time>[] {
  return events.flatMap((event) => {
    const at = Date.parse(event.publishedAt);
    const bar = bars.find((b) =>
      b.date.length === 10
        ? b.date >= (event.sessionDate ?? event.publishedAt.slice(0, 10))
        : Date.parse(b.date) >= at,
    );
    return bar
      ? [
          {
            id: `intel:${event.id}`,
            time: chartTime(bar.date, period),
            position: "aboveBar" as const,
            shape: "circle" as const,
            color: chartColor.accent,
            text: event.title.slice(0, 24),
          },
        ]
      : [];
  });
}
