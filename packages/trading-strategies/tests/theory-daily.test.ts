import { expect, it } from "vitest";
import type { Bar } from "trading-strategy-core/bars";
import { createTheoryDailyRule, theoryDailyIds } from "../src/theory-daily.js";
import { studyCatalog, studyStrategies } from "../src/study-catalog.js";

const flat = () =>
  Array.from({ length: 130 }, (_, i): Bar => ({
    date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
    open: 100,
    high: 102,
    low: 98,
    close: 100,
    volume: 1000,
    amount: 100000,
  }));
const set = (bars: Bar[], i: number, patch: Partial<Bar>) =>
  Object.assign(bars[i]!, patch);
const noPosition = { entry: 0, entryIndex: 0 };
const signal = (id: string, bars: Bar[], i = 100) =>
  createTheoryDailyRule(id, bars)!(i, noPosition).enter;

it("integrates distinct proxy IDs without replacing existing studies", () => {
  expect(new Set(studyStrategies).size).toBe(studyStrategies.length);
  expect(theoryDailyIds).toHaveLength(16);
  for (const id of theoryDailyIds)
    expect(studyCatalog[id].rule).toContain("退出");
  expect(studyCatalog.turtle.name).toContain("海龟");
});

it.each(["theory-nr4-close", "theory-nr7-close"])(
  "%s rejects ties and double-sided bars",
  (id) => {
    const bars = flat();
    set(bars, 99, { high: 101, low: 99 });
    set(bars, 100, { open: 100, high: 104, low: 99, close: 103 });
    expect(signal(id, bars)).toBe(true);
    set(bars, 100, { low: 98 });
    expect(signal(id, bars)).toBe(false);
    set(bars, 100, { low: 99 });
    set(bars, 98, { high: 101, low: 99 });
    expect(signal(id, bars)).toBe(false);
  },
);

it("inside mother range uses the completed mother and consumes only the next close", () => {
  const bars = flat();
  set(bars, 99, { high: 101, low: 99 });
  set(bars, 100, { open: 100, low: 98, high: 104, close: 103 });
  expect(signal("theory-inside-close", bars)).toBe(true);
  set(bars, 99, { high: 102 });
  expect(signal("theory-inside-close", bars)).toBe(false);
});

it("pin needs pre-existing support and a later confirming close", () => {
  const bars = flat();
  set(bars, 99, { open: 100.5, close: 101, high: 101.1, low: 98 });
  set(bars, 100, { open: 101, close: 102, high: 103, low: 100 });
  expect(signal("theory-pin-confirm", bars, 99)).toBe(false);
  expect(signal("theory-pin-confirm", bars)).toBe(true);
  set(bars, 99, { low: 95 });
  expect(signal("theory-pin-confirm", bars)).toBe(false);
});

it("engulf confirms after a down sequence without backdating the signal", () => {
  const bars = flat();
  set(bars, 96, { close: 103, high: 104 });
  set(bars, 97, { close: 102, high: 103 });
  set(bars, 98, { open: 102, close: 100, high: 103, low: 99 });
  set(bars, 99, { open: 99.5, close: 102.5, high: 103, low: 99 });
  set(bars, 100, { open: 103, close: 104, high: 105, low: 100 });
  expect(signal("theory-engulf-confirm", bars)).toBe(true);
  set(bars, 100, { close: 102.9 });
  expect(signal("theory-engulf-confirm", bars)).toBe(false);
});

it("spring must reclaim a bounded prior range and confirm below its upper edge", () => {
  const bars = flat();
  set(bars, 99, { open: 99, low: 97, high: 100, close: 99 });
  set(bars, 100, { open: 99, low: 98, high: 102, close: 101 });
  expect(signal("theory-spring-confirm", bars)).toBe(true);
  set(bars, 100, { close: 102 });
  expect(signal("theory-spring-confirm", bars)).toBe(false);
});

it("volume dry-up compares both sessions to the same prior volume window", () => {
  const bars = flat();
  set(bars, 99, { volume: 400 });
  set(bars, 100, { open: 101, close: 103, high: 104, low: 100, volume: 1600 });
  expect(signal("theory-dryup-breakout", bars)).toBe(true);
  set(bars, 99, { volume: 1000 });
  expect(signal("theory-dryup-breakout", bars)).toBe(false);
});

