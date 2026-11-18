import { describe, expect, it } from "vitest";
import type { Bar } from "trading-strategy-core/bars";
import {
  buildUtcOrbSessions,
  createUtcOrbRule,
  utcOrbSessionBars,
  utcOrbShiftDay,
  utcOrbSlotIndex,
  utcOrbSlotLabel,
  type UtcOrbInput,
} from "../src/theory-orb.js";
import {
  prepareStrategy,
  strategyObjectSchema,
} from "../src/strategy-object.js";
import { utcOrbStrategy } from "../src/theory-strategy.js";

const startDay = "2026-10-01";
const days = Array.from({ length: 13 }, (_, i) => utcOrbShiftDay(startDay, i));
const target = days.at(-1)!;

function bar(date: string, close: number): Bar {
  return {
    date,
    open: close,
    high: close + 0.5,
    low: close - 0.5,
    close,
    volume: 10,
    amount: 1000,
  };
}

function dayBars(day: string, closes: Record<number, number> = {}): Bar[] {
  return Array.from({ length: utcOrbSessionBars }, (_, slot) =>
    bar(utcOrbSlotLabel(day, slot), closes[slot] ?? 100),
  );
}

function fullBars(overrides: Record<string, Record<number, number>> = {}) {
  return days.flatMap((day) => dayBars(day, overrides[day] ?? {}));
}

function orbInput(bars: readonly Bar[], warmupDays = 10): UtcOrbInput {
  const sessions = buildUtcOrbSessions(bars);
  return {
    market: "crypto",
    period: "5m",
    barMinutes: 5,
    sessionBars: utcOrbSessionBars,
    warmupDays: warmupDays as 10,
    sourceHash: "a".repeat(64),
    adjustmentId: "b".repeat(64),
    calendarHash: "continuous-UTC-v1",
    coverage: {
      from: bars[0]?.date ?? null,
      to: bars.at(-1)?.date ?? null,
      bars: bars.length,
      sessions: sessions.length,
      completeSessions: sessions.filter((s) => !s.unknown).length,
    },
    sessions,
  };
}

function indexOf(bars: readonly Bar[], day: string, slot: number) {
  const label = utcOrbSlotLabel(day, slot);
  const index = bars.findIndex((b) => b.date === label);
  if (index < 0) throw new Error(`missing fixture bar ${label}`);
  return index;
}

describe("UTC ORB session builder", () => {
  it("derives daily stretch from the prior 10 complete days and freezes U/S", () => {
    const bars = fullBars();
    const sessions = buildUtcOrbSessions(bars);
    const session = sessions.find((s) => s.day === target)!;
    // Each prior day has O=100, H=100.5, L=99.5 -> min(0.5, 0.5)=0.5.
    expect(session.stretch).toBeCloseTo(0.5);
    expect(session.upper).toBeCloseTo(101);
    expect(session.lower).toBeCloseTo(99);
    expect(session.priorCompleteDays).toEqual(days.slice(2, 12));
    expect(session.unknown).toBeNull();
  });

  it("returns unknown when the opening slot or a prior day is incomplete", () => {
    const missingOpening = fullBars().filter(
      (b) => b.date !== utcOrbSlotLabel(target, 0),
    );
    expect(
      buildUtcOrbSessions(missingOpening).find((s) => s.day === target)
        ?.unknown,
    ).toBe("missing-opening-slot");
    const missingPrior = fullBars().filter(
      (b) => b.date !== utcOrbSlotLabel(days[5]!, 100),
    );
    expect(
      buildUtcOrbSessions(missingPrior).find((s) => s.day === target)?.unknown,
    ).toBe("prior-10-days-incomplete");
  });

  it("marks a non-positive S unknown instead of exposing negative protection", () => {
    const wide = (day: string) =>
      Array.from({ length: utcOrbSessionBars }, (_, slot) => {
        const label = utcOrbSlotLabel(day, slot);
        return day === target && slot === 0
          ? {
              date: label,
              open: 5,
              high: 6,
              low: 4,
              close: 5,
              volume: 10,
              amount: 1000,
            }
          : {
              date: label,
              open: 100,
              high: 125,
              low: 75,
              close: 100,
              volume: 10,
              amount: 1000,
            };
      });
    const bars = days.flatMap((day) => wide(day));
    const session = buildUtcOrbSessions(bars).find((s) => s.day === target)!;
    expect(session.lower).toBeNull();
    expect(session.upper).toBeNull();
    expect(session.unknown).toBe("non-positive-opening-range");
  });

  it("rejects impossible calendar days in the shared daily helper path", () => {
    expect(() => utcOrbShiftDay("2026-02-30", 1)).toThrow(/real YYYY-MM-DD/);
    expect(() => utcOrbSlotLabel("2026-13-01", 0)).toThrow(/real YYYY-MM-DD/);
  });

  it("rejects malformed labels, unsorted bars, duplicate slots and invalid OHLCV", () => {
    const good = fullBars();
    expect(() =>
      buildUtcOrbSessions([...good, { ...good[0]!, date: "2026-10-01" }]),
    ).toThrow(/end-labelled/);
    expect(() => buildUtcOrbSessions([good[1]!, good[0]!])).toThrow(
      /strictly increasing/,
    );
    expect(() => buildUtcOrbSessions([...good, { ...good[0]! }])).toThrow(
      /strictly increasing|Duplicate/,
    );
    expect(() =>
      buildUtcOrbSessions([
        { ...good[0]!, high: 1, close: 100 },
        ...good.slice(1),
      ]),
    ).toThrow(/Invalid UTC ORB OHLCV/);
    expect(() =>
      buildUtcOrbSessions([{ ...good[0]!, volume: -1 }, ...good.slice(1)]),
    ).toThrow(/Invalid UTC ORB OHLCV/);
  });
});

