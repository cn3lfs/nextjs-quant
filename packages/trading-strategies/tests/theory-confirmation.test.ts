import { describe, expect, it } from "vitest";
import {
  advanceIndexConfirmation,
  confirmationEpoch,
  confirmedSwingTrend,
  confirmDowPair,
  initialIndexConfirmationState,
  pointAndFigure,
  trendHierarchy,
  type ConfirmationTime,
  type ConfirmedSwingInput,
  type ConfirmedSwingPoint,
  type IndexConfirmationState,
} from "../src/theory-confirmation";
import * as publicApi from "../src/index.js";

const DAY = 86_400_000;
const asOf = Date.UTC(2026, 10, 17, 8);
const ago = (days: number) => asOf - days * DAY;

const high = (price: number, daysAgo: number): ConfirmedSwingPoint => ({
  kind: "high",
  price,
  confirmedAt: ago(daysAgo),
});
const low = (price: number, daysAgo: number): ConfirmedSwingPoint => ({
  kind: "low",
  price,
  confirmedAt: ago(daysAgo),
});
const swing = (
  h1: number,
  h2: number,
  l1: number,
  l2: number,
): ConfirmedSwingInput => ({
  highs: [high(h1, 4), high(h2, 2)],
  lows: [low(l1, 3), low(l2, 1)],
  asOf,
});

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value))
      deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

describe("F02.01 confirmedSwingTrend", () => {
  it("requires both a higher high and a higher low for UP", () => {
    expect(confirmedSwingTrend(swing(100, 110, 90, 95))).toBe("UP");
    expect(confirmedSwingTrend(swing(110, 100, 95, 90))).toBe("DOWN");
    expect(confirmedSwingTrend(swing(100, 110, 95, 90))).toBe("RANGE");
    expect(confirmedSwingTrend(swing(110, 100, 90, 95))).toBe("RANGE");
  });

  it("orders the two points by parsed time, not by caller array order", () => {
    const input = swing(100, 110, 90, 95);
    expect(
      confirmedSwingTrend({
        ...input,
        highs: [...input.highs].reverse(),
        lows: [...input.lows].reverse(),
      }),
    ).toBe("UP");
  });

  it("returns UNKNOWN for missing, future, or malformed confirmation evidence", () => {
    const input = swing(100, 110, 90, 95);
    expect(confirmedSwingTrend({ ...input, highs: [input.highs[0]!] })).toBe(
      "UNKNOWN",
    );
    expect(
      confirmedSwingTrend({
        ...input,
        lows: [input.lows[0]!, { ...input.lows[1]!, confirmedAt: asOf + DAY }],
      }),
    ).toBe("UNKNOWN");
    expect(
      confirmedSwingTrend({
        ...input,
        highs: [
          input.highs[0]!,
          { ...input.highs[1]!, confirmedAt: "2026-11-10" },
        ],
      }),
    ).toBe("UNKNOWN");
    expect(
      confirmedSwingTrend({
        ...input,
        highs: [
          input.highs[0]!,
          { ...input.highs[1]!, confirmedAt: "2026-11-10T08:00:00" },
        ],
      }),
    ).toBe("UNKNOWN");
    expect(
      confirmedSwingTrend({
        ...input,
        highs: [input.highs[0]!, { ...input.highs[1]!, confirmedAt: 1.5 }],
      }),
    ).toBe("UNKNOWN");
    expect(
      confirmedSwingTrend({
        ...input,
        highs: [
          input.highs[0]!,
          { ...input.highs[1]!, confirmedAt: "2026-02-30T00:00:00Z" },
        ],
      }),
    ).toBe("UNKNOWN");
    expect(
      confirmedSwingTrend({
        ...input,
        highs: [
          input.highs[0]!,
          { ...input.highs[1]!, confirmedAt: input.highs[0]!.confirmedAt },
        ],
      }),
    ).toBe("UNKNOWN");
    expect(confirmedSwingTrend(null)).toBe("UNKNOWN");
  });

  it("parses timezone-bearing ISO numerically rather than lexically", () => {
    const earlier = confirmationEpoch("2026-11-15T00:00:00+08:00")!;
    const later = confirmationEpoch("2026-11-14T20:00:00Z")!;
    expect(earlier).toBeLessThan(later);
    expect("2026-11-15T00:00:00+08:00" > "2026-11-14T20:00:00Z").toBe(true);
    expect(confirmationEpoch("2026-11-14T20:00:00Z")).toBe(
      Date.UTC(2026, 10, 14, 20),
    );
  });

  it("does not mutate deep-frozen confirmed pivots", () => {
    const input = deepFreeze(swing(100, 110, 90, 95));
    const before = structuredClone(input);
    expect(confirmedSwingTrend(input)).toBe("UP");
    expect(input).toEqual(before);
  });
});

const pair = (first: ConfirmedSwingInput, second: ConfirmedSwingInput) => ({
  asOf,
  indices: [
    { highs: first.highs, lows: first.lows },
    { highs: second.highs, lows: second.lows },
  ] as const,
});

