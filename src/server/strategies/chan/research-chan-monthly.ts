import type { Snapshot } from "~/lib/domain";
import type { CalendarReference } from "../../market/data-health";
import type { CzscResult } from "~/lib/research/methods/chan/czsc";
import { monthlyBars } from "../../market/monthly-bars";

/** CH13 complete-month input. Signal evaluation belongs to the shared C4 prefix observer. */
export async function researchChanMonthlyInput(
  snapshot: Snapshot,
  calendar: CalendarReference & { availableAt: string },
  asOf: string,
  czsc: (bars: Snapshot["bars"], anchor: 3) => Promise<CzscResult>,
) {
  const cutoff = Date.parse(`${asOf}T15:05:00+08:00`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(asOf) ||
    !Number.isFinite(cutoff) ||
    new Date(asOf).toISOString().slice(0, 10) !== asOf ||
    !Number.isFinite(Date.parse(calendar.availableAt)) ||
    Date.parse(calendar.availableAt) > cutoff
  )
    return {
      status: "missing" as const,
      reason: "缺少当时可知的月线完整交易日历",
      aggregate: null,
      result: null,
    };
  const source = {
    ...snapshot,
    historicalAsOf: asOf,
    bars: snapshot.bars.filter((b) => b.date <= asOf),
  };
  const aggregate = monthlyBars(
    source,
    {
      ...calendar,
      days: calendar.days.filter((d) => d <= asOf),
      closedDays: calendar.closedDays?.filter((d) => d <= asOf),
    },
    cutoff,
  );
  if (
    !aggregate.bars.length ||
    aggregate.excluded.some((e) => e.reason !== "unfinished")
  )
    return {
      status: "missing" as const,
      reason: "缺少完整月线周期，不跳过缺月拼接",
      aggregate,
      result: null,
    };
  const first = source.bars[0]?.date.slice(0, 7);
  const current = new Date(asOf + "T00:00:00Z");
  const lastWeekday = new Date(
    Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 0),
  );
  while ([0, 6].includes(lastWeekday.getUTCDay()))
    lastWeekday.setUTCDate(lastWeekday.getUTCDate() - 1);
  const last =
    asOf >= lastWeekday.toISOString().slice(0, 10)
      ? asOf.slice(0, 7)
      : new Date(
          Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - 1, 1),
        )
          .toISOString()
          .slice(0, 7);
  const months = new Set(aggregate.bars.map((b) => b.date.slice(0, 7)));
  if (first)
    for (
      let m = new Date(first + "-01");
      m.toISOString().slice(0, 7) <= last;
      m.setUTCMonth(m.getUTCMonth() + 1)
    )
      if (!months.has(m.toISOString().slice(0, 7)))
        return {
          status: "missing" as const,
          reason: "月线整月缺失",
          aggregate,
          result: null,
        };
  const result = await czsc(aggregate.bars, 3);
  return {
    status: "input-ready" as const,
    reason:
      "monthly-anchor-v1完整月输入；本适配只返回结构，不产入场，统一C4观察器判定信号",
    aggregate,
    result,
  };
}
