import { createHash } from "node:crypto";
import type { Bar } from "~/lib/domain";
import { aggregateChartBars } from "~/lib/market/bar-aggregation";
import { aggregateCryptoBars } from "~/lib/market/crypto-aggregation";
import type {
  TripleScreenInput,
  TripleScreenSeries,
  TripleScreenVariant,
} from "trading-strategies";

type Source = {
  bars: Bar[];
  sourceHash: string;
  adjustmentId: string;
  priceScales?: Readonly<Record<string, number>>;
};
export type TheoryMultiperiodSource = {
  variant: TripleScreenVariant;
  market: "cn-equity" | "crypto";
  daily: Source;
  fiveMinute?: Source;
  tick: number | null;
  now: number;
  dailyFrom?: string;
  executionFrom?: string;
  calendar: { days: string[]; closedDays: string[]; hash: string };
};
const dayMs = 86400000;
const nextDay = (day: string) =>
  new Date(Date.parse(day) + dayMs).toISOString().slice(0, 10);
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Pure adaptation of frozen source arrays. No settings, database, network or source writes. */
export function theoryMultiperiodInputs(
  source: TheoryMultiperiodSource,
): TripleScreenInput {
  if (!Number.isFinite(source.now))
    throw new Error("Invalid multi-period cutoff");
  if (!source.daily.bars.length) throw new Error("Daily source is empty");
  if (source.daily.bars.some((bar) => !/^\d{4}-\d{2}-\d{2}$/.test(bar.date)))
    throw new Error("Daily source must use date-only labels");
  const cn = source.market === "cn-equity";
  const open = new Set(source.calendar.days),
    closed = new Set(source.calendar.closedDays);
  if (cn && (!source.calendar.hash || [...open].some((day) => closed.has(day))))
    throw new Error("Calendar identity missing or conflicting");
  const calendarHash = cn ? source.calendar.hash : hash("continuous-UTC-v1");
  const dailyByDate = new Map(source.daily.bars.map((b) => [b.date, b]));
  if (dailyByDate.size !== source.daily.bars.length)
    throw new Error("Duplicate daily source date");
  // Reuse source OHLC/order validation; strict expected slots below tighten the chart calendar policy.
  if (cn)
    aggregateChartBars(
      source.daily.bars,
      "day",
      "day",
      source.now,
      source.calendar,
    );
  else aggregateCryptoBars(source.daily.bars, "day", "day", source.now);
  const dailySlots: TripleScreenSeries["slots"][number][] = [];
  const first = source.dailyFrom ?? source.daily.bars[0]!.date.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(first) || !Number.isFinite(Date.parse(first)))
    throw new Error("Invalid daily coverage start");
  const last = new Date(source.now + (cn ? 8 * 3600000 : 0))
    .toISOString()
    .slice(0, 10);
  for (let day = first; day <= last; day = nextDay(day)) {
    const weekday = new Date(day).getUTCDay();
    if (cn && (weekday === 0 || weekday === 6 || closed.has(day))) continue;
    const availableAt = cn
      ? `${day}T15:00:00+08:00`
      : `${nextDay(day)}T00:00:00Z`;
    if (Date.parse(availableAt) > source.now) continue;
    const known = !cn || open.has(day);
    dailySlots.push({
      availableAt,
      priceScale: source.daily.priceScales?.[day],
      bar: known ? (dailyByDate.get(day) ?? null) : null,
      ...(!known
        ? { reason: "calendar-unknown" }
        : !dailyByDate.has(day)
          ? { reason: "missing-day" }
          : {}),
    });
  }
  const daily: TripleScreenSeries = {
    period: "day",
    sourceHash: source.daily.sourceHash,
    adjustmentId: source.daily.adjustmentId,
    calendarHash,
    slots: dailySlots,
  };
  if (source.variant === "week-day") {
    const aggregate = cn
      ? aggregateChartBars(
          source.daily.bars,
          "day",
          "week",
          source.now,
          source.calendar,
        )
      : aggregateCryptoBars(source.daily.bars, "day", "week", source.now);
    const byMonday = new Map(
      aggregate.bars.map((bar) => {
        const d = Date.parse(bar.date),
          weekday = new Date(d).getUTCDay();
        return [
          new Date(d - ((weekday + 6) % 7) * dayMs).toISOString().slice(0, 10),
          bar,
        ] as const;
      }),
    );
    const slots: TripleScreenSeries["slots"][number][] = [];
    const firstMonday = new Date(
      Date.parse(first) - ((new Date(first).getUTCDay() + 6) % 7) * dayMs,
    )
      .toISOString()
      .slice(0, 10);
    for (
      let monday = firstMonday;
      monday <= last;
      monday = new Date(Date.parse(monday) + 7 * dayMs)
        .toISOString()
        .slice(0, 10)
    ) {
      const friday = new Date(Date.parse(monday) + 4 * dayMs)
        .toISOString()
        .slice(0, 10);
      const end = new Date(Date.parse(monday) + 7 * dayMs)
        .toISOString()
        .slice(0, 10);
      const availableAt = cn ? `${friday}T15:05:00+08:00` : `${end}T00:00:00Z`;
      if (Date.parse(availableAt) > source.now) continue;
      let complete = true,
        expected = 0;
      for (
        let day = monday;
        day < (cn ? nextDay(friday) : end);
        day = nextDay(day)
      ) {
        if (cn && closed.has(day)) continue;
        expected++;
        if ((cn && !open.has(day)) || !dailyByDate.has(day)) complete = false;
      }
      if (expected === 0) continue;
      slots.push({
        availableAt,
        bar: complete ? (byMonday.get(monday) ?? null) : null,
        ...(!complete ? { reason: "incomplete-week-or-calendar" } : {}),
      });
    }
    return {
      variant: source.variant,
      market: source.market,
      tick: source.tick,
      execution: daily,
      setup: daily,
      background: {
        ...daily,
        period: "week",
        sourceHash: hash({
          source: source.daily.sourceHash,
          calendarHash,
          period: "week",
        }),
        slots,
      },
    };
  }
  const five = source.fiveMinute;
  if (!five?.bars.length) throw new Error("Five-minute source is empty");
  if (five.adjustmentId !== daily.adjustmentId)
    throw new Error("Daily and intraday adjustment identities disagree");
  const hourly = cn
    ? aggregateChartBars(five.bars, "5m", "60m", source.now, source.calendar)
    : aggregateCryptoBars(five.bars, "5m", "60m", source.now);
  const fiveMap = new Map(five.bars.map((b) => [Date.parse(b.date), b]));
  if (fiveMap.size !== five.bars.length)
    throw new Error("Duplicate intraday source time");
  const hourlyMap = new Map(hourly.bars.map((b) => [Date.parse(b.date), b]));
  const executionSlots: TripleScreenSeries["slots"][number][] = [];
  const hourlySlots: TripleScreenSeries["slots"][number][] = [];
  const startDate =
    source.executionFrom ??
    (cn
      ? five.bars[0]!.date.slice(0, 10)
      : new Date(Date.parse(five.bars[0]!.date) - 300000)
          .toISOString()
          .slice(0, 10));
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(startDate) ||
    !Number.isFinite(Date.parse(startDate))
  )
    throw new Error("Invalid execution coverage start");
  for (let day = startDate; day <= last; day = nextDay(day)) {
    const weekday = new Date(day).getUTCDay();
    if (cn && (weekday === 0 || weekday === 6 || closed.has(day))) continue;
    const known = !cn || open.has(day);
    const ends = cn
      ? Array.from({ length: 48 }, (_, i) =>
          i < 24 ? 575 + i * 5 : 785 + (i - 24) * 5,
        )
      : Array.from({ length: 288 }, (_, i) => (i + 1) * 5);
    for (const minute of ends) {
      const time =
        Date.parse(`${day}T00:00:00${cn ? "+08:00" : "Z"}`) + minute * 60000;
      if (time > source.now) continue;
      const availableAt = new Date(time).toISOString();
      executionSlots.push({
        availableAt,
        priceScale: fiveMap.get(time)
          ? five.priceScales?.[fiveMap.get(time)!.date]
          : undefined,
        bar: known ? (fiveMap.get(time) ?? null) : null,
        ...(!known
          ? { reason: "calendar-unknown" }
          : !fiveMap.has(time)
            ? { reason: "missing-five-minute" }
            : {}),
      });
      if (cn ? [630, 690, 840, 900].includes(minute) : minute % 60 === 0) {
        const complete =
          known &&
          Array.from({ length: 12 }, (_, i) => time - i * 300000).every((t) =>
            fiveMap.has(t),
          );
        hourlySlots.push({
          availableAt,
          bar: complete ? (hourlyMap.get(time) ?? null) : null,
          ...(!complete ? { reason: "incomplete-hour" } : {}),
        });
      }
    }
  }
  const shared = { adjustmentId: five.adjustmentId, calendarHash };
  return {
    variant: source.variant,
    market: source.market,
    tick: source.tick,
    background: daily,
    execution: {
      ...shared,
      period: "5m",
      sourceHash: five.sourceHash,
      slots: executionSlots,
    },
    setup: {
      ...shared,
      period: "60m",
      sourceHash: hash({
        source: five.sourceHash,
        calendarHash,
        period: "60m",
      }),
      slots: hourlySlots,
    },
  };
}
