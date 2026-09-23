import { createHash } from "node:crypto";
import type { Snapshot } from "~/lib/domain";
import type { CalendarReference } from "../../market/data-health";
import { weeklyBars } from "../../market/weekly-bars";
import { hourlyBars } from "../../market/hourly-bars";
import { completedBarFilter } from "trading-strategy-core/completed-bars";

/** A frozen daily research cutoff, not an intraday trading-timeframe assertion. */
export function wyckoffFrames(
  day: Snapshot,
  minute: Snapshot | null,
  calendar: CalendarReference,
  now: number,
) {
  // Validate all daily records before choosing a window.
  weeklyBars(day, calendar, now);
  const completed = completedBarFilter("day", now);
  const daily = day.bars.filter(
    (bar) =>
      completed(bar.date) &&
      (!day.historicalAsOf || bar.date <= day.historicalAsOf),
  );
  const asOf = daily.at(-1)?.date;
  if (!asOf) throw new Error("威科夫研究没有已完成日线");
  const frozen = Date.parse(`${asOf}T15:05:00+08:00`);
  const weekly = weeklyBars({ ...day, historicalAsOf: asOf }, calendar, frozen);
  if (
    minute &&
    (minute.symbol !== day.symbol ||
      (minute.historicalAsOf && minute.historicalAsOf < asOf))
  )
    throw new Error("小时来源证券或历史截止日与日线不一致");
  const hourly = minute
    ? hourlyBars({ ...minute, historicalAsOf: asOf }, frozen)
    : null;
  const days = [...new Set(calendar.days.filter((date) => date <= asOf))]
    .sort()
    .slice(-30);
  const hours = hourly?.bars.slice(-120) ?? [];
  const present = new Set(hours.map((bar) => bar.date));
  const expected = days.flatMap((date) =>
    ["10:30", "11:30", "14:00", "15:00"].map(
      (time) => `${date}T${time}:00+08:00`,
    ),
  );
  const missingHours = expected.filter((date) => !present.has(date));
  const hourlyAsOf = hours.at(-1)?.date ?? null;
  const status = !minute
    ? "unavailable"
    : !hours.length
      ? "insufficient"
      : hourlyAsOf !== `${asOf}T15:00:00+08:00`
        ? "stale"
        : !calendar.hash || days.at(-1) !== asOf
          ? "calendar-unknown"
          : missingHours.length
            ? "gaps"
            : hours.length < 30
              ? "insufficient"
              : "aligned";
  const dayWindow = daily.slice(-120).map((bar) => ({ ...bar }));
  const first = dayWindow[0]!.date;
  const presentDays = new Set(dayWindow.map((bar) => bar.date));
  const missingDays = calendar.days.filter(
    (date) => date >= first && date <= asOf && !presentDays.has(date),
  );
  const weeks = weekly.bars.slice(-52);
  const content = {
    version: "wyckoff-frames-1",
    symbol: day.symbol,
    asOf,
    cutoff: frozen,
    adjustment: day.adjustment,
    daily: {
      sourceId: day.id,
      source: day.source,
      bars: dayWindow,
      insufficient: dayWindow.length < 30,
      missingDays,
    },
    weekly: {
      sourceId: day.id,
      bars: weeks,
      insufficient: weeks.length < 30,
      excluded: weekly.excluded,
      hash: weekly.hash,
    },
    hourly: {
      sourceId: minute?.id ?? null,
      source: minute?.source ?? null,
      bars: hours,
      asOf: hourlyAsOf,
      status,
      noHourly: status !== "aligned",
      missingHours,
      excluded: hourly?.excluded ?? [],
      hash: hourly?.hash ?? null,
    },
    calendar: weekly.calendar,
    automaticSignals: false,
    warnings: [
      "全部周期冻结于最后已完成日线，不代表实时行情；日线本身是否陈旧须单独核验",
      "小时aligned仅表示对所给参考日历时点和样本完整性对齐，不代表走势方向一致或入场信号",
      "周线排除项与缺口须保留展示，不得把剩余周线视为无缺口连续样本",
      "参考日历、停牌及企业行动尚未全面核验；仅用于不复权研究",
    ],
  };
  return {
    ...content,
    hash: createHash("sha256").update(JSON.stringify(content)).digest("hex"),
  };
}
