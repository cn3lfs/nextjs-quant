import { createHash } from "node:crypto";
import type { Bar, Snapshot } from "~/lib/domain";
import type { CalendarReference } from "./data-health";
import { isAStock } from "../data-sources/tdx/tdx";

const validDate = (day: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(day) &&
  Number.isFinite(Date.parse(day)) &&
  new Date(day).toISOString().slice(0, 10) === day;
const shifted = (day: string, offset: number) =>
  new Date(Date.parse(day) + offset * 86400000).toISOString().slice(0, 10);

export function weeklyBars(
  snapshot: Snapshot,
  calendar: CalendarReference,
  now: number,
) {
  if (
    !isAStock(snapshot.symbol) ||
    snapshot.period !== "day" ||
    snapshot.adjustment !== "none"
  )
    throw new Error("周线聚合仅支持A股不复权日线");
  if (
    !Number.isFinite(now) ||
    (snapshot.historicalAsOf && !validDate(snapshot.historicalAsOf))
  )
    throw new Error("周线截止时间无效");
  const open = new Set(calendar.days),
    closed = new Set(calendar.closedDays ?? []);
  if (
    [...open, ...closed].some((day) => !validDate(day)) ||
    [...open].some((day) => closed.has(day))
  )
    throw new Error("周线参考日历日期无效或开闭市冲突");
  const groups = new Map<string, Bar[]>();
  let previous = "";
  for (const bar of snapshot.bars) {
    if (
      !validDate(bar.date) ||
      bar.date <= previous ||
      ![bar.open, bar.high, bar.low, bar.close, bar.volume, bar.amount].every(
        Number.isFinite,
      ) ||
      bar.low <= 0 ||
      bar.low > Math.min(bar.open, bar.close) ||
      bar.high < Math.max(bar.open, bar.close, bar.low) ||
      bar.volume < 0 ||
      bar.amount < 0
    )
      throw new Error("周线源数据日期、顺序或数值无效");
    previous = bar.date;
    const weekday = new Date(bar.date).getUTCDay();
    if (!weekday || weekday === 6)
      throw new Error("周线源数据包含非支持交易日");
    if (snapshot.historicalAsOf && bar.date > snapshot.historicalAsOf) continue;
    const monday = shifted(bar.date, 1 - weekday);
    const group = groups.get(monday) ?? [];
    group.push(bar);
    groups.set(monday, group);
  }
  const bars: Bar[] = [];
  const excluded: {
    week: string;
    reason:
      "unfinished" | "calendar-unknown" | "missing-days" | "calendar-conflict";
    dates: string[];
  }[] = [];
  for (const [monday, group] of groups) {
    const days = Array.from({ length: 5 }, (_, i) => shifted(monday, i));
    const friday = days[4]!;
    if (
      Date.parse(`${friday}T15:05:00+08:00`) > now ||
      (snapshot.historicalAsOf && friday > snapshot.historicalAsOf)
    ) {
      excluded.push({ week: monday, reason: "unfinished", dates: [] });
      continue;
    }
    const unknown = days.filter((day) => !open.has(day) && !closed.has(day));
    if (unknown.length || !calendar.hash) {
      excluded.push({
        week: monday,
        reason: "calendar-unknown",
        dates: unknown,
      });
      continue;
    }
    const conflicts = group
      .filter((bar) => !open.has(bar.date))
      .map((bar) => bar.date);
    if (conflicts.length) {
      excluded.push({
        week: monday,
        reason: "calendar-conflict",
        dates: conflicts,
      });
      continue;
    }
    const present = new Set(group.map((bar) => bar.date));
    const missing = days.filter((day) => open.has(day) && !present.has(day));
    if (missing.length) {
      excluded.push({ week: monday, reason: "missing-days", dates: missing });
      continue;
    }
    const bar = {
      date: group.at(-1)!.date,
      open: group[0]!.open,
      close: group.at(-1)!.close,
      high: Math.max(...group.map((b) => b.high)),
      low: Math.min(...group.map((b) => b.low)),
      volume: group.reduce((sum, b) => sum + b.volume, 0),
      amount: group.reduce((sum, b) => sum + b.amount, 0),
    };
    if (!Number.isFinite(bar.volume) || !Number.isFinite(bar.amount))
      throw new Error("周线聚合数值溢出");
    bars.push(bar);
  }
  const content = {
    version: "a-share-weekly-1",
    sourceId: snapshot.id,
    symbol: snapshot.symbol,
    source: snapshot.source,
    adjustment: snapshot.adjustment,
    historicalAsOf: snapshot.historicalAsOf ?? null,
    calendar: {
      source: calendar.source,
      hash: calendar.hash,
      days: [...open].sort(),
      closedDays: [...closed].sort(),
    },
    bars,
    excluded,
  };
  return {
    ...content,
    hash: createHash("sha256").update(JSON.stringify(content)).digest("hex"),
    warnings: [
      "完整性相对于所提供参考日历，不代表官方交易状态核验；整周缺失还需另外检查",
      "周内任一工作日未知则不聚合，不将缺少指数记录擅自当作休市",
      "不复权行情，企业行动影响尚未排除",
    ],
  };
}