describe("UTC ORB rule", () => {
  it("triggers once on the first completed close above U and consumes the attempt", () => {
    const bars = fullBars({ [target]: { 2: 102 } });
    const evaluate = createUtcOrbRule(orbInput(bars), bars);
    const cross = indexOf(bars, target, 2);
    expect(evaluate(cross).entry).toBe(true);
    expect(evaluate(indexOf(bars, target, 3)).entry).toBe(false);
    expect(evaluate(indexOf(bars, target, 3)).reason).toBe(
      "entry-attempt-consumed",
    );
    expect(evaluate(indexOf(bars, target, 4)).entry).toBe(false);
    // Repeating and reordering cannot consume a second attempt.
    expect(evaluate(cross).entry).toBe(true);
    expect(evaluate(cross)).toEqual(evaluate(cross));
  });

  it("keeps a held position's signal-day S after a later gap and exits at or below it", () => {
    const bars = fullBars({
      [target]: { 0: 100, 2: 102, 4: 99 },
    });
    const evaluate = createUtcOrbRule(orbInput(bars), bars);
    const signal = indexOf(bars, target, 2);
    const fill = indexOf(bars, target, 3);
    const protect = indexOf(bars, target, 4);
    expect(evaluate(signal).entry).toBe(true);
    expect(
      evaluate(fill, { entry: 1, entryIndex: fill, signalIndex: signal }).exit,
    ).toBe(false);
    const decision = evaluate(protect, {
      entry: 1,
      entryIndex: fill,
      signalIndex: signal,
    });
    expect(decision.exit).toBe(true);
    expect(decision.reason).toBe("close-at-or-below-frozen-lower");
    expect(decision.lower).toBeCloseTo(99);
  });

  it("treats an exact close equal to frozen S as protection", () => {
    const bars = fullBars({ [target]: { 2: 102, 4: 99 } });
    const evaluate = createUtcOrbRule(orbInput(bars), bars);
    const signal = indexOf(bars, target, 2);
    const fill = indexOf(bars, target, 3);
    expect(
      evaluate(indexOf(bars, target, 4), {
        entry: 1,
        entryIndex: fill,
        signalIndex: signal,
      }).exit,
    ).toBe(true);
  });

  it("does not let an earlier current-day gap erase held protection", () => {
    const withGap = fullBars({ [target]: { 2: 102, 4: 99 } }).filter(
      (b) => b.date !== utcOrbSlotLabel(target, 1),
    );
    const evaluate = createUtcOrbRule(orbInput(withGap), withGap);
    const signal = indexOf(withGap, target, 2);
    const fill = indexOf(withGap, target, 3);
    // A new entry needs a complete prefix.
    expect(evaluate(signal).entryKnown).toBe(false);
    expect(evaluate(signal).reason).toBe("current-session-gap");
    // The confirmed position still exits on its frozen signal-day S.
    const decision = evaluate(indexOf(withGap, target, 4), {
      entry: 1,
      entryIndex: fill,
      signalIndex: signal,
    });
    expect(decision.exit).toBe(true);
    expect(decision.reason).toBe("close-at-or-below-frozen-lower");
  });

  it("exits a delayed position on the next observed bar without new-session stretch", () => {
    const next = utcOrbShiftDay(target, 1);
    const bars = [
      ...fullBars({ [target]: { 2: 102 } }),
      // Next UTC session has no opening slot, so its own U/S stay unknown.
      ...dayBars(next).filter((_, slot) => slot !== 0),
    ];
    const evaluate = createUtcOrbRule(orbInput(bars), bars);
    const signal = indexOf(bars, target, 2);
    const fill = indexOf(bars, target, 3);
    const delayed = indexOf(bars, next, 5);
    const decision = evaluate(delayed, {
      entry: 1,
      entryIndex: fill,
      signalIndex: signal,
    });
    expect(decision.exit).toBe(true);
    expect(decision.reason).toBe("late-end-of-day-exit-intent");
    expect(decision.lower).toBeCloseTo(99);
    expect(buildUtcOrbSessions(bars).find((s) => s.day === next)?.unknown).toBe(
      "missing-opening-slot",
    );
  });

  it("registers the 23:55 exit intent before the 00:00 label", () => {
    const bars = fullBars({ [target]: { 2: 102 } });
    const evaluate = createUtcOrbRule(orbInput(bars), bars);
    const signal = indexOf(bars, target, 2);
    const fill = indexOf(bars, target, 3);
    expect(utcOrbSlotLabel(target, 286)).toBe(`${target}T23:55:00+00:00`);
    expect(utcOrbSlotLabel(target, 287)).toBe(
      `${utcOrbShiftDay(target, 1)}T00:00:00+00:00`,
    );
    const exit = evaluate(indexOf(bars, target, 286), {
      entry: 1,
      entryIndex: fill,
      signalIndex: signal,
    });
    expect(exit.exit).toBe(true);
    expect(exit.reason).toBe("end-of-day-exit-intent");
    // No new entry at or after the exit-intent bar.
    expect(evaluate(indexOf(bars, target, 286)).reason).toBe(
      "end-day-exit-priority",
    );
    expect(evaluate(indexOf(bars, target, 287)).reason).toBe(
      "end-day-exit-priority",
    );
  });

  it("does not change earlier decisions when later bars are missing", () => {
    const full = fullBars({ [target]: { 2: 102 } });
    const prefix = full.filter(
      (b) => Date.parse(b.date) <= Date.parse(utcOrbSlotLabel(target, 5)),
    );
    const atFive = createUtcOrbRule(
      orbInput(prefix),
      prefix,
    )(indexOf(prefix, target, 2));
    const atFull = createUtcOrbRule(
      orbInput(full),
      full,
    )(indexOf(full, target, 2));
    expect(atFive).toEqual(atFull);
  });

  it("compiles through the strategy object with a matching entry/exit preset", () => {
    const bars = fullBars({ [target]: { 2: 102, 4: 99 } });
    const strategy = utcOrbStrategy();
    const prepared = prepareStrategy(strategy, bars, { orb: orbInput(bars) });
    const signal = indexOf(bars, target, 2);
    const fill = indexOf(bars, target, 3);
    expect(prepared.evaluate(signal).entry).toBe(true);
    expect(
      prepared.evaluate(indexOf(bars, target, 4), {
        entry: 1,
        entryIndex: fill,
        signalIndex: signal,
      }).exit,
    ).toBe(true);
    expect(prepared.explain(signal).kind).toBe("utc-orb");
    expect(prepared.explain(signal).inputs.model).toContain(
      "下一5分钟开盘执行",
    );
    expect(() =>
      strategyObjectSchema.parse({ ...strategy, market: "cn-equity" }),
    ).toThrow();
    expect(() => utcOrbStrategy(["cxSOLUSDT"])).toThrow();
    expect(() =>
      strategyObjectSchema.parse({
        ...strategy,
        entry: { kind: "utc-orb", side: "exit" },
      }),
    ).toThrow();
  });

  it("rejects frozen sessions that differ from the completed bars", () => {
    const bars = fullBars();
    const input = orbInput(bars);
    const tampered = {
      ...input,
      sessions: input.sessions.map((s) =>
        s.day === target ? { ...s, upper: 1 } : s,
      ),
    };
    expect(() => createUtcOrbRule(tampered, bars)).toThrow(/differ/);
  });
});