describe("F02.01 confirmDowPair", () => {
  it("confirms only when both selected indices agree under one clock", () => {
    expect(
      confirmDowPair(pair(swing(100, 110, 90, 95), swing(200, 210, 180, 190))),
    ).toBe("UP");
    expect(
      confirmDowPair(pair(swing(110, 100, 95, 90), swing(210, 200, 190, 180))),
    ).toBe("DOWN");
  });

  it("evaluates both indices at the shared asOf, not per-index clocks", () => {
    const first = swing(100, 110, 90, 95);
    const second = swing(200, 210, 180, 190);
    const firstPivots = { highs: first.highs, lows: first.lows };
    const secondPivots = { highs: second.highs, lows: second.lows };
    expect(
      confirmDowPair({
        asOf,
        indices: [
          {
            highs: [
              { ...first.highs[0]!, confirmedAt: "2026-11-01T08:00:00Z" },
              { ...first.highs[1]!, confirmedAt: "2026-11-03T08:00:00Z" },
            ],
            lows: [
              { ...first.lows[0]!, confirmedAt: "2026-11-02T08:00:00Z" },
              { ...first.lows[1]!, confirmedAt: "2026-11-04T08:00:00Z" },
            ],
          },
          {
            highs: [
              { ...second.highs[0]!, confirmedAt: "2026-11-08T08:00:00Z" },
              { ...second.highs[1]!, confirmedAt: "2026-11-10T08:00:00Z" },
            ],
            lows: [
              { ...second.lows[0]!, confirmedAt: "2026-11-09T08:00:00Z" },
              { ...second.lows[1]!, confirmedAt: "2026-11-11T08:00:00Z" },
            ],
          },
        ],
      }),
    ).toBe("UP");
    expect(
      confirmDowPair({
        asOf,
        indices: [
          { ...firstPivots, asOf: "2026-11-01T08:00:00Z" },
          { ...secondPivots, asOf: "2026-11-10T08:00:00Z" },
        ],
      }),
    ).toBe("UNKNOWN");
    expect(
      confirmDowPair({
        asOf: "2026-11-17T16:00:00+08:00",
        indices: [
          { ...firstPivots, asOf: "2026-11-17T08:00:00Z" },
          secondPivots,
        ],
      }),
    ).toBe("UP");
  });

  it("returns WAIT for disagreement and UNKNOWN for missing evidence", () => {
    expect(
      confirmDowPair(pair(swing(100, 110, 90, 95), swing(210, 200, 190, 180))),
    ).toBe("WAIT");
    expect(
      confirmDowPair({
        asOf: null as never,
        indices: pair(swing(100, 110, 90, 95), swing(200, 210, 180, 190))
          .indices,
      }),
    ).toBe("UNKNOWN");
    expect(
      confirmDowPair({
        asOf,
        indices: [{ highs: swing(100, 110, 90, 95).highs, lows: [] }],
      } as never),
    ).toBe("UNKNOWN");
    expect(
      confirmDowPair({
        asOf,
        indices: [
          {
            highs: swing(100, 110, 90, 95).highs,
            lows: swing(100, 110, 90, 95).lows,
          },
          {
            highs: swing(200, 210, 180, 190).highs,
            lows: swing(200, 210, 180, 190).lows,
          },
          {
            highs: swing(300, 310, 280, 290).highs,
            lows: swing(300, 310, 280, 290).lows,
          },
        ],
      } as never),
    ).toBe("UNKNOWN");
  });

  it("does not mutate deep-frozen pair inputs", () => {
    const inputs = deepFreeze(
      pair(swing(100, 110, 90, 95), swing(200, 210, 180, 190)),
    );
    const before = structuredClone(inputs);
    expect(confirmDowPair(inputs)).toBe("UP");
    expect(inputs).toEqual(before);
  });
});

const barTime = (bar: number) => Date.UTC(2026, 10, 1) + bar * DAY;
const defaultValues: readonly [number, number] = [100, 200];
const defaultFrozenAt = barTime(0);

type StepOptions = {
  bar: number;
  prevA: number | null;
  curA: number | null;
  prevB: number | null;
  curB: number | null;
  version?: number;
  frozenAt?: ConfirmationTime;
  values?: readonly [number, number];
  window?: number;
  time?: ConfirmationTime;
  previousBarIndex?: number | null;
  previousTime?: ConfirmationTime | null;
};

const step = (state: IndexConfirmationState, options: StepOptions) =>
  advanceIndexConfirmation({
    state,
    boundary: {
      version: options.version ?? 1,
      frozenAt: options.frozenAt ?? defaultFrozenAt,
      values: options.values ?? defaultValues,
    },
    window: options.window ?? 2,
    barIndex: options.bar,
    time: options.time ?? barTime(options.bar),
    previousCloses: [options.prevA, options.prevB],
    currentCloses: [options.curA, options.curB],
    previousBarIndex: options.previousBarIndex,
    previousTime: options.previousTime,
  });

describe("F02.02 trendHierarchy", () => {
  it("keeps three independent states and flags only long-UP/medium-DOWN", () => {
    expect(
      trendHierarchy({
        asOf,
        major: swing(100, 110, 90, 95),
        medium: swing(110, 100, 95, 90),
        minor: swing(100, 110, 90, 95),
      }),
    ).toEqual({
      major: "UP",
      medium: "DOWN",
      minor: "UP",
      pullbackCandidate: true,
    });
  });

  it("never lets the minor layer override a DOWN major trend", () => {
    expect(
      trendHierarchy({
        asOf,
        major: swing(110, 100, 95, 90),
        medium: swing(100, 110, 90, 95),
        minor: swing(100, 110, 90, 95),
      }),
    ).toEqual({
      major: "DOWN",
      medium: "UP",
      minor: "UP",
      pullbackCandidate: false,
    });
  });

  it("marks missing layers UNKNOWN without changing the other layers", () => {
    expect(
      trendHierarchy({
        asOf,
        major: swing(100, 110, 90, 95),
        minor: swing(100, 110, 90, 95),
      }),
    ).toEqual({
      major: "UP",
      medium: "UNKNOWN",
      minor: "UP",
      pullbackCandidate: false,
    });
    expect(trendHierarchy({ asOf, major: swing(100, 110, 90, 95) })).toEqual({
      major: "UP",
      medium: "UNKNOWN",
      minor: "UNKNOWN",
      pullbackCandidate: false,
    });
    expect(trendHierarchy(null)).toEqual({
      major: "UNKNOWN",
      medium: "UNKNOWN",
      minor: "UNKNOWN",
      pullbackCandidate: false,
    });
  });

  it("does not mutate deep-frozen layer inputs", () => {
    const input = deepFreeze({
      asOf,
      major: swing(100, 110, 90, 95),
      medium: swing(110, 100, 95, 90),
      minor: swing(100, 110, 90, 95),
    });
    const before = structuredClone(input);
    expect(trendHierarchy(input).pullbackCandidate).toBe(true);
    expect(input).toEqual(before);
  });
});

