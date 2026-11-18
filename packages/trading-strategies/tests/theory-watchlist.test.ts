import { describe, expect, it } from "vitest";
import type { Bar } from "trading-strategy-core/bars";
import {
  livermoreWatchlistDecision,
  themeLeaderSelection,
  type LivermoreAnchor,
  type LivermoreWatchlistInput,
  type ThemeLeaderInput,
  type ThemeLeaderState,
} from "../src/theory-watchlist.js";

const DECISION = "2026-11-17";
const AS_OF = "2026-11-17T16:00:00+08:00";
const BEFORE_CUTOFF = "2026-11-17T14:00:00+08:00";
const FREEZE = "2026-11-16T16:00:00+08:00";
const CONFIRMED = "2026-11-10T16:00:00+08:00";

function bar(date: string, close: number, amount = 1_000_000): Bar {
  return {
    date,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1000,
    amount,
  };
}

function shift(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function dailyBars(closes: readonly number[], start = "2026-11-01"): Bar[] {
  return closes.map((close, index) => bar(shift(start, index), close));
}

function barsOnDates(
  dates: readonly string[],
  closes: readonly number[],
): Bar[] {
  return dates.map((date, index) => bar(date, closes[index]!));
}

/* ------------------------------------------------------------------------- */
/* F02.07 Livermore watchlist                                                 */
/* ------------------------------------------------------------------------- */

const f02Closes = [
  100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 101, 102, 103, 104, 104,
  105, 106,
];
const f02Benchmark = Array.from({ length: 17 }, () => 100);

function anchor(overrides: Partial<LivermoreAnchor> = {}): LivermoreAnchor {
  return {
    anchorId: "a1",
    symbol: "AAA",
    upper: 105,
    lower: 95,
    confirmedBarDate: "2026-11-10",
    confirmedAt: CONFIRMED,
    ...overrides,
  };
}

function f02Input(
  overrides: Partial<LivermoreWatchlistInput> = {},
): LivermoreWatchlistInput {
  return {
    market: "cn-equity",
    asOf: AS_OF,
    decisionDate: DECISION,
    lookback: 3,
    maxCandidateAge: 10,
    universe: {
      frozenAt: FREEZE,
      members: [{ symbol: "AAA", bars: dailyBars(f02Closes) }],
    },
    benchmark: {
      symbol: "MKT",
      frozenAt: FREEZE,
      bars: dailyBars(f02Benchmark),
    },
    anchors: [anchor()],
    position: null,
    state: { consumedAnchorIds: [], pendingEnterAnchorIds: [] },
    ...overrides,
  };
}

describe("F02.07 livermoreWatchlistDecision", () => {
  it("enters on a leader close crossing the confirmed resistance", () => {
    const result = livermoreWatchlistDecision(f02Input());
    expect(result.status).toBe("ENTER");
    expect(result.enterIntent).toMatchObject({
      anchorId: "a1",
      symbol: "AAA",
      upper: 105,
      lower: 95,
      protection: 95,
      triggerClose: 106,
      previousClose: 105,
    });
    // 106 / 104 - 1 = 0.019230769..., benchmark flat.
    expect(result.enterIntent?.excessReturn).toBeCloseTo(0.019230769231, 12);
    expect(result.state.consumedAnchorIds).toEqual(["a1"]);
    expect(result.state.pendingEnterAnchorIds).toEqual(["a1"]);
    expect(result.candidates[0]).toMatchObject({
      status: "TRIGGER",
      age: 7,
      close: 106,
      previousClose: 105,
    });

    // Feeding the returned state does not repeat the ENTER intent.
    const replay = livermoreWatchlistDecision({
      ...f02Input(),
      state: result.state,
    });
    expect(replay.status).toBe("WAIT");
    expect(replay.enterIntent).toBeNull();
  });

  it("rejects crypto, a decision bar before 15:05, and a later-day asOf", () => {
    expect(() =>
      livermoreWatchlistDecision({
        ...f02Input(),
        market: "crypto" as "cn-equity",
      }),
    ).toThrow(/cn-equity/);
    expect(() =>
      livermoreWatchlistDecision({ ...f02Input(), asOf: BEFORE_CUTOFF }),
    ).toThrow(/completed|cutoff/);
    expect(() =>
      livermoreWatchlistDecision({
        ...f02Input(),
        asOf: "2026-11-18T10:00:00+08:00",
      }),
    ).toThrow(/same Shanghai market day/);
  });

  it("does not let a later freeze backfill a historical decision", () => {
    expect(() =>
      livermoreWatchlistDecision({
        ...f02Input(),
        universe: {
          frozenAt: "2026-11-17T15:30:00+08:00",
          members: [{ symbol: "AAA", bars: dailyBars(f02Closes) }],
        },
      }),
    ).toThrow(/decision cutoff/);
  });

  it("keeps a future confirmation UNKNOWN and never backfills it", () => {
    const result = livermoreWatchlistDecision(
      f02Input({
        anchors: [
          anchor({
            confirmedBarDate: "2026-11-16",
            confirmedAt: "2026-11-17T15:30:00+08:00",
          }),
        ],
      }),
    );
    expect(result.status).toBe("UNKNOWN");
    expect(result.enterIntent).toBeNull();
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "ANCHOR_CONFIRMED_AFTER_CUTOFF" }),
    );
  });

  it("rejects an anchor whose daily bar was not complete at confirmation", () => {
    const result = livermoreWatchlistDecision(
      f02Input({
        anchors: [
          anchor({
            confirmedBarDate: DECISION,
            confirmedAt: "2026-11-17T10:00:00+08:00",
          }),
        ],
      }),
    );
    expect(result.status).toBe("UNKNOWN");
    expect(result.enterIntent).toBeNull();
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "ANCHOR_NOT_COMPLETED_AT_CONFIRMATION",
      }),
    );
  });

  it("accepts an anchor confirmed at the 15:05 daily completion", () => {
    const result = livermoreWatchlistDecision(
      f02Input({
        anchors: [
          anchor({
            confirmedBarDate: DECISION,
            confirmedAt: "2026-11-17T15:05:00+08:00",
          }),
        ],
      }),
    );
    expect(result.status).toBe("ENTER");
    expect(result.enterIntent?.anchorId).toBe("a1");
  });

  it("protects a held position before any benchmark or watchlist check", () => {
    const position = {
      symbol: "HELD",
      lower: 95,
      fillId: "fill-1",
      bars: dailyBars([...f02Closes.slice(0, 16), 94]),
    };
    const result = livermoreWatchlistDecision(
      f02Input({
        universe: null,
        benchmark: null,
        anchors: [],
        position,
      }),
    );
    expect(result.status).toBe("EXIT");
    expect(result.protection).toBe(95);
    expect(result.exitIntent).toMatchObject({
      symbol: "HELD",
      protection: 95,
      close: 94,
      fillId: "fill-1",
    });

    const hold = livermoreWatchlistDecision(
      f02Input({
        universe: null,
        benchmark: null,
        anchors: [],
        position: {
          ...position,
          bars: dailyBars([...f02Closes.slice(0, 16), 96]),
        },
      }),
    );
    expect(hold.status).toBe("HOLD");
    expect(hold.protection).toBe(95);
  });

  it("refuses a stale position close instead of HOLD/EXIT", () => {
    const result = livermoreWatchlistDecision(
      f02Input({
        universe: null,
        benchmark: null,
        anchors: [],
        position: {
          symbol: "HELD",
          lower: 95,
          fillId: "fill-1",
          // Latest bar is Nov 16, not the decision-day Nov 17.
          bars: dailyBars(f02Closes.slice(0, 16)),
        },
      }),
    );
    expect(result.status).toBe("UNKNOWN");
    expect(result.protection).toBe(95);
    expect(result.exitIntent).toBeNull();
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "POSITION_CLOSE_UNKNOWN" }),
    );
  });

  it("keeps an EXIT pending until the host reports the actual fill flat", () => {
    const first = livermoreWatchlistDecision(
      f02Input({
        universe: null,
        benchmark: null,
        anchors: [],
        position: {
          symbol: "HELD",
          lower: 95,
          fillId: "f1",
          bars: dailyBars([...f02Closes.slice(0, 16), 94]),
        },
      }),
    );
    expect(first.status).toBe("EXIT");
    expect(first.exitIntent).toMatchObject({
      fillId: "f1",
      close: 94,
      triggerDate: DECISION,
      pending: false,
    });
    expect(first.state.pendingExit).toMatchObject({
      fillId: "f1",
      protection: 95,
      triggerDate: DECISION,
      triggerClose: 94,
    });

    // A rebound with the same actual fill does not clear the exit.
    const rebound = livermoreWatchlistDecision({
      ...f02Input(),
      asOf: "2026-11-18T16:00:00+08:00",
      decisionDate: "2026-11-18",
      lookback: 0,
      maxCandidateAge: -1,
      universe: null,
      benchmark: null,
      anchors: [],
      position: {
        symbol: "HELD",
        lower: 95,
        fillId: "f1",
        bars: dailyBars([...f02Closes.slice(0, 16), 94, 120]),
      },
      state: first.state,
    });
    expect(rebound.status).toBe("EXIT");
    expect(rebound.exitIntent).toMatchObject({
      fillId: "f1",
      close: 94,
      triggerDate: DECISION,
      pending: true,
    });
    expect(rebound.state.pendingExit?.fillId).toBe("f1");
  });

  it("keeps pending protection without a fresh close, benchmark or entry params", () => {
    const first = livermoreWatchlistDecision(
      f02Input({
        universe: null,
        benchmark: null,
        anchors: [],
        position: {
          symbol: "HELD",
          lower: 95,
          fillId: "f1",
          bars: dailyBars([...f02Closes.slice(0, 16), 94]),
        },
      }),
    );
    const morning = livermoreWatchlistDecision({
      ...f02Input(),
      asOf: "2026-11-18T09:30:00+08:00",
      decisionDate: "2026-11-18",
      lookback: 0,
      maxCandidateAge: -1,
      universe: null,
      benchmark: null,
      anchors: [],
      position: {
        symbol: "HELD",
        lower: 95,
        fillId: "f1",
        // No current decision-day bar at all.
        bars: dailyBars(f02Closes.slice(0, 16)),
      },
      state: first.state,
    });
    expect(morning.status).toBe("EXIT");
    expect(morning.exitIntent).toMatchObject({
      fillId: "f1",
      close: 94,
      protection: 95,
      pending: true,
    });
    expect(morning.asOf).toBe(Date.parse("2026-11-18T09:30:00+08:00"));
  });

  it("rejects a pending exit whose original trigger was not a completed bar", () => {
    const pendingState = {
      consumedAnchorIds: [],
      pendingEnterAnchorIds: [],
      pendingExit: {
        fillId: "f1",
        symbol: "HELD",
        protection: 95,
        triggerDate: DECISION,
        triggerClose: 94,
        // Same-day morning: the daily trigger bar was not complete yet.
        decidedAt: Date.parse("2026-11-17T09:30:00+08:00"),
      },
    };
    const result = livermoreWatchlistDecision({
      ...f02Input(),
      universe: null,
      benchmark: null,
      anchors: [],
      position: undefined,
      state: pendingState,
    });
    expect(result.status).toBe("UNKNOWN");
    expect(result.exitIntent).toBeNull();
    expect(result.state.pendingExit).toEqual(pendingState.pendingExit);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "PENDING_EXIT_INCONSISTENT" }),
    );
  });

  it("rejects a pending exit whose trigger date is later than its decision clock", () => {
    const result = livermoreWatchlistDecision({
      ...f02Input(),
      asOf: "2026-11-18T16:00:00+08:00",
      decisionDate: "2026-11-18",
      universe: null,
      benchmark: null,
      anchors: [],
      position: undefined,
      state: {
        consumedAnchorIds: [],
        pendingEnterAnchorIds: [],
        pendingExit: {
          fillId: "f1",
          symbol: "HELD",
          protection: 95,
          // The current decision date admits this trigger date, but it was not
          // complete at the original (earlier) decision clock.
          triggerDate: "2026-11-18",
          triggerClose: 94,
          decidedAt: Date.parse("2026-11-17T16:00:00+08:00"),
        },
      },
    });
    expect(result.status).toBe("UNKNOWN");
    expect(result.exitIntent).toBeNull();
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "PENDING_EXIT_INCONSISTENT" }),
    );
  });

  it("rejects a pending exit decided after the current decision clock", () => {
    const result = livermoreWatchlistDecision({
      ...f02Input(),
      asOf: "2026-11-18T09:30:00+08:00",
      decisionDate: "2026-11-18",
      universe: null,
      benchmark: null,
      anchors: [],
      position: undefined,
      state: {
        consumedAnchorIds: [],
        pendingEnterAnchorIds: [],
        pendingExit: {
          fillId: "f1",
          symbol: "HELD",
          protection: 95,
          triggerDate: "2026-11-17",
          triggerClose: 94,
          decidedAt: Date.parse("2026-11-18T16:00:00+08:00"),
        },
      },
    });
    expect(result.status).toBe("UNKNOWN");
    expect(result.exitIntent).toBeNull();
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "PENDING_EXIT_INCONSISTENT" }),
    );
  });

  it("rejects a pending exit whose trigger close did not breach protection", () => {
    const result = livermoreWatchlistDecision({
      ...f02Input(),
      universe: null,
      benchmark: null,
      anchors: [],
      position: undefined,
      state: {
        consumedAnchorIds: [],
        pendingEnterAnchorIds: [],
        pendingExit: {
          fillId: "f1",
          symbol: "HELD",
          protection: 95,
          triggerDate: DECISION,
          triggerClose: 96,
          decidedAt: Date.parse(AS_OF),
        },
      },
    });
    expect(result.status).toBe("UNKNOWN");
    expect(result.exitIntent).toBeNull();
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "PENDING_EXIT_INCONSISTENT" }),
    );
  });

  it("does not emit a pending exit for a same-fill conflicting symbol", () => {
    const result = livermoreWatchlistDecision({
      ...f02Input(),
      asOf: "2026-11-18T16:00:00+08:00",
      decisionDate: "2026-11-18",
      universe: null,
      benchmark: null,
      anchors: [],
      position: {
        symbol: "OTHER",
        lower: 95,
        fillId: "f1",
        bars: dailyBars([...f02Closes.slice(0, 16), 94, 120]),
      },
      state: {
        consumedAnchorIds: [],
        pendingEnterAnchorIds: [],
        pendingExit: {
          fillId: "f1",
          symbol: "HELD",
          protection: 95,
          triggerDate: DECISION,
          triggerClose: 94,
          decidedAt: Date.parse(AS_OF),
        },
      },
    });
    expect(result.status).toBe("UNKNOWN");
    expect(result.exitIntent).toBeNull();
    expect(result.state.pendingExit?.symbol).toBe("HELD");
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "PENDING_EXIT_INCONSISTENT" }),
    );
  });

  it("replays the same pending exit idempotently", () => {
    const input = {
      ...f02Input(),
      asOf: "2026-11-18T09:30:00+08:00",
      decisionDate: "2026-11-18",
      universe: null,
      benchmark: null,
      anchors: [],
      position: undefined,
      state: {
        consumedAnchorIds: [],
        pendingEnterAnchorIds: [],
        pendingExit: {
          fillId: "f1",
          symbol: "HELD",
          protection: 95,
          triggerDate: DECISION,
          triggerClose: 94,
          decidedAt: Date.parse(AS_OF),
        },
      },
    };
    const first = livermoreWatchlistDecision(input);
    const second = livermoreWatchlistDecision(input);
    expect(first.status).toBe("EXIT");
    expect(second).toEqual(first);
  });

  it("clears a pending exit only on explicit position:null", () => {
    const first = livermoreWatchlistDecision(
      f02Input({
        universe: null,
        benchmark: null,
        anchors: [],
        position: {
          symbol: "HELD",
          lower: 95,
          fillId: "f1",
          bars: dailyBars([...f02Closes.slice(0, 16), 94]),
        },
      }),
    );
    const flat = livermoreWatchlistDecision({
      ...f02Input(),
      asOf: "2026-11-18T16:00:00+08:00",
      decisionDate: "2026-11-18",
      position: null,
      state: first.state,
    });
    expect(flat.status).not.toBe("EXIT");
    expect(flat.exitIntent).toBeNull();
    expect(flat.state.pendingExit).toBeNull();
  });

  it("does not apply a pending exit to a different actual fill", () => {
    const first = livermoreWatchlistDecision(
      f02Input({
        universe: null,
        benchmark: null,
        anchors: [],
        position: {
          symbol: "HELD",
          lower: 95,
          fillId: "f1",
          bars: dailyBars([...f02Closes.slice(0, 16), 94]),
        },
      }),
    );
    const hold = livermoreWatchlistDecision({
      ...f02Input(),
      asOf: "2026-11-18T16:00:00+08:00",
      decisionDate: "2026-11-18",
      universe: null,
      benchmark: null,
      anchors: [],
      position: {
        symbol: "HELD",
        lower: 95,
        fillId: "f2",
        bars: dailyBars([...f02Closes.slice(0, 16), 94, 120]),
      },
      state: first.state,
    });
    expect(hold.status).toBe("HOLD");
    expect(hold.exitIntent).toBeNull();
    expect(hold.state.pendingExit).toBeNull();

    const newExit = livermoreWatchlistDecision({
      ...f02Input(),
      asOf: "2026-11-18T16:00:00+08:00",
      decisionDate: "2026-11-18",
      universe: null,
      benchmark: null,
      anchors: [],
      position: {
        symbol: "HELD",
        lower: 95,
        fillId: "f2",
        bars: dailyBars([...f02Closes.slice(0, 16), 94, 90]),
      },
      state: first.state,
    });
    expect(newExit.status).toBe("EXIT");
    expect(newExit.exitIntent).toMatchObject({ fillId: "f2", pending: false });
    expect(newExit.state.pendingExit?.fillId).toBe("f2");
  });

  it("uses only trustworthy current OHLC for a known price stop", () => {
    const corruptOld = dailyBars([...f02Closes.slice(0, 16), 94]).map(
      (item, index) =>
        index < 16
          ? { ...item, high: item.low - 1, volume: -5, amount: Number.NaN }
          : { ...item, volume: 0, amount: Number.NaN },
    );
    const result = livermoreWatchlistDecision({
      ...f02Input(),
      lookback: 0,
      maxCandidateAge: -1,
      universe: null,
      benchmark: null,
      anchors: [],
      position: {
        symbol: "HELD",
        lower: 95,
        fillId: "f1",
        bars: corruptOld,
      },
    });
    expect(result.status).toBe("EXIT");
    expect(result.exitIntent).toMatchObject({
      fillId: "f1",
      close: 94,
      protection: 95,
      pending: false,
    });
  });

  it("treats duplicate decision-day position bars as ambiguous", () => {
    const result = livermoreWatchlistDecision(
      f02Input({
        universe: null,
        benchmark: null,
        anchors: [],
        position: {
          symbol: "HELD",
          lower: 95,
          fillId: "f1",
          bars: [
            ...dailyBars(f02Closes.slice(0, 16)),
            bar(DECISION, 94),
            bar(DECISION, 120),
          ],
        },
      }),
    );
    expect(result.status).toBe("UNKNOWN");
    expect(result.exitIntent).toBeNull();
    expect(result.state.pendingExit).toBeNull();
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "AMBIGUOUS_DECISION_BAR" }),
    );
  });

  it("does not treat the current morning as a completed F02 decision bar", () => {
    expect(() =>
      livermoreWatchlistDecision({
        ...f02Input(),
        asOf: "2026-11-17T09:30:00+08:00",
      }),
    ).toThrow(/completed|cutoff/);
  });

  it("consumes a broken or expired anchor even when the benchmark is missing", () => {
    const broken = livermoreWatchlistDecision(
      f02Input({
        benchmark: null,
        anchors: [anchor({ upper: 108, lower: 107 })],
      }),
    );
    expect(broken.status).toBe("UNKNOWN");
    expect(broken.state.consumedAnchorIds).toEqual(["a1"]);
    expect(broken.candidates[0]?.status).toBe("BELOW_PROTECTION");

    const expired = livermoreWatchlistDecision(
      f02Input({
        benchmark: null,
        maxCandidateAge: 2,
        anchors: [anchor({ confirmedBarDate: "2026-11-01" })],
      }),
    );
    expect(expired.state.consumedAnchorIds).toEqual(["a1"]);
    expect(expired.candidates[0]?.status).toBe("EXPIRED");
  });

  it("requires strict one-for-one benchmark date alignment", () => {
    const missingStart = livermoreWatchlistDecision(
      f02Input({
        universe: {
          frozenAt: FREEZE,
          members: [
            {
              symbol: "AAA",
              bars: dailyBars(f02Closes).map((item) =>
                item.date === "2026-11-14" ? null : item,
              ),
            },
          ],
        },
      }),
    );
    expect(missingStart.status).toBe("UNKNOWN");
    expect(missingStart.enterIntent).toBeNull();

    const benchmarkMissingStart = livermoreWatchlistDecision(
      f02Input({
        benchmark: {
          symbol: "MKT",
          frozenAt: FREEZE,
          bars: dailyBars(f02Benchmark).map((item) =>
            item.date === "2026-11-14" ? null : item,
          ),
        },
      }),
    );
    expect(benchmarkMissingStart.status).toBe("UNKNOWN");
    expect(benchmarkMissingStart.enterIntent).toBeNull();
  });

  it("does not change an early decision when future bars are appended", () => {
    const base = livermoreWatchlistDecision(f02Input());
    const withFuture = livermoreWatchlistDecision(
      f02Input({
        universe: {
          frozenAt: FREEZE,
          members: [
            {
              symbol: "AAA",
              bars: [
                ...dailyBars(f02Closes),
                bar("2026-11-18", 200),
                null,
                bar("2026-11-19", 300),
              ],
            },
          ],
        },
        benchmark: {
          symbol: "MKT",
          frozenAt: FREEZE,
          bars: [
            ...dailyBars(f02Benchmark),
            bar("2026-11-18", 50),
            null,
            bar("2026-11-19", 40),
          ],
        },
      }),
    );
    expect(withFuture).toEqual(base);
  });

  it("does not enter when the symbol is not a leader", () => {
    const result = livermoreWatchlistDecision(
      f02Input({
        benchmark: {
          symbol: "MKT",
          frozenAt: FREEZE,
          bars: dailyBars([
            ...f02Benchmark.slice(0, 13),
            100,
            ...f02Benchmark.slice(14),
          ]).map((item) =>
            item.date === "2026-11-17" ? bar(item.date, 110) : item,
          ),
        },
      }),
    );
    expect(result.status).toBe("WAIT");
    expect(result.enterIntent).toBeNull();
    expect(result.candidates[0]?.status).toBe("WAIT");
  });

  it("never adds a symbol from outside the frozen watchlist", () => {
    const result = livermoreWatchlistDecision(
      f02Input({ anchors: [anchor({ symbol: "ZZZ" })] }),
    );
    expect(result.status).toBe("UNKNOWN");
    expect(result.enterIntent).toBeNull();
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "ANCHOR_SYMBOL_NOT_IN_WATCHLIST" }),
    );
  });
});

