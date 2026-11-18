import { expect, it } from "vitest";
import { suggestFiveMinuteWindow } from "~/lib/backtest/coverage-window";
import {
  maBaselineInputSchema,
  replayFiveMinute,
  strategyExperimentWarmup,
} from "quant-backtest";
import type { Bar } from "trading-strategy-core/bars";

const day = (date: string): Bar[] =>
  Array.from({ length: 48 }, (_, i) => {
    const minutes = i < 24 ? 575 + i * 5 : 785 + (i - 24) * 5;
    return {
      date: `${date}T${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00+08:00`,
      open: 10,
      high: 11,
      low: 9,
      close: 10,
      volume: 1000,
      amount: 10000,
    };
  });
it("uses the next complete session after real warmup, and that window passes the actual engine guard", () => {
  const bars = [...day("2026-10-09"), ...day("2026-10-12")];
  const before = structuredClone(bars);
  const warmup = strategyExperimentWarmup(
    maBaselineInputSchema.parse({
      symbol: "sh600000",
      start: "2026-10-09",
      end: "2026-10-12",
    }),
  );
  const window = suggestFiveMinuteWindow(bars, warmup);
  expect(window).toEqual({
    warmupBars: 20,
    runnableWindows: [{ start: "2026-10-12", end: "2026-10-12" }],
    earliestStart: "2026-10-12",
    suggestedStart: "2026-10-12",
    suggestedEnd: "2026-10-12",
    unavailableReason: null,
  });
  const input = maBaselineInputSchema.parse({
    symbol: "sh600000",
    start: window.suggestedStart,
    end: window.suggestedEnd,
  });
  expect(replayFiveMinute(input, bars).evaluated).toBe(48);
  expect(() =>
    replayFiveMinute({ ...input, start: "2026-10-09" }, bars),
  ).toThrow("20 根预热");
  expect(bars).toEqual(before);
});
it("counts prefixes for larger factor lookbacks instead of treating a nonempty source as runnable", () => {
  const two = [...day("2026-10-09"), ...day("2026-10-12")];
  expect(suggestFiveMinuteWindow(two, 60)).toMatchObject({
    suggestedStart: null,
    suggestedEnd: null,
    earliestStart: null,
  });
  expect(suggestFiveMinuteWindow(two, 60).unavailableReason).toContain("60 根");
  expect(
    suggestFiveMinuteWindow([...two, ...day("2026-10-13")], 60).suggestedStart,
  ).toBe("2026-10-13");
});
it("uses an actual session at or after the month threshold rather than inventing a weekend start", () => {
  const dates: string[] = [];
  for (
    let ms = Date.parse("2026-09-01T00:00:00Z");
    ms <= Date.parse("2026-10-12T00:00:00Z");
    ms += 86400000
  ) {
    const date = new Date(ms);
    if (![0, 6].includes(date.getUTCDay()))
      dates.push(date.toISOString().slice(0, 10));
  }
  expect(suggestFiveMinuteWindow(dates.flatMap(day), 20)).toMatchObject({
    earliestStart: "2026-09-02",
    suggestedStart: "2026-09-14",
    suggestedEnd: "2026-10-12",
  });
});
it("does not suggest an incomplete tail or allow duplicate observations to impersonate a complete day", () => {
  const two = [...day("2026-10-09"), ...day("2026-10-12")];
  expect(
    suggestFiveMinuteWindow([...two, ...day("2026-10-13").slice(0, 47)], 20)
      .suggestedEnd,
  ).toBe("2026-10-12");
  const duplicate = structuredClone(two);
  duplicate[60]!.date = duplicate[59]!.date;
  expect(() => suggestFiveMinuteWindow(duplicate, 20)).toThrow("严格递增");
});
it("leaves dates unset when no full date-only window exists", () => {
  for (const bars of [[], day("2026-10-09"), day("2026-10-09").slice(0, 20)])
    expect(suggestFiveMinuteWindow(bars, 20).suggestedStart).toBeNull();
  expect(() => suggestFiveMinuteWindow([], -1)).toThrow("非负整数");
  expect(() => suggestFiveMinuteWindow([], 1.5)).toThrow("非负整数");
});

it("requires the exact neighboring warmup tail, not merely enough preceding observations", () => {
  const bars = [...day("2026-10-09").slice(0, 47), ...day("2026-10-12")];
  expect(suggestFiveMinuteWindow(bars, 20)).toMatchObject({
    runnableWindows: [],
    suggestedStart: null,
    suggestedEnd: null,
  });
});
it("does not default across an incomplete interior session", () => {
  const bars = [
    ...day("2026-10-09"),
    ...day("2026-10-12"),
    ...day("2026-10-13").slice(0, 47),
    ...day("2026-10-14"),
  ];
  expect(suggestFiveMinuteWindow(bars, 20)).toMatchObject({
    runnableWindows: [{ start: "2026-10-12", end: "2026-10-12" }],
    suggestedStart: "2026-10-12",
    suggestedEnd: "2026-10-12",
  });
});
it("allows missing old observations outside the required tail, and starts a new valid segment after that day", () => {
  const morningMissing = [...day("2026-10-09").slice(1), ...day("2026-10-12")];
  expect(suggestFiveMinuteWindow(morningMissing, 20)).toMatchObject({
    suggestedStart: "2026-10-12",
    suggestedEnd: "2026-10-12",
  });
  const interior = [
    ...day("2026-10-09"),
    ...day("2026-10-12"),
    ...day("2026-10-13").slice(1),
    ...day("2026-10-14"),
  ];
  expect(suggestFiveMinuteWindow(interior, 20)).toMatchObject({
    runnableWindows: [
      { start: "2026-10-12", end: "2026-10-12" },
      { start: "2026-10-14", end: "2026-10-14" },
    ],
    suggestedStart: "2026-10-14",
    suggestedEnd: "2026-10-14",
  });
});
