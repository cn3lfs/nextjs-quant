import { createHash } from "node:crypto";
import type { Bar, Snapshot } from "~/lib/domain";
import { isAStock } from "./tdx";

// A-share continuous-session buckets; source timestamps are five-minute ends.
const starts = [570, 630, 780, 840];
const stamp = (day: string, minute: number) =>
  `${day}T${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00+08:00`;

export function hourlyBars(snapshot: Snapshot, now: number) {
  if (!Number.isFinite(now)) throw new Error("小时线截止时间无效");
  if (
    !isAStock(snapshot.symbol) ||
    snapshot.period !== "5m" ||
    snapshot.adjustment !== "none"
  )
    throw new Error("小时聚合仅支持A股不复权五分钟行情");
  const cutoff = snapshot.historicalAsOf;
  if (
    cutoff &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff) ||
      !Number.isFinite(Date.parse(cutoff)) ||
      new Date(cutoff).toISOString().slice(0, 10) !== cutoff)
  )
    throw new Error("小时线历史截止日无效");
  const groups = new Map<string, Bar[]>();
  let previous = -Infinity;
  for (const bar of snapshot.bars) {
    const time = Date.parse(bar.date);
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+08:00$/.test(bar.date) ||
      !Number.isFinite(time) ||
      new Date(time + 8 * 3600000).toISOString().slice(0, 19) !==
        bar.date.slice(0, 19) ||
      time <= previous ||
      ![bar.open, bar.high, bar.low, bar.close, bar.volume, bar.amount].every(
        Number.isFinite,
      ) ||
      bar.low <= 0 ||
      bar.low > Math.min(bar.open, bar.close) ||
      bar.high < Math.max(bar.open, bar.close, bar.low) ||
      bar.volume < 0 ||
      bar.amount < 0
    )
      throw new Error("小时线源数据日期、顺序或数值无效");
    previous = time;
    const day = bar.date.slice(0, 10);
    const minute =
      Number(bar.date.slice(11, 13)) * 60 + Number(bar.date.slice(14, 16));
    const start = starts.find(
      (start) => minute > start && minute <= start + 60,
    );
    const weekday = new Date(day).getUTCDay();
    if (start === undefined || minute % 5 || weekday === 0 || weekday === 6)
      throw new Error("小时线源数据不在支持的A股五分钟时段");
    if (cutoff && day > cutoff) continue;
    const end = stamp(day, start + 60);
    const group = groups.get(end) ?? [];
    group.push(bar);
    groups.set(end, group);
  }
  const bars: Bar[] = [];
  const excluded: {
    end: string;
    reason: "unfinished" | "missing-bars";
    records: number;
  }[] = [];
  for (const [end, group] of groups) {
    if (Date.parse(end) > now || group.length !== 12) {
      excluded.push({
        end,
        reason: Date.parse(end) > now ? "unfinished" : "missing-bars",
        records: group.length,
      });
      continue;
    }
    const result = {
      date: end,
      open: group[0]!.open,
      close: group.at(-1)!.close,
      high: Math.max(...group.map((b) => b.high)),
      low: Math.min(...group.map((b) => b.low)),
      volume: group.reduce((sum, bar) => sum + bar.volume, 0),
      amount: group.reduce((sum, bar) => sum + bar.amount, 0),
    };
    if (!Number.isFinite(result.volume) || !Number.isFinite(result.amount))
      throw new Error("小时线聚合数值溢出");
    bars.push(result);
  }
  const content = {
    version: "a-share-hourly-1",
    sourceId: snapshot.id,
    symbol: snapshot.symbol,
    source: snapshot.source,
    adjustment: snapshot.adjustment,
    historicalAsOf: cutoff ?? null,
    bars,
    excluded,
  };
  return {
    ...content,
    hash: createHash("sha256").update(JSON.stringify(content)).digest("hex"),
    warnings: [
      "仅核验已出现小时内12根记录完整；整小时或整日缺失、停牌及交易日历尚需另行核验",
      "不复权行情，企业行动影响尚未排除",
    ],
  };
}