/* ------------------------------------------------------------------------- */
/* F11.02 theme leader selection                                              */
/* ------------------------------------------------------------------------- */

const THEME_FREEZE = "2026-11-17T09:00:00+08:00";
const AAA_CLOSES = [100, 101, 102, 103, 104, 105, 106, 107, 108, 110];
const BBB_CLOSES = [100, 100, 100, 100, 100, 100, 100, 100, 100, 101];
const BENCHMARK_CLOSES = Array.from({ length: 10 }, () => 100);

function f11Bars(closes: readonly number[], start = "2026-11-07"): Bar[] {
  return dailyBars(closes, start);
}

function f11Input(overrides: Partial<ThemeLeaderInput> = {}): ThemeLeaderInput {
  return {
    market: "cn-equity",
    asOf: AS_OF,
    decisionDate: DECISION,
    params: {
      excessLookback: 3,
      fastMa: 2,
      slowMa: 3,
      rankFraction: 0.5,
      maxDrawdown: 0.5,
      stablePeriods: 2,
      minAmount: 1000,
    },
    theme: {
      themeId: "T1",
      frozenAt: THEME_FREEZE,
      members: [
        { symbol: "AAA", bars: f11Bars(AAA_CLOSES) },
        { symbol: "BBB", bars: f11Bars(BBB_CLOSES) },
      ],
    },
    benchmark: {
      symbol: "MKT",
      frozenAt: THEME_FREEZE,
      bars: f11Bars(BENCHMARK_CLOSES),
    },
    state: {
      candidateSymbol: null,
      rankOutStreak: 0,
      lastEvaluatedDate: null,
      lastEvaluatedBarDate: null,
    },
    ...overrides,
  };
}