describe("F02.03 advanceIndexConfirmation", () => {
  it("registers only fresh adjacent crosses and confirms within the bar window", () => {
    let state = initialIndexConfirmationState;
    let result = step(state, {
      bar: 10,
      prevA: 99,
      curA: 99,
      prevB: 199,
      curB: 199,
    });
    expect(result.status).toBe("WAIT");
    expect(result.state.candidates).toEqual([null, null]);
    state = result.state;

    result = step(state, {
      bar: 11,
      prevA: 99,
      curA: 101,
      prevB: 199,
      curB: 199,
    });
    expect(result.status).toBe("WAIT");
    expect(result.state.candidates[0]).toMatchObject({
      barIndex: 11,
      boundary: 100,
    });
    expect(result.state.candidates[1]).toBeNull();
    state = result.state;

    result = step(state, {
      bar: 12,
      prevA: 101,
      curA: 101,
      prevB: 199,
      curB: 201,
    });
    expect(result.status).toBe("CONFIRMED");
    state = result.state;

    result = step(state, {
      bar: 13,
      prevA: 101,
      curA: 100,
      prevB: 201,
      curB: 201,
    });
    expect(result.status).toBe("WAIT");
    expect(result.state.candidates[0]).toBeNull();
    expect(result.state.candidates[1]).not.toBeNull();
    state = result.state;

    result = step(state, {
      bar: 14,
      prevA: 100,
      curA: 101,
      prevB: 201,
      curB: 201,
    });
    expect(result.status).toBe("CONFIRMED");
  });

  it("expires by completed-bar count and only a new version re-arms", () => {
    let state = initialIndexConfirmationState;
    state = step(state, {
      bar: 10,
      prevA: 99,
      curA: 99,
      prevB: 199,
      curB: 199,
      window: 1,
    }).state;
    state = step(state, {
      bar: 11,
      prevA: 99,
      curA: 101,
      prevB: 199,
      curB: 199,
      window: 1,
    }).state;
    let result = step(state, {
      bar: 12,
      prevA: 101,
      curA: 101,
      prevB: 199,
      curB: 201,
      window: 1,
    });
    // Candidate age is exactly one completed bar, so it is still valid.
    expect(result.status).toBe("CONFIRMED");
    state = result.state;

    result = step(state, {
      bar: 13,
      prevA: 101,
      curA: 99,
      prevB: 201,
      curB: 199,
      window: 1,
    });
    expect(result.status).toBe("WAIT");
    expect(result.state.candidates).toEqual([null, null]);
    expect(result.state.boundaryValid).toBe(false);
    expect(result.state.invalidatedVersion).toBe(1);
    state = result.state;

    result = step(state, {
      bar: 14,
      prevA: 99,
      curA: 101,
      prevB: 199,
      curB: 201,
      window: 1,
    });
    expect(result.status).toBe("WAIT");
    expect(result.state.candidates).toEqual([null, null]);
    state = result.state;

    // The first observation of a new version only seeds; it cannot arm.
    result = step(state, {
      bar: 15,
      prevA: 99,
      curA: 101,
      prevB: 199,
      curB: 201,
      version: 2,
      window: 1,
    });
    expect(result.status).toBe("WAIT");
    expect(result.state.candidates).toEqual([null, null]);
    expect(result.state.version).toBe(2);
    expect(result.state.boundaryValid).toBe(true);
    expect(result.state.invalidatedVersion).toBeNull();
    state = result.state;

    state = step(state, {
      bar: 16,
      prevA: 101,
      curA: 99,
      prevB: 201,
      curB: 199,
      version: 2,
      window: 1,
    }).state;
    result = step(state, {
      bar: 17,
      prevA: 99,
      curA: 101,
      prevB: 199,
      curB: 201,
      version: 2,
      window: 1,
    });
    expect(result.status).toBe("CONFIRMED");
  });

  it("rejects changed boundary values or frozenAt without erasing state", () => {
    let state = step(initialIndexConfirmationState, {
      bar: 10,
      prevA: 99,
      curA: 99,
      prevB: 199,
      curB: 199,
    }).state;
    state = step(state, {
      bar: 11,
      prevA: 99,
      curA: 101,
      prevB: 199,
      curB: 199,
    }).state;
    expect(state.candidates[0]).not.toBeNull();

    let result = step(state, {
      bar: 12,
      prevA: 101,
      curA: 101,
      prevB: 199,
      curB: 201,
      values: [101, 200],
    });
    expect(result.status).toBe("UNKNOWN");
    expect(result.state.boundary).toEqual([100, 200]);
    expect(result.state.candidates[0]).not.toBeNull();
    expect(result.state.lastBarIndex).toBe(11);

    result = step(state, {
      bar: 12,
      prevA: 101,
      curA: 101,
      prevB: 199,
      curB: 201,
      frozenAt: barTime(1),
    });
    expect(result.status).toBe("UNKNOWN");
    expect(result.state.candidates[0]).not.toBeNull();
    expect(result.state.lastBarIndex).toBe(11);
  });

  it("accepts the same frozenAt instant in different timezone strings", () => {
    const state = step(initialIndexConfirmationState, {
      bar: 10,
      prevA: 99,
      curA: 99,
      prevB: 199,
      curB: 199,
      frozenAt: "2026-11-01T00:00:00Z",
    }).state;
    const result = step(state, {
      bar: 11,
      prevA: 99,
      curA: 99,
      prevB: 199,
      curB: 199,
      frozenAt: "2026-11-01T08:00:00+08:00",
    });
    expect(result.status).not.toBe("UNKNOWN");
    expect(result.state.version).toBe(1);
  });

  it("rejects a boundary frozen after its observation time", () => {
    const result = step(initialIndexConfirmationState, {
      bar: 10,
      prevA: 99,
      curA: 99,
      prevB: 199,
      curB: 199,
      version: 2,
      frozenAt: barTime(11),
    });
    expect(result.status).toBe("UNKNOWN");
    expect(result.state.candidates).toEqual([null, null]);
  });

  it("invalidates candidates and breaks continuity on a skipped bar", () => {
    let state = step(initialIndexConfirmationState, {
      bar: 10,
      prevA: 99,
      curA: 99,
      prevB: 199,
      curB: 199,
    }).state;
    state = step(state, {
      bar: 11,
      prevA: 99,
      curA: 101,
      prevB: 199,
      curB: 199,
    }).state;
    expect(state.candidates[0]).not.toBeNull();

    let result = step(state, {
      bar: 13,
      prevA: 99,
      curA: 99,
      prevB: 199,
      curB: 199,
    });
    expect(result.status).toBe("WAIT");
    expect(result.state.candidates).toEqual([null, null]);
    expect(result.state.lastBarIndex).toBe(13);
    expect(result.state.continuityBarIndex).toBe(13);
    state = result.state;

    result = step(state, {
      bar: 14,
      prevA: 99,
      curA: 101,
      prevB: 199,
      curB: 199,
    });
    expect(result.state.candidates[0]).toMatchObject({ barIndex: 14 });
    expect(result.status).toBe("WAIT");
  });

  it("returns UNKNOWN on missing data and does not confirm across the gap", () => {
    let state = initialIndexConfirmationState;
    state = step(state, {
      bar: 10,
      prevA: 99,
      curA: 99,
      prevB: 199,
      curB: 199,
    }).state;
    state = step(state, {
      bar: 11,
      prevA: 99,
      curA: 101,
      prevB: 199,
      curB: 199,
    }).state;
    expect(state.candidates[0]).not.toBeNull();

    let result = step(state, {
      bar: 12,
      prevA: 101,
      curA: null,
      prevB: 199,
      curB: 201,
    });
    expect(result.status).toBe("UNKNOWN");
    expect(result.state.candidates).toEqual([null, null]);
    expect(result.state.lastBarIndex).toBe(12);
    expect(result.state.lastTime).toBe(barTime(12));
    expect(result.state.continuityBarIndex).toBeNull();
    state = result.state;

    result = step(state, {
      bar: 13,
      prevA: 99,
      curA: 101,
      prevB: 199,
      curB: 201,
    });
    expect(result.status).toBe("WAIT");
    expect(result.state.candidates).toEqual([null, null]);
    expect(result.state.continuityBarIndex).toBe(13);

    state = step(result.state, {
      bar: 14,
      prevA: 101,
      curA: 99,
      prevB: 201,
      curB: 199,
    }).state;
    result = step(state, {
      bar: 15,
      prevA: 99,
      curA: 101,
      prevB: 199,
      curB: 199,
    });
    expect(result.state.candidates[0]).not.toBeNull();
    expect(result.status).toBe("WAIT");
  });

  it("rejects duplicate, out-of-order, or backward-time observations and keeps state", () => {
    let state = step(initialIndexConfirmationState, {
      bar: 10,
      prevA: 99,
      curA: 99,
      prevB: 199,
      curB: 199,
    }).state;
    state = step(state, {
      bar: 11,
      prevA: 99,
      curA: 101,
      prevB: 199,
      curB: 199,
    }).state;
    expect(state.candidates[0]).not.toBeNull();

    let result = step(state, {
      bar: 11,
      prevA: 99,
      curA: 101,
      prevB: 199,
      curB: 201,
    });
    expect(result.status).toBe("UNKNOWN");
    expect(result.state.lastBarIndex).toBe(11);
    expect(result.state.candidates[0]).not.toBeNull();

    result = step(state, {
      bar: 10,
      prevA: 99,
      curA: 101,
      prevB: 199,
      curB: 201,
    });
    expect(result.status).toBe("UNKNOWN");
    expect(result.state.lastBarIndex).toBe(11);
    expect(result.state.candidates[0]).not.toBeNull();

    result = step(state, {
      bar: 12,
      prevA: 101,
      curA: 101,
      prevB: 199,
      curB: 201,
      time: barTime(10),
    });
    expect(result.status).toBe("UNKNOWN");
    expect(result.state.lastBarIndex).toBe(11);
    expect(result.state.lastTime).toBe(barTime(11));
    expect(result.state.candidates[0]).not.toBeNull();
  });

  it("returns UNKNOWN for non-integer or non-positive bar windows", () => {
    for (const window of [0, -1, 1.5]) {
      const result = step(initialIndexConfirmationState, {
        bar: 10,
        prevA: 99,
        curA: 99,
        prevB: 199,
        curB: 199,
        window,
      });
      expect(result.status).toBe("UNKNOWN");
      expect(result.state.lastBarIndex).toBeNull();
    }
  });

  it("registers a legal crossing on the initial call with proven provenance", () => {
    const result = step(initialIndexConfirmationState, {
      bar: 10,
      prevA: 99,
      curA: 101,
      prevB: 199,
      curB: 201,
      previousBarIndex: 9,
      previousTime: barTime(9),
    });
    expect(result.status).toBe("CONFIRMED");
    expect(result.state.candidates[0]).toMatchObject({ barIndex: 10 });
    expect(result.state.candidates[1]).toMatchObject({ barIndex: 10 });
    expect(result.state.continuityBarIndex).toBe(10);
  });

  it("registers a legal crossing on a new version's first observation", () => {
    const state = step(initialIndexConfirmationState, {
      bar: 10,
      prevA: 99,
      curA: 99,
      prevB: 199,
      curB: 199,
    }).state;
    const result = step(state, {
      bar: 11,
      prevA: 99,
      curA: 101,
      prevB: 199,
      curB: 201,
      version: 2,
      previousBarIndex: 10,
      previousTime: barTime(10),
    });
    expect(result.status).toBe("CONFIRMED");
    expect(result.state.version).toBe(2);
    expect(result.state.candidates[0]).toMatchObject({ barIndex: 11 });
  });

  it("rejects a boundary frozen after the proven previous observation", () => {
    const result = step(initialIndexConfirmationState, {
      bar: 10,
      prevA: 99,
      curA: 101,
      prevB: 199,
      curB: 201,
      frozenAt: barTime(10),
      previousBarIndex: 9,
      previousTime: barTime(9),
    });
    expect(result.status).toBe("UNKNOWN");
    expect(result.state.lastBarIndex).toBeNull();
  });

  it("rejects wrong or partial previous provenance", () => {
    const base = {
      bar: 10,
      prevA: 99,
      curA: 101,
      prevB: 199,
      curB: 201,
    };
    let result = step(initialIndexConfirmationState, {
      ...base,
      previousBarIndex: 8,
      previousTime: barTime(8),
    });
    expect(result.status).toBe("UNKNOWN");
    result = step(initialIndexConfirmationState, {
      ...base,
      previousBarIndex: 9,
      previousTime: barTime(10),
    });
    expect(result.status).toBe("UNKNOWN");
    result = step(initialIndexConfirmationState, {
      ...base,
      previousBarIndex: 9,
    });
    expect(result.status).toBe("UNKNOWN");
    result = step(initialIndexConfirmationState, {
      ...base,
      previousTime: barTime(9),
    });
    expect(result.status).toBe("UNKNOWN");
    expect(result.state.lastBarIndex).toBeNull();
  });

  it("rejects provenance inconsistent with the stored watermark", () => {
    let state = step(initialIndexConfirmationState, {
      bar: 10,
      prevA: 99,
      curA: 99,
      prevB: 199,
      curB: 199,
    }).state;
    state = step(state, {
      bar: 11,
      prevA: 99,
      curA: 101,
      prevB: 199,
      curB: 199,
    }).state;
    const result = step(state, {
      bar: 12,
      prevA: 101,
      curA: 101,
      prevB: 199,
      curB: 201,
      previousBarIndex: 11,
      previousTime: barTime(10),
    });
    expect(result.status).toBe("UNKNOWN");
    expect(result.state.lastBarIndex).toBe(11);
    expect(result.state.candidates[0]).not.toBeNull();
  });

  it("does not let declared provenance cross a skipped-bar gap", () => {
    let state = initialIndexConfirmationState;
    state = step(state, {
      bar: 10,
      prevA: 99,
      curA: 99,
      prevB: 199,
      curB: 199,
      window: 5,
    }).state;
    state = step(state, {
      bar: 11,
      prevA: 99,
      curA: 101,
      prevB: 199,
      curB: 199,
      window: 5,
    }).state;
    expect(state.candidates[0]).not.toBeNull();

    let result = step(state, {
      bar: 13,
      prevA: 99,
      curA: 101,
      prevB: 199,
      curB: 201,
      window: 5,
      previousBarIndex: 12,
      previousTime: barTime(12),
    });
    expect(result.status).toBe("WAIT");
    expect(result.state.candidates).toEqual([null, null]);
    expect(result.state.lastBarIndex).toBe(13);
    expect(result.state.continuityBarIndex).toBe(13);
    state = result.state;

    result = step(state, {
      bar: 14,
      prevA: 99,
      curA: 101,
      prevB: 199,
      curB: 201,
      window: 5,
      previousBarIndex: 13,
      previousTime: barTime(13),
    });
    expect(result.status).toBe("CONFIRMED");
  });

  it("seeds current continuity when previous closes are missing, then crosses next bar", () => {
    let state = initialIndexConfirmationState;
    state = step(state, {
      bar: 10,
      prevA: 99,
      curA: 99,
      prevB: 199,
      curB: 199,
    }).state;
    state = step(state, {
      bar: 11,
      prevA: 99,
      curA: 101,
      prevB: 199,
      curB: 199,
    }).state;

    let result = step(state, {
      bar: 12,
      prevA: null,
      curA: 101,
      prevB: null,
      curB: 201,
      previousBarIndex: 11,
      previousTime: barTime(11),
    });
    expect(result.status).toBe("UNKNOWN");
    expect(result.state.continuityBarIndex).toBe(12);
    expect(result.state.candidates).toEqual([null, null]);
    state = result.state;

    result = step(state, {
      bar: 13,
      prevA: 99,
      curA: 101,
      prevB: 199,
      curB: 201,
      previousBarIndex: 12,
      previousTime: barTime(12),
    });
    expect(result.status).toBe("CONFIRMED");
    expect(result.state.candidates[0]).toMatchObject({ barIndex: 13 });
  });

  it("seeds an initial current bar when the previous close is unknown", () => {
    let result = step(initialIndexConfirmationState, {
      bar: 10,
      prevA: null,
      curA: 99,
      prevB: null,
      curB: 199,
    });
    expect(result.status).toBe("UNKNOWN");
    expect(result.state.lastBarIndex).toBe(10);
    expect(result.state.continuityBarIndex).toBe(10);
    expect(result.state.candidates).toEqual([null, null]);

    result = step(result.state, {
      bar: 11,
      prevA: 99,
      curA: 101,
      prevB: 199,
      curB: 201,
    });
    expect(result.status).toBe("CONFIRMED");
  });

  it("allows a new version to cross immediately after an old monitoring gap", () => {
    const state = step(initialIndexConfirmationState, {
      bar: 1,
      prevA: 99,
      curA: 101,
      prevB: 199,
      curB: 201,
      previousBarIndex: 0,
      previousTime: barTime(0),
    }).state;
    expect(state.candidates[0]).not.toBeNull();

    const result = step(state, {
      bar: 21,
      prevA: 99,
      curA: 101,
      prevB: 199,
      curB: 201,
      version: 2,
      previousBarIndex: 20,
      previousTime: barTime(20),
      frozenAt: barTime(20),
    });
    expect(result.status).toBe("CONFIRMED");
    expect(result.state.version).toBe(2);
    expect(result.state.candidates[0]).toMatchObject({ barIndex: 21 });
    expect(result.state.candidates[1]).toMatchObject({ barIndex: 21 });
  });

  it("rejects a new-version boundary frozen after its proven previous bar", () => {
    const state = step(initialIndexConfirmationState, {
      bar: 1,
      prevA: 99,
      curA: 101,
      prevB: 199,
      curB: 201,
      previousBarIndex: 0,
      previousTime: barTime(0),
    }).state;

    const result = step(state, {
      bar: 21,
      prevA: 99,
      curA: 101,
      prevB: 199,
      curB: 201,
      version: 2,
      previousBarIndex: 20,
      previousTime: barTime(20),
      frozenAt: barTime(21),
    });
    expect(result.status).toBe("UNKNOWN");
    expect(result.state.version).toBe(1);
  });

  it("rejects nonadjacent provenance on a new version after a gap", () => {
    const state = step(initialIndexConfirmationState, {
      bar: 1,
      prevA: 99,
      curA: 101,
      prevB: 199,
      curB: 201,
      previousBarIndex: 0,
      previousTime: barTime(0),
    }).state;

    const result = step(state, {
      bar: 21,
      prevA: 99,
      curA: 101,
      prevB: 199,
      curB: 201,
      version: 2,
      previousBarIndex: 19,
      previousTime: barTime(19),
      frozenAt: barTime(19),
    });
    expect(result.status).toBe("UNKNOWN");
    expect(result.state.version).toBe(1);
  });

  it("never inherits old-version candidates into a new version", () => {
    const state = step(initialIndexConfirmationState, {
      bar: 1,
      prevA: 99,
      curA: 101,
      prevB: 199,
      curB: 201,
      previousBarIndex: 0,
      previousTime: barTime(0),
    }).state;
    expect(state.candidates[0]).not.toBeNull();

    const result = step(state, {
      bar: 21,
      prevA: 101,
      curA: 101,
      prevB: 201,
      curB: 201,
      version: 2,
      previousBarIndex: 20,
      previousTime: barTime(20),
      frozenAt: barTime(20),
    });
    expect(result.state.version).toBe(2);
    expect(result.state.candidates).toEqual([null, null]);
    expect(result.status).toBe("WAIT");
  });

  it("expires before gap clearing and burns the version", () => {
    let state = initialIndexConfirmationState;
    state = step(state, {
      bar: 1,
      prevA: 99,
      curA: 99,
      prevB: 199,
      curB: 199,
      window: 2,
    }).state;
    state = step(state, {
      bar: 2,
      prevA: 99,
      curA: 101,
      prevB: 199,
      curB: 199,
      window: 2,
    }).state;
    expect(state.candidates[0]).not.toBeNull();

    let result = step(state, {
      bar: 10,
      prevA: 101,
      curA: 99,
      prevB: 199,
      curB: 199,
      window: 2,
    });
    expect(result.status).toBe("WAIT");
    expect(result.state.boundaryValid).toBe(false);
    expect(result.state.invalidatedVersion).toBe(1);
    expect(result.state.candidates).toEqual([null, null]);
    state = result.state;

    result = step(state, {
      bar: 11,
      prevA: 99,
      curA: 101,
      prevB: 199,
      curB: 201,
      window: 2,
    });
    expect(result.status).toBe("WAIT");
    expect(result.state.invalidatedVersion).toBe(1);
    expect(result.state.candidates).toEqual([null, null]);
    state = result.state;

    result = step(state, {
      bar: 12,
      prevA: 99,
      curA: 101,
      prevB: 199,
      curB: 201,
      version: 2,
      window: 2,
    });
    expect(result.status).toBe("WAIT");
    expect(result.state.candidates).toEqual([null, null]);
    expect(result.state.boundaryValid).toBe(true);
    state = result.state;

    state = step(state, {
      bar: 13,
      prevA: 101,
      curA: 99,
      prevB: 201,
      curB: 199,
      version: 2,
      window: 2,
    }).state;
    result = step(state, {
      bar: 14,
      prevA: 99,
      curA: 101,
      prevB: 199,
      curB: 201,
      version: 2,
      window: 2,
    });
    expect(result.status).toBe("CONFIRMED");
  });

  it("rejects an equal timestamp even with a new bar index", () => {
    const state = step(initialIndexConfirmationState, {
      bar: 10,
      prevA: 99,
      curA: 99,
      prevB: 199,
      curB: 199,
      time: "2026-11-01T00:00:00Z",
    }).state;

    let result = step(state, {
      bar: 11,
      prevA: 99,
      curA: 101,
      prevB: 199,
      curB: 201,
      time: "2026-11-01T00:00:00Z",
    });
    expect(result.status).toBe("UNKNOWN");
    expect(result.state.lastBarIndex).toBe(10);
    expect(result.state.lastTime).toBe(Date.UTC(2026, 10, 1));
    expect(result.state.candidates).toEqual([null, null]);

    result = step(state, {
      bar: 11,
      prevA: 99,
      curA: 101,
      prevB: 199,
      curB: 201,
      time: "2026-11-01T08:00:00+08:00",
    });
    expect(result.status).toBe("UNKNOWN");
    expect(result.state.lastBarIndex).toBe(10);
  });

  it("retains state on invalid time and rejects historical replay", () => {
    let state = initialIndexConfirmationState;
    state = step(state, {
      bar: 10,
      prevA: 99,
      curA: 99,
      prevB: 199,
      curB: 199,
    }).state;
    state = step(state, {
      bar: 11,
      prevA: 99,
      curA: 101,
      prevB: 199,
      curB: 199,
    }).state;
    expect(state.candidates[0]).not.toBeNull();

    let result = step(state, {
      bar: 12,
      prevA: 101,
      curA: 101,
      prevB: 199,
      curB: 201,
      time: "not-a-time",
    });
    expect(result.status).toBe("UNKNOWN");
    expect(result.state.lastBarIndex).toBe(11);
    expect(result.state.lastTime).toBe(barTime(11));
    expect(result.state.candidates[0]).not.toBeNull();

    result = step(state, {
      bar: 12,
      prevA: 101,
      curA: 101,
      prevB: 199,
      curB: 201,
      time: barTime(10),
    });
    expect(result.status).toBe("UNKNOWN");
    expect(result.state.lastBarIndex).toBe(11);
    expect(result.state.lastTime).toBe(barTime(11));
    expect(result.state.candidates[0]).not.toBeNull();

    result = step(state, {
      bar: 12,
      prevA: 101,
      curA: 101,
      prevB: 199,
      curB: 201,
    });
    expect(result.status).toBe("CONFIRMED");
  });

  it("rejects a future frozenAt even for an existing version", () => {
    const forged: IndexConfirmationState = {
      ...initialIndexConfirmationState,
      version: 1,
      boundary: [100, 200] as const,
      frozenAt: barTime(20),
      boundaryValid: true,
    };
    const result = step(forged, {
      bar: 10,
      prevA: 99,
      curA: 99,
      prevB: 199,
      curB: 199,
      frozenAt: barTime(20),
      time: barTime(10),
    });
    expect(result.status).toBe("UNKNOWN");
    expect(result.state.lastBarIndex).toBeNull();
    expect(result.state.frozenAt).toBe(barTime(20));
  });

  it("is deterministic when a prefix is replayed", () => {
    const observations: StepOptions[] = [
      { bar: 10, prevA: 99, curA: 99, prevB: 199, curB: 199 },
      { bar: 11, prevA: 99, curA: 101, prevB: 199, curB: 199 },
      { bar: 12, prevA: 101, curA: 101, prevB: 199, curB: 201 },
    ];
    const run = (items: readonly StepOptions[]) => {
      let state = initialIndexConfirmationState;
      for (const item of items) state = step(state, item).state;
      return state;
    };
    let prefix = run(observations.slice(0, 2));
    for (const item of observations.slice(2)) prefix = step(prefix, item).state;
    expect(prefix).toEqual(run(observations));
  });

  it("does not mutate deep-frozen state inputs", () => {
    let state = initialIndexConfirmationState;
    state = step(state, {
      bar: 10,
      prevA: 99,
      curA: 99,
      prevB: 199,
      curB: 199,
    }).state;
    state = step(state, {
      bar: 11,
      prevA: 99,
      curA: 101,
      prevB: 199,
      curB: 199,
    }).state;
    const input = deepFreeze({
      state,
      boundary: {
        version: 1,
        frozenAt: defaultFrozenAt,
        values: [100, 200] as const,
      },
      window: 2,
      barIndex: 12,
      time: barTime(12),
      previousCloses: [101, 199] as const,
      currentCloses: [101, 201] as const,
    });
    const before = structuredClone(input);
    const result = advanceIndexConfirmation(input);
    expect(input).toEqual(before);
    expect(result.state.version).toBe(1);
    expect(Object.isFrozen(result.state)).toBe(true);
    expect(Object.isFrozen(result.state.candidates)).toBe(true);
  });
});

