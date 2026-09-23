import { expect, it } from "vitest";
import type { Snapshot } from "~/lib/domain";
import { wyckoffFrames } from "~/server/strategies/wyckoff/wyckoff-frames";
import {
  wyckoffPromptFrames,
  wyckoffBarColumns,
} from "~/server/strategies/wyckoff/wyckoff-prompt-frames";
const dates = Array.from(
  { length: 14 },
  (_, i) => new Date(Date.UTC(2026, 7, 24 + i)),
)
  .filter((date) => ![0, 6].includes(date.getUTCDay()))
  .map((date) => date.toISOString().slice(0, 10));
const bar = (date: string) => ({
  date,
  open: 10,
  high: 12,
  low: 9,
  close: 11,
  volume: 10,
  amount: 100,
});
const day: Snapshot = {
  id: "day",
  symbol: "sh600519",
  source: "fixture",
  period: "day",
  adjustment: "none",
  hash: "untrusted",
  createdAt: 1,
  bars: dates.map(bar),
};
const minute: Snapshot = {
  ...day,
  id: "minute",
  period: "5m",
  bars: dates.flatMap((date) =>
    [570, 630, 780, 840].flatMap((start) =>
      Array.from({ length: 12 }, (_, i) => {
        const time = start + (i + 1) * 5;
        return bar(
          `${date}T${String(Math.floor(time / 60)).padStart(2, "0")}:${String(time % 60).padStart(2, "0")}:00+08:00`,
        );
      }),
    ),
  ),
};
const calendar = { days: dates, source: "fixture", hash: "hash" };
const now = Date.parse("2026-09-04T15:05:00+08:00");
it("round-trips usable prompt rows and omits only unavailable hourly prices", () => {
  const frames = wyckoffFrames(day, minute, calendar, now);
  const before = structuredClone(frames);
  const prompt = wyckoffPromptFrames(frames);
  for (const key of ["daily", "weekly", "hourly"] as const) {
    expect(
      prompt[key].bars.map((row) =>
        Object.fromEntries(
          wyckoffBarColumns.map((column, i) => [column, row[i]]),
        ),
      ),
    ).toEqual(frames[key].bars);
  }
  const stale = wyckoffFrames(
    day,
    { ...minute, bars: minute.bars.slice(0, -48) },
    calendar,
    now,
  );
  const projected = wyckoffPromptFrames(stale);
  expect(projected.hourly.bars).toEqual([]);
  expect(projected.hourly.archivedBarCount).toBe(stale.hourly.bars.length);
  expect(projected.hourly.missingHours).toEqual(stale.hourly.missingHours);
  expect(projected.hourly.status).toBe("stale");
  expect(frames).toEqual(before);
});
it("aligns complete hourly samples to the daily cutoff without asserting trading readiness", () => {
  const before = structuredClone({ day, minute });
  const result = wyckoffFrames(day, minute, calendar, now);
  expect(result.hourly.status).toBe("aligned");
  expect(result.hourly.bars).toHaveLength(40);
  expect(result.daily.insufficient).toBe(true);
  expect(result.weekly.insufficient).toBe(true);
  expect(result.automaticSignals).toBe(false);
  expect({ day, minute }).toEqual(before);
});
it("detects stale hours, entire missing hours, absent inputs and mismatched symbols", () => {
  const stale = { ...minute, bars: minute.bars.slice(0, -48) };
  expect(wyckoffFrames(day, stale, calendar, now).hourly.status).toBe("stale");
  const gap = { ...minute, bars: minute.bars.slice(12) };
  const result = wyckoffFrames(day, gap, calendar, now);
  expect(result.hourly.status).toBe("gaps");
  expect(result.hourly.missingHours).toEqual([`${dates[0]}T10:30:00+08:00`]);
  expect(result.hourly.noHourly).toBe(true);
  expect(wyckoffFrames(day, null, calendar, now).hourly.status).toBe(
    "unavailable",
  );
  expect(() =>
    wyckoffFrames(day, { ...minute, symbol: "sz000001" }, calendar, now),
  ).toThrow();
});
it("cuts all frames at the historical day and does not admit later minute bars", () => {
  const historical = { ...day, historicalAsOf: "2026-09-03" };
  const result = wyckoffFrames(historical, minute, calendar, now);
  expect(result.asOf).toBe("2026-09-03");
  expect(result.hourly.asOf).toBe("2026-09-03T15:00:00+08:00");
  expect(result.weekly.bars.at(-1)?.date).toBe("2026-08-28");
  expect(result.hash).not.toBe(wyckoffFrames(day, minute, calendar, now).hash);
});
