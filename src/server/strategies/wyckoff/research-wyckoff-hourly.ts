import type { Bar } from "~/lib/domain";
import type { WyckoffHourlyInput } from "~/lib/research-wyckoff-hourly";
import { hourlyBars } from "../../market/hourly-bars";
/** Historical completed-bar replay; end timestamps are model availability,
 * not evidence of the vendor's original publication latency. */
export function wyckoffHourlyFromMinutes(
  stock: {
    symbol: string;
    minuteBars?: Bar[];
    minuteSource?: { source: string; hash: string };
  },
  calendar: readonly string[],
  end: string,
): WyckoffHourlyInput[] {
  if (
    !stock.minuteBars?.length ||
    !stock.minuteSource?.source ||
    !stock.minuteSource.hash
  )
    return [];
  const converted = hourlyBars(
    {
      id: stock.minuteSource.hash,
      hash: stock.minuteSource.hash,
      symbol: stock.symbol,
      source: stock.minuteSource.source,
      period: "5m",
      adjustment: "none",
      createdAt: 0,
      historicalAsOf: end,
      bars: stock.minuteBars,
    },
    Date.parse(`${end}T15:00:00+08:00`),
  );
  const byDate = new Map(converted.bars.map((b) => [b.date, b]));
  return calendar
    .filter((d) => d <= end && d >= stock.minuteBars![0]!.date.slice(0, 10))
    .flatMap((date) => {
      const index = calendar.indexOf(date),
        days = calendar.slice(Math.max(0, index - 5), index + 1);
      const hours = days.flatMap((d) =>
        ["10:30", "11:30", "14:00", "15:00"].map((t) =>
          byDate.get(`${d}T${t}:00+08:00`),
        ),
      );
      if (hours.length !== 24 || hours.some((h) => !h || h.volume <= 0))
        return [];
      return [
        {
          symbol: stock.symbol,
          date,
          source: `${stock.minuteSource!.source}/${stock.minuteSource!.hash}/a-share-hourly-1/历史收盘可知模型`,
          availableAt: `${date}T15:00:00+08:00`,
          adjustment: "none" as const,
          hours: hours as Bar[],
        },
      ];
    });
}