describe("public confirmation exports", () => {
  it("exposes the four components from the package entry", () => {
    expect(publicApi.confirmedSwingTrend).toBe(confirmedSwingTrend);
    expect(publicApi.confirmDowPair).toBe(confirmDowPair);
    expect(publicApi.trendHierarchy).toBe(trendHierarchy);
    expect(publicApi.advanceIndexConfirmation).toBe(advanceIndexConfirmation);
    expect(publicApi.pointAndFigure).toBe(pointAndFigure);
  });
});

describe("F05.13 pointAndFigure", () => {
  const pnf = (closes: readonly (number | null)[], boxSize = 1, reversal = 3) =>
    pointAndFigure({ closes, boxSize, reversal });

  it("builds full-prefix close-only columns and one signal per boundary", () => {
    const result = pnf([10, 13, 14, 11, 10, 8, 11, 15, 16, 12, 7, 6]);
    expect(result.columns).toEqual([
      { kind: "X", startIndex: 1, endIndex: 2, bottom: 11, top: 14 },
      { kind: "O", startIndex: 3, endIndex: 5, bottom: 8, top: 13 },
      { kind: "X", startIndex: 6, endIndex: 8, bottom: 9, top: 16 },
      { kind: "O", startIndex: 9, endIndex: 11, bottom: 6, top: 15 },
    ]);
    expect(result.signals).toEqual([
      { kind: "BUY_SIGNAL", columnIndex: 2, barIndex: 7, boundary: 14 },
      { kind: "SELL_SIGNAL", columnIndex: 3, barIndex: 10, boundary: 8 },
    ]);
    expect(result.status).toBe("WAIT");
  });

  it("uses the exact reversal threshold", () => {
    expect(pnf([9, 10, 8]).columns.map((column) => column.kind)).toEqual(["X"]);
    const reversed = pnf([9, 10, 7]);
    expect(reversed.columns.map((column) => column.kind)).toEqual(["X", "O"]);
    expect(reversed.columns[1]).toMatchObject({ bottom: 7, top: 9 });
  });

  it("does not repeat a signal while the same boundary is crossed again", () => {
    const result = pnf([10, 13, 14, 11, 10, 8, 11, 15, 16, 12, 7, 6]);
    expect(
      result.signals.filter((signal) => signal.kind === "BUY_SIGNAL"),
    ).toHaveLength(1);
    expect(
      result.signals.filter((signal) => signal.kind === "SELL_SIGNAL"),
    ).toHaveLength(1);
  });

  it("emits once when the active column first clears the prior same-kind boundary", () => {
    const buy = pnf([10, 12, 9, 11, 13, 14], 1, 2);
    expect(buy.signals).toEqual([
      { kind: "BUY_SIGNAL", columnIndex: 2, barIndex: 4, boundary: 12 },
    ]);
    const sell = pnf([10, 8, 11, 9, 7, 6], 1, 2);
    expect(sell.signals).toEqual([
      { kind: "SELL_SIGNAL", columnIndex: 2, barIndex: 4, boundary: 8 },
    ]);
  });

  it("requires a strict new extreme beyond the preceding same-kind column", () => {
    const result = pnf([10, 14, 11, 8, 14]);
    expect(result.signals).toEqual([]);
    expect(result.status).toBe("WAIT");
  });

  it("returns FILTER with fewer than two same-kind columns", () => {
    expect(pnf([10, 13]).status).toBe("FILTER");
    expect(pnf([10, 10]).status).toBe("FILTER");
  });

  it("returns UNKNOWN and resets across a missing close without cross-gap signals", () => {
    const prefix = pnf([10, 13, 14, null]);
    expect(prefix.status).toBe("UNKNOWN");
    expect(prefix.resets).toEqual([3]);
    expect(prefix.columns).toEqual([
      { kind: "X", startIndex: 1, endIndex: 2, bottom: 11, top: 14 },
    ]);

    const result = pnf([10, 13, 14, null, 20, 23]);
    expect(result.resets).toEqual([3]);
    expect(result.signals).toEqual([]);
    expect(result.columns).toEqual([
      { kind: "X", startIndex: 1, endIndex: 2, bottom: 11, top: 14 },
      { kind: "X", startIndex: 5, endIndex: 5, bottom: 21, top: 23 },
    ]);
    expect(result.status).toBe("FILTER");
  });

  it("is prefix invariant for emitted signals", () => {
    const closes = [10, 13, 14, 11, 10, 8, 11, 15, 16, 12, 7, 6];
    const full = pnf(closes);
    for (let end = 1; end <= closes.length; end++)
      expect(pnf(closes.slice(0, end)).signals).toEqual(
        full.signals.filter((signal) => signal.barIndex < end),
      );
  });

  it("treats a box-size change as a new research version", () => {
    const base = pnf([10, 15, 16, 12], 1, 3);
    const other = pnf([10, 15, 16, 12], 2, 3);
    expect(base.columns[0]).toMatchObject({ bottom: 11, top: 16 });
    expect(other.columns[0]).toMatchObject({ bottom: 6, top: 8 });
    expect(base.boxSize).toBe(1);
    expect(other.boxSize).toBe(2);
  });

  it("returns UNKNOWN when floor(close/box) is not a safe integer", () => {
    const result = pnf([10, 1e300], 1e-300, 3);
    expect(result.status).toBe("UNKNOWN");
    expect(result.resets).toEqual([0, 1]);
    expect(result.columns).toEqual([]);
  });

  it("returns UNKNOWN for missing or invalid parameters", () => {
    const invalid: readonly (readonly [number, number])[] = [
      [0, 3],
      [-1, 3],
      [2, 0],
      [2, 1.5],
      [Number.NaN, 3],
    ];
    for (const [boxSize, reversal] of invalid)
      expect(pnf([10, 13], boxSize, reversal).status).toBe("UNKNOWN");
    expect(pnf([]).status).toBe("UNKNOWN");
    expect(pointAndFigure(null).status).toBe("UNKNOWN");
  });

  it("does not mutate deep-frozen closes and freezes its outputs", () => {
    const input = deepFreeze({
      closes: [10, 13, 14, 11, 10, 8, 11, 15, 16, 12, 7, 6] as (
        number | null
      )[],
      boxSize: 1,
      reversal: 3,
    });
    const before = structuredClone(input);
    const result = pointAndFigure(input);
    expect(input).toEqual(before);
    expect(Object.isFrozen(result.columns)).toBe(true);
    expect(Object.isFrozen(result.signals)).toBe(true);
  });
});