function nextState(state: ThemeLeaderState): ThemeLeaderState {
  return state;
}

describe("F11.02 themeLeaderSelection", () => {
  it("selects the top eligible leader with complete metrics", () => {
    const result = themeLeaderSelection(f11Input());
    expect(result.status).toBe("LEADER");
    expect(result.leader?.symbol).toBe("AAA");
    expect(result.leader?.rank).toBe(1);
    expect(result.leader?.metrics).toMatchObject({
      close: 110,
      maFast: 109,
      maSlow: 108.333333333333,
      maSlowPrior: 106,
      amount: 1_000_000,
      rank: 1,
      rankEligible: true,
    });
    expect(result.leader?.metrics.excessReturn).toBeCloseTo(110 / 106 - 1, 12);
    expect(result.state).toEqual({
      candidateSymbol: "AAA",
      rankOutStreak: 0,
      lastEvaluatedDate: DECISION,
      lastEvaluatedBarDate: "2026-11-16",
    });
  });

  it("uses the previous completed day in the current morning", () => {
    const result = themeLeaderSelection(
      f11Input({
        asOf: "2026-11-17T09:30:00+08:00",
        theme: {
          themeId: "T1",
          frozenAt: THEME_FREEZE,
          members: [
            {
              symbol: "AAA",
              bars: [...f11Bars(AAA_CLOSES), bar("2026-11-17", 999)],
            },
            {
              symbol: "BBB",
              bars: [...f11Bars(BBB_CLOSES), bar("2026-11-17", 999)],
            },
          ],
        },
        benchmark: {
          symbol: "MKT",
          frozenAt: THEME_FREEZE,
          bars: [...f11Bars(BENCHMARK_CLOSES), bar("2026-11-17", 1)],
        },
      }),
    );
    expect(result.status).toBe("LEADER");
    expect(result.leader?.metrics.latestDate).toBe("2026-11-16");
    expect(result.leader?.metrics.close).toBe(110);
    expect(result.state.lastEvaluatedBarDate).toBe("2026-11-16");
  });

  it("requires drawdown and amount for a new selection", () => {
    const noAmount = themeLeaderSelection(
      f11Input({
        theme: {
          themeId: "T1",
          frozenAt: THEME_FREEZE,
          members: [
            {
              symbol: "AAA",
              bars: f11Bars(AAA_CLOSES).map((item, index) =>
                index === 9 ? { ...item, amount: 0 } : item,
              ),
            },
            { symbol: "BBB", bars: f11Bars(BBB_CLOSES) },
          ],
        },
      }),
    );
    expect(noAmount.status).toBe("NONE");
    expect(noAmount.leader).toBeNull();
    expect(noAmount.members[0]?.reasons).toContain("amount-below-minimum");

    const deepDrawdown = themeLeaderSelection(
      f11Input({
        params: {
          ...f11Input().params,
          maxDrawdown: 0.05,
        },
        theme: {
          themeId: "T1",
          frozenAt: THEME_FREEZE,
          members: [
            {
              symbol: "AAA",
              bars: f11Bars([100, 100, 100, 100, 100, 100, 100, 80, 90, 110]),
            },
            { symbol: "BBB", bars: f11Bars(BBB_CLOSES) },
          ],
        },
      }),
    );
    expect(deepDrawdown.members[0]?.reasons).toContain("drawdown-above-limit");
    expect(deepDrawdown.members[0]?.rankEligible).toBe(false);
  });

  it("keeps a known candidate until MA_m breaks or k adjacent rank-outs", () => {
    // BBB has higher excess, so AAA is rank 2 (out of the top 1) but still
    // above MA_m: the first out keeps the candidate with streak 1.
    const higherBbb = [100, 101, 102, 103, 104, 105, 106, 107, 108, 120];
    const first = themeLeaderSelection(
      f11Input({
        theme: {
          themeId: "T1",
          frozenAt: THEME_FREEZE,
          members: [
            { symbol: "AAA", bars: f11Bars(AAA_CLOSES) },
            { symbol: "BBB", bars: f11Bars(higherBbb) },
          ],
        },
        state: {
          candidateSymbol: "AAA",
          rankOutStreak: 0,
          lastEvaluatedDate: null,
          lastEvaluatedBarDate: null,
        },
      }),
    );
    expect(first.status).toBe("KEEP");
    expect(first.leader?.symbol).toBe("AAA");
    expect(first.state.rankOutStreak).toBe(1);

    // Replaying the same completed decision date never advances the streak.
    for (let replay = 0; replay < 3; replay++) {
      const repeated = themeLeaderSelection(
        f11Input({
          theme: {
            themeId: "T1",
            frozenAt: THEME_FREEZE,
            members: [
              { symbol: "AAA", bars: f11Bars(AAA_CLOSES) },
              { symbol: "BBB", bars: f11Bars(higherBbb) },
            ],
          },
          state: nextState(first.state),
        }),
      );
      expect(repeated.status).toBe("KEEP");
      expect(repeated.state.rankOutStreak).toBe(1);
      expect(repeated.state.candidateSymbol).toBe("AAA");
    }

    // The next adjacent completed day advances to k=2 and selects BBB.
    const nextDay = themeLeaderSelection(
      f11Input({
        asOf: "2026-11-18T16:00:00+08:00",
        decisionDate: "2026-11-18",
        theme: {
          themeId: "T1",
          frozenAt: THEME_FREEZE,
          members: [
            { symbol: "AAA", bars: f11Bars([...AAA_CLOSES, 111]) },
            { symbol: "BBB", bars: f11Bars([...higherBbb, 121]) },
          ],
        },
        benchmark: {
          symbol: "MKT",
          frozenAt: THEME_FREEZE,
          bars: f11Bars([...BENCHMARK_CLOSES, 100]),
        },
        state: nextState(first.state),
      }),
    );
    expect(nextDay.status).toBe("LEADER");
    expect(nextDay.leader?.symbol).toBe("BBB");
    expect(nextDay.state).toEqual({
      candidateSymbol: "BBB",
      rankOutStreak: 0,
      lastEvaluatedDate: "2026-11-18",
      lastEvaluatedBarDate: "2026-11-17",
    });
  });

  it("does not stitch a rank-out streak across a visible date gap", () => {
    const higherBbb = [100, 101, 102, 103, 104, 105, 106, 107, 108, 120];
    const state: ThemeLeaderState = {
      candidateSymbol: "AAA",
      rankOutStreak: 1,
      lastEvaluatedDate: "2026-11-17",
      lastEvaluatedBarDate: "2026-11-16",
    };
    // New visible window skips Nov 16-17; the previous visible day is Nov 15,
    // so the new observation starts a fresh chain at 1 instead of 2.
    const gapDates = [
      "2026-11-09",
      "2026-11-10",
      "2026-11-11",
      "2026-11-12",
      "2026-11-18",
    ];
    const result = themeLeaderSelection(
      f11Input({
        asOf: "2026-11-19T16:00:00+08:00",
        decisionDate: "2026-11-19",
        theme: {
          themeId: "T1",
          frozenAt: THEME_FREEZE,
          members: [
            {
              symbol: "AAA",
              bars: barsOnDates(gapDates, [100, 101, 102, 103, 110]),
            },
            {
              symbol: "BBB",
              bars: barsOnDates(gapDates, [100, 101, 102, 103, 120]),
            },
          ],
        },
        benchmark: {
          symbol: "MKT",
          frozenAt: THEME_FREEZE,
          bars: barsOnDates(gapDates, [100, 100, 100, 100, 100]),
        },
        state,
      }),
    );
    expect(result.status).toBe("KEEP");
    expect(result.leader?.symbol).toBe("AAA");
    expect(result.state.rankOutStreak).toBe(1);
  });

  it("cancels a known MA_m break even when the benchmark is missing", () => {
    const result = themeLeaderSelection(
      f11Input({
        benchmark: null,
        theme: {
          themeId: "T1",
          frozenAt: THEME_FREEZE,
          members: [
            {
              symbol: "AAA",
              bars: f11Bars([100, 110, 110, 110, 110, 110, 110, 110, 110, 100]),
            },
            { symbol: "BBB", bars: f11Bars(BBB_CLOSES) },
          ],
        },
        state: {
          candidateSymbol: "AAA",
          rankOutStreak: 0,
          lastEvaluatedDate: "2026-11-16",
          lastEvaluatedBarDate: "2026-11-13",
        },
      }),
    );
    expect(result.status).toBe("UNKNOWN");
    expect(result.state.candidateSymbol).toBeNull();
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "BENCHMARK_MISSING" }),
    );
  });

  it("does not reset a rank-out streak when the ranking is unknown", () => {
    const state: ThemeLeaderState = {
      candidateSymbol: "AAA",
      rankOutStreak: 1,
      lastEvaluatedDate: "2026-11-16",
      lastEvaluatedBarDate: "2026-11-13",
    };
    const result = themeLeaderSelection(f11Input({ benchmark: null, state }));
    expect(result.status).toBe("UNKNOWN");
    expect(result.state).toEqual(state);
  });

  it("does not shrink an incomplete frozen pool", () => {
    const result = themeLeaderSelection(
      f11Input({
        theme: {
          themeId: "T1",
          frozenAt: THEME_FREEZE,
          members: [
            { symbol: "AAA", bars: f11Bars(AAA_CLOSES) },
            { symbol: "BBB", bars: f11Bars([100, 101]) },
          ],
        },
        state: {
          candidateSymbol: "AAA",
          rankOutStreak: 0,
          lastEvaluatedDate: null,
          lastEvaluatedBarDate: null,
        },
      }),
    );
    expect(result.status).toBe("UNKNOWN");
    expect(result.members).toHaveLength(2);
    expect(result.state.candidateSymbol).toBe("AAA");
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "INCOMPLETE_POOL" }),
    );
  });

  it("does not accept a candidate outside the frozen pool", () => {
    const result = themeLeaderSelection(
      f11Input({
        state: {
          candidateSymbol: "ZZZ",
          rankOutStreak: 0,
          lastEvaluatedDate: null,
          lastEvaluatedBarDate: null,
        },
      }),
    );
    expect(result.status).toBe("UNKNOWN");
    expect(result.state.candidateSymbol).toBe("ZZZ");
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "CANDIDATE_NOT_IN_FROZEN_POOL" }),
    );
  });

  it("rejects an out-of-order state and a future freeze", () => {
    expect(() =>
      themeLeaderSelection(
        f11Input({
          state: {
            candidateSymbol: "AAA",
            rankOutStreak: 0,
            lastEvaluatedDate: "2026-11-18",
            lastEvaluatedBarDate: "2026-11-17",
          },
        }),
      ),
    ).toThrow(/ahead/);

    expect(() =>
      themeLeaderSelection(
        f11Input({
          theme: {
            themeId: "T1",
            frozenAt: "2026-11-17T17:00:00+08:00",
            members: [
              { symbol: "AAA", bars: f11Bars(AAA_CLOSES) },
              { symbol: "BBB", bars: f11Bars(BBB_CLOSES) },
            ],
          },
        }),
      ),
    ).toThrow(/postdate asOf/);
  });

  it("does not change an early decision when future bars are appended", () => {
    const base = themeLeaderSelection(f11Input());
    const withFuture = themeLeaderSelection(
      f11Input({
        theme: {
          themeId: "T1",
          frozenAt: THEME_FREEZE,
          members: [
            {
              symbol: "AAA",
              bars: [...f11Bars(AAA_CLOSES), bar("2026-11-17", 999)],
            },
            {
              symbol: "BBB",
              bars: [...f11Bars(BBB_CLOSES), bar("2026-11-17", 999)],
            },
          ],
        },
        benchmark: {
          symbol: "MKT",
          frozenAt: THEME_FREEZE,
          bars: [...f11Bars(BENCHMARK_CLOSES), bar("2026-11-17", 1)],
        },
      }),
    );
    expect(withFuture).toEqual(base);
  });
});