it("gap continuation keeps the gap floor and needs a second-session close", () => {
  const bars = flat();
  set(bars, 99, { open: 103, low: 103, high: 105, close: 104 });
  set(bars, 100, { open: 104, low: 103, high: 107, close: 106 });
  expect(signal("theory-gap-continuation", bars)).toBe(true);
  set(bars, 100, { low: 102 });
  expect(signal("theory-gap-continuation", bars)).toBe(false);
});

it("box formation freezes the edge before the release session", () => {
  const bars = flat();
  set(bars, 81, { open: 101, close: 103, high: 104, low: 100 });
  expect(signal("theory-box20", bars, 80)).toBe(false);
  expect(signal("theory-box20", bars, 81)).toBe(true);
  set(bars, 81, { close: 100, high: 102 });
  set(bars, 85, { open: 101, close: 103, high: 104, low: 100 });
  expect(signal("theory-box20", bars, 85)).toBe(true);
  const shifted = [{ ...bars[0]!, date: "2019-12-31" }, ...bars];
  expect(signal("theory-box20", shifted, 86)).toBe(true);
  expect(signal("theory-box20", bars.slice(65), 20)).toBe(true);
  set(bars, 84, { high: 106 });
  expect(signal("theory-box20", bars, 85)).toBe(false);
});

it("squeeze freezes its preparation high rather than including the release bar", () => {
  const bars = flat();
  set(bars, 100, { open: 100, high: 131, low: 99, close: 130 });
  expect(signal("theory-squeeze", bars)).toBe(true);
  set(bars, 100, { high: 102, close: 101 });
  expect(signal("theory-squeeze", bars)).toBe(false);
});

it.each(["theory-boll-reentry", "theory-zscore-reentry"])(
  "%s waits for recovery rather than buying a falling extreme",
  (id) => {
    const bars = flat();
    set(bars, 99, { open: 100, close: 90, low: 89 });
    set(bars, 100, { open: 90, close: 98, high: 100, low: 90 });
    expect(signal(id, bars, 99)).toBe(false);
    expect(signal(id, bars)).toBe(true);
    set(bars, 100, { close: 89, low: 88 });
    expect(signal(id, bars)).toBe(false);
  },
);

it("fixed protective exit uses the actual signal, including a delayed fill", () => {
  const bars = flat();
  set(bars, 99, { high: 101, low: 99 });
  set(bars, 100, { open: 100, high: 104, low: 99, close: 103 });
  set(bars, 104, { open: 100, close: 98, low: 97, high: 101 });
  const rule = createTheoryDailyRule("theory-nr4-close", bars)!;
  expect(rule(104, { entry: 103, entryIndex: 103, signalIndex: 100 })).toEqual({
    enter: false,
    exit: true,
  });
  expect(rule(104, noPosition).exit).toBe(false);
});

it.each(theoryDailyIds)(
  "%s preserves every prefix and has a finite maximum holding period",
  (id) => {
    const bars = flat();
    for (let i = 0; i < bars.length; i++) {
      const price = 100 + 5 * Math.sin(i * 0.3) + i * 0.02;
      set(bars, i, {
        open: price,
        close: price + Math.sin(i),
        high: price + 2,
        low: price - 2,
        volume: 1000 + i * 7,
      });
    }
    const rule = createTheoryDailyRule(id, bars)!;
    for (let i = 70; i < 120; i++)
      expect(rule(i, noPosition)).toEqual(
        createTheoryDailyRule(id, bars.slice(0, i + 1))!(i, noPosition),
      );
    expect(rule(120, { entry: 100, entryIndex: 75 }).exit).toBe(true);
    expect(rule(69, noPosition)).toEqual({ enter: false, exit: false });
  },
);

it("trend reclaim and oscillator recoveries keep distinct confirmations", () => {
  const base = flat();
  for (let i = 70; i < base.length; i++)
    set(base, i, { open: 130, high: 132, low: 128, close: 130 });
  set(base, 99, { open: 130, close: 118, low: 117 });
  for (const [id, close, low] of [
    ["theory-bias-reclaim", 123, 118],
    ["theory-cci-reclaim", 129, 128],
    ["theory-williams-reclaim", 122, 118],
    ["theory-ema-reclaim", 131, 128],
  ] as const) {
    const bars = structuredClone(base);
    set(bars, 100, { open: low, high: close + 1, low, close });
    expect(signal(id, bars), id).toBe(true);
    set(bars, 100, { open: 118, high: 119, low: 116, close: 117 });
    expect(signal(id, bars), id).toBe(false);
  }
});
