import type { Snapshot } from "~/lib/domain";
import type { CalendarReference } from "./data-health";
import { weeklyBars } from "./weekly-bars";

const shift = (day: string, days: number) =>
  new Date(Date.parse(day) + days * 86400000).toISOString().slice(0, 10);
const monday = (day: string) =>
  shift(day, 1 - (new Date(day).getUTCDay() || 7));

/** A window of trading weeks, not the last N surviving aggregates. Fully
 * closed weeks may be skipped only with explicit evidence for all five days. */
export function researchStructureWeekly(
  snapshot: Snapshot,
  calendar: CalendarReference,
  asOf: string,
  count: number,
) {
  if (!Number.isInteger(count) || count < 2 || count > 104)
    throw new Error("周线窗口须为2至104周");
  const cutoff = Date.parse(`${asOf}T15:05:00+08:00`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(asOf) ||
    !Number.isFinite(cutoff) ||
    new Date(`${asOf}T00:00:00Z`).toISOString().slice(0, 10) !== asOf
  )
    throw new Error("周线观察日期无效");
  if (snapshot.historicalAsOf && snapshot.historicalAsOf < asOf)
    throw new Error("周线源快照截止日期早于观察日");
  // Slice before aggregation: a later corrupt/revised bar cannot change this prefix.
  const source = {
    ...snapshot,
    historicalAsOf: asOf,
    bars: snapshot.bars.filter((bar) => bar.date <= asOf),
  };
  const reference = {
    ...calendar,
    days: calendar.days.filter((day) => day <= asOf),
    closedDays: calendar.closedDays?.filter((day) => day <= asOf),
  };
  const aggregate = weeklyBars(source, reference, cutoff);
  const open = new Set(reference.days),
    closed = new Set(reference.closedDays);
  const byWeek = new Map(aggregate.bars.map((bar) => [monday(bar.date), bar]));
  const gaps: { week: string; reason: string; dates: string[] }[] = [];
  const selected: {
    week: string;
    completedAt: string;
    bar: Snapshot["bars"][number];
  }[] = [];
  let week = monday(asOf);
  if (shift(week, 4) > asOf) week = shift(week, -7);
  let slots = 0;
  // Bound scanning even for an entirely closed or unknown calendar.
  for (
    let scanned = 0;
    slots < count && scanned < count + 104;
    scanned++, week = shift(week, -7)
  ) {
    const dates = Array.from({ length: 5 }, (_, i) => shift(week, i));
    if (dates.every((day) => closed.has(day))) continue;
    slots++;
    const unknown = dates.filter((day) => !open.has(day) && !closed.has(day));
    const bar = byWeek.get(week);
    if (unknown.length || !reference.hash || !reference.source.trim())
      gaps.push({ week, reason: "周日历或来源缺失", dates: unknown });
    else if (
      !bar ||
      bar.volume <= 0 ||
      source.bars.some((b) => monday(b.date) === week && b.volume <= 0)
    )
      gaps.push({
        week,
        reason: "交易周缺失、缺日或无有效成交量",
        dates: dates.filter((d) => open.has(d)),
      });
    else
      selected.push({
        week,
        completedAt: `${shift(week, 4)}T15:05:00+08:00`,
        bar,
      });
  }
  if (slots < count)
    gaps.push({ week, reason: "连续交易周窗口不足", dates: [] });
  selected.reverse();
  return {
    version: "research-completed-trading-weeks-1" as const,
    status: gaps.length ? ("missing" as const) : ("ready" as const),
    asOf,
    count,
    source: snapshot.source,
    sourceId: snapshot.id,
    adjustment: snapshot.adjustment,
    calendar: reference,
    aggregateHash: aggregate.hash,
    gaps,
    // Never hand a compressed window to the structural consumer.
    weeks: gaps.length ? [] : selected,
    reason: gaps.length ? "缺少连续有效已完成交易周；不得跨缺周拼接" : null,
    availabilityModel: "周五15:05完成K线回放模型，不证明供应商历史发布延迟",
  };
}
