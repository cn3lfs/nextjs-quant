import type { Bar } from "../src/lib/domain";
import {
  rpsPeriods,
  rpsPolicy,
  type RpsDay,
  type RpsProgress,
} from "../src/lib/rps";
import {
  calculateRpsDay,
  prepareRpsSecurity,
} from "../src/server/screening/rps-engine";
import type { RpsDependencies } from "../src/server/screening/rps-job";

export const rpsCalendar = Array.from({ length: 801 }, (_, i) =>
  new Date(Date.UTC(2022, 0, 1 + i)).toISOString().slice(0, 10),
).filter((d) => ![0, 6].includes(new Date(d).getUTCDay()));
export const rpsDate = rpsCalendar[520]!;
export function rpsBars(gain = 0): Bar[] {
  return rpsCalendar.map((date, i) => {
    const close = i >= 520 ? 10 + gain : 10;
    return {
      date,
      open: close,
      high: close,
      low: close,
      close,
      volume: 100,
      amount: close * 100,
    };
  });
}
export function tenStocks() {
  return Array.from({ length: 10 }, (_, i) =>
    prepareRpsSecurity(
      `sz00000${i}`,
      `样本${i}`,
      rpsBars(i),
      [],
      rpsCalendar[0]!,
    ),
  );
}
export function rpsDay(date = rpsDate): {
  day: RpsDay;
  rows: ReturnType<typeof calculateRpsDay>["rows"];
} {
  const result = calculateRpsDay(tenStocks(), rpsCalendar, date);
  return {
    day: {
      date,
      mode: "backfill",
      periods: [...rpsPeriods],
      policy: rpsPolicy,
      total: 10,
      pool: result.pool,
      counts: result.counts,
      missing: result.missing,
      excluded: result.excluded,
      inputHash: result.inputHash,
      source: {
        root: "fixture",
        calendar: "fixture",
        calendarHash: "calendar",
        actionsHash: "actions",
        actionsCoverage: date,
        universeHash: "universe",
      },
      createdAt: 1,
    },
    rows: result.rows,
  };
}
export function rpsProgress(): RpsProgress {
  return {
    id: crypto.randomUUID(),
    mode: "backfill",
    status: "running",
    phase: "start",
    scanned: 0,
    total: 0,
    completedDays: 0,
    totalDays: 0,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
}
export function rpsDeps(): RpsDependencies {
  return {
    root: "fixture",
    calendar: async () => ({ days: rpsCalendar, source: "fixture" }),
    universe: async () =>
      tenStocks().map(({ symbol, name }) => ({ symbol, name })),
    bars: async (symbol) => rpsBars(Number(symbol.at(-1))),
    actions: async () => ({
      events: new Map([
        [
          "sz000000",
          [{ date: rpsCalendar.at(-1)!, category: 2, name: "股本变化" }],
        ],
      ]),
      source: "fixture",
    }),
  };
}
