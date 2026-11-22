import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bar, Snapshot } from "~/lib/domain";
import type { readBars } from "~/server/market/bar-store/read-bars";
import {
  prepareStrategy,
  utcOrbSessionBars,
  utcOrbSessionDay,
  utcOrbShiftDay,
  utcOrbSlotIndex,
  utcOrbSlotLabel,
  utcOrbStrategy,
} from "trading-strategies";
import { runPortfolio } from "quant-backtest";

const state = vi.hoisted(() => ({
  bars: [] as Bar[],
  forming: [] as string[],
  repaired: false,
  hash: "slice-source",
}));
vi.mock("~/server/market/bar-store/binance-archive-source", () => ({
  binanceArchiveSource: async () => ({ bars: state.bars, hash: "archive" }),
}));
import { loadTheoryOrbSource } from "~/server/research/theory-orb-source";
import { freezePortfolioExecution } from "~/server/research/freeze-portfolio-execution";
import { labBacktestEvidence } from "~/server/research/lab-backtest-evidence";

const firstDay = "2026-10-01";
const days = Array.from({ length: 16 }, (_, i) => utcOrbShiftDay(firstDay, i));
const startDay = days[14]!;
const endDay = days[15]!;

function bar(label: string, close: number): Bar {
  return {
    date: label,
    open: close,
    high: close + 0.5,
    low: close - 0.5,
    close,
    volume: 10,
    amount: 1000,
  };
}

function dayBars(day: string, closes: Record<number, number> = {}) {
  return Array.from({ length: utcOrbSessionBars }, (_, slot) =>
    bar(utcOrbSlotLabel(day, slot), closes[slot] ?? 100),
  );
}

function fixture() {
  return days.flatMap((day) => dayBars(day));
}

const read = vi.fn(
  async (input: Parameters<typeof readBars>[0], frozen?: Snapshot) => {
    const from = Date.parse(input.from!),
      to = Date.parse(input.to!);
    const bars = frozen!.bars.filter((row) => {
      const time = Date.parse(row.date);
      // Invalid labels stay in the snapshot so the adapter must reject them.
      return !Number.isFinite(time) || (time >= from && time <= to);
    });
    return {
      id: "fixture",
      symbol: input.instrument.symbol,
      period: "5m",
      source: "local",
      adjustment: "none",
      createdAt: 0,
      bars,
      rawBars: bars,
      hash: state.hash,
      barStore: {
        version: "bar-store-1",
        market: "crypto",
        sourceFingerprint: "fingerprint",
        sourceVersions: ["v1"],
        adjustment: "none",
        adjustmentReference: null,
        coverage: {
          from: null,
          to: null,
          count: bars.length,
          historyExhausted: true,
        },
        formingDates: state.forming,
        priceRepaired: state.repaired,
        overlay: null,
        excluded: [],
      },
    };
  },
) as unknown as typeof readBars;

function options(
  overrides: {
    start?: string;
    end?: string;
    symbols?: string[];
  } = {},
) {
  return {
    strategy: utcOrbStrategy(overrides.symbols ?? ["cxBTCUSDT"]),
    start: overrides.start ?? startDay,
    end: overrides.end ?? endDay,
    config: { tdxRoot: "E:/fixture", binancePublicDataRoot: "D:/fixture" },
    read,
    now: Date.parse(`${utcOrbShiftDay(endDay, 1)}T12:00:00Z`),
  };
}

beforeEach(() => {
  state.bars = fixture();
  state.forming = [];
  state.repaired = false;
  state.hash = "slice-source";
  vi.clearAllMocks();
});

describe("UTC ORB source adapter", () => {
  it("reports the configured byte ceiling for frozen ORB bars", async () => {
    try {
      vi.stubEnv("QUANT_BAR_STORE_MAX_ESTIMATED_BYTES", "256");
      await expect(loadTheoryOrbSource(options())).rejects.toMatchObject({
        code: "BAR_STORE_BUDGET_EXCEEDED",
        diagnostic: {
          symbol: "cxBTCUSDT",
          period: "5m",
          stage: "output",
          requestedBars: state.bars.length,
          maxEstimatedBytes: 256,
        },
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("freezes raw unadjusted 5m sessions with expected slots and coverage", async () => {
    const result = await loadTheoryOrbSource(options());
    expect(result.instruments).toHaveLength(1);
    const instrument = result.instruments[0]!;
    expect(instrument.bars).toHaveLength(16 * utcOrbSessionBars);
    expect(instrument.signalBars).toBe(instrument.bars);
    const orb = instrument.external!.orb!;
    expect(orb.adjustmentId).toMatch(/^[a-f0-9]{64}$/);
    expect(orb.calendarHash).toBe("continuous-UTC-v1");
    expect(orb.sessions.find((s) => s.day === startDay)?.upper).toBeCloseTo(
      101,
    );
    expect(orb.sessions.find((s) => s.day === startDay)?.lower).toBeCloseTo(99);
    expect(orb.coverage.completeSessions).toBe(16);
    expect(result.calendar).toHaveLength(2 * utcOrbSessionBars);
    expect(result.start).toBe(utcOrbSlotLabel(startDay, 0));
    expect(result.end).toBe(utcOrbSlotLabel(endDay, 287));
    const source = result.sources[0]!;
    expect(source.expected5mSlots).toBe(2 * utcOrbSessionBars);
    expect(source.observed5mSlots).toBe(2 * utcOrbSessionBars);
    expect(source.missing5mSlots).toBe(0);
    expect(source.prior10CompleteBeforeStart).toBe(10);
    expect(source.adjustment).toBe("none");
    expect(source.sourceHash).toBe("slice-source");
    expect(source.rawHash).toMatch(/^[a-f0-9]{64}$/);
    const readiness = source.readiness as {
      dataQualification: { status: string };
      independentValidation: { status: string };
      forwardObservation: { status: string };
    };
    expect(readiness.dataQualification.status).toBe("partial");
    expect(readiness.independentValidation.status).toBe("unknown");
    expect(readiness.forwardObservation.status).toBe("unknown");
  });

  it("counts structurally complete 288-bar days even before warmup eligibility", async () => {
    const keep = utcOrbSlotLabel(endDay, 0);
    state.bars = fixture().filter(
      (row) => utcOrbSessionDay(row.date) !== endDay || row.date === keep,
    );
    const result = await loadTheoryOrbSource(options());
    expect(
      result.instruments[0]!.external!.orb!.coverage.completeSessions,
    ).toBe(15);
  });

  it("passes readiness with exactly 10 complete prior days and fails when one slot is missing", async () => {
    const readinessOf = (bars: Bar[]) => {
      state.bars = bars;
      return loadTheoryOrbSource(
        options({ start: days[10]!, end: days[11]! }),
      ).then(
        (result) =>
          result.sources[0]!.readiness as {
            dataQualification: {
              status: string;
              warmup: {
                status: string;
                series: {
                  requiredBars: number;
                  consecutiveCompleteBeforeStart: number;
                  status: string;
                }[];
              };
            };
          },
      );
    };
    const complete = days
      .slice(0, 12)
      .flatMap((day) => dayBars(day, day === days[10] ? { 2: 102 } : {}));
    const ready = await readinessOf(complete);
    expect(ready.dataQualification.warmup.status).toBe("met");
    expect(
      ready.dataQualification.warmup.series[0]!.consecutiveCompleteBeforeStart,
    ).toBe(10 * utcOrbSessionBars);
    expect(ready.dataQualification.status).not.toBe("unqualified");
    const missing = complete.filter(
      (row) => row.date !== utcOrbSlotLabel(days[5]!, 100),
    );
    const incomplete = await readinessOf(missing);
    expect(incomplete.dataQualification.warmup.status).toBe("unmet");
    expect(incomplete.dataQualification.status).not.toBe("qualified");
  });

  it("preserves gaps as unknown and never fabricates missing OHLC", async () => {
    state.bars = state.bars.filter(
      (row) => row.date !== utcOrbSlotLabel(startDay, 1),
    );
    const result = await loadTheoryOrbSource(options());
    const orb = result.instruments[0]!.external!.orb!;
    const session = orb.sessions.find((s) => s.day === startDay)!;
    expect(session.opening).not.toBeNull();
    expect(result.calendar).toContain(utcOrbSlotLabel(startDay, 1));
    expect(
      result.instruments[0]!.bars.some(
        (row) => row.date === utcOrbSlotLabel(startDay, 1),
      ),
    ).toBe(false);
    expect(result.sources[0]!.missing5mSlots).toBe(1);
    const prepared = prepareStrategy(
      utcOrbStrategy(["cxBTCUSDT"]),
      result.instruments[0]!.bars,
      { orb },
    );
    const index = result.instruments[0]!.bars.findIndex(
      (row) => row.date === utcOrbSlotLabel(startDay, 2),
    );
    expect(prepared.explain(index).entry).toBeNull();
  });

  it("marks the session unknown when prior 10 complete days are unavailable", async () => {
    state.bars = days
      .slice(0, 11)
      .flatMap((day) => dayBars(day, day === startDay ? { 2: 102 } : {}));
    const result = await loadTheoryOrbSource(
      options({ start: days[9]!, end: days[10]! }),
    );
    const orb = result.instruments[0]!.external!.orb!;
    expect(orb.sessions.find((s) => s.day === days[9]!)?.unknown).toBe(
      "prior-10-days-incomplete",
    );
    expect(result.sources[0]!.prior10CompleteBeforeStart).toBe(0);
    const prepared = prepareStrategy(
      utcOrbStrategy(["cxBTCUSDT"]),
      result.instruments[0]!.bars,
      { orb },
    );
    const index = result.instruments[0]!.bars.findIndex(
      (row) => row.date === utcOrbSlotLabel(days[9]!, 2),
    );
    expect(prepared.explain(index).entry).toBeNull();
  });

  it("rejects forming or repaired sources instead of using them", async () => {
    state.forming = [utcOrbSlotLabel(startDay, 0)];
    await expect(loadTheoryOrbSource(options())).rejects.toThrow(
      /未完成或修复/,
    );
    state.forming = [];
    state.repaired = true;
    await expect(loadTheoryOrbSource(options())).rejects.toThrow(
      /未完成或修复/,
    );
  });

  it("rejects a CN strategy or non-BTC/ETH symbols before reading", async () => {
    await expect(
      loadTheoryOrbSource({
        ...options(),
        strategy: {
          ...utcOrbStrategy(["cxBTCUSDT"]),
          market: "cn-equity",
        },
      }),
    ).rejects.toThrow(/crypto 5m/);
  });

  it("rejects impossible dates and invalid 5m labels instead of dropping them", async () => {
    await expect(
      loadTheoryOrbSource(options({ start: "2026-02-30" })),
    ).rejects.toThrow(/Invalid UTC ORB research dates/);
    state.bars = [
      ...state.bars,
      { ...state.bars[0]!, date: "not-a-utc-label" },
    ];
    await expect(loadTheoryOrbSource(options())).rejects.toThrow(
      /非法UTC 5分钟bar标签/,
    );
  });

  it("normalizes Z labels to +00:00 and yields identical portfolio execution", async () => {
    const markCross = (rows: Bar[]) =>
      rows.map((row) => {
        const day = utcOrbSessionDay(row.date);
        const slot = utcOrbSlotIndex(row.date);
        return day === startDay && slot === 2
          ? { ...row, open: 102, high: 102.5, low: 101.5, close: 102 }
          : row;
      });
    const plus = markCross(fixture());
    const z = markCross(
      fixture().map((row) => ({
        ...row,
        date: row.date.replace("+00:00", "Z"),
      })),
    );
    const run = async (rows: Bar[]) => {
      state.bars = rows;
      const loaded = await loadTheoryOrbSource(options());
      const request = {
        market: "crypto" as const,
        initial: 100000,
        start: loaded.start,
        end: loaded.end,
        calendar: loaded.calendar,
        instruments: loaded.instruments.map(freezePortfolioExecution),
        strategies: [utcOrbStrategy(["cxBTCUSDT"])],
        sleeves: [
          { id: "breakout", share: 1, riskPerTrade: 0.01, maxPositions: 2 },
        ],
      };
      return { loaded, request, result: runPortfolio(request) };
    };
    const plusRun = await run(plus);
    const zRun = await run(z);
    expect(
      zRun.loaded.instruments[0]!.bars.every((row) =>
        row.date.endsWith("+00:00"),
      ),
    ).toBe(true);
    expect(zRun.loaded.sources[0]!.rawHash).toBe(
      plusRun.loaded.sources[0]!.rawHash,
    );
    expect(zRun.loaded.sources[0]!.rawHashBasis).toBe(
      "normalized-UTC-slot-labels",
    );
    expect(zRun.result.orders).toEqual(plusRun.result.orders);
    expect(zRun.result.fills).toEqual(plusRun.result.fills);
    expect(zRun.result.curve).toEqual(plusRun.result.curve);
    const buys = plusRun.result.fills.filter((fill) => fill.side === "buy");
    const sells = plusRun.result.fills.filter((fill) => fill.side === "sell");
    expect(buys.length).toBeGreaterThan(0);
    expect(sells.at(-1)!.signalAt).toBe(utcOrbSlotLabel(startDay, 286));
    expect(sells.at(-1)!.date).toBe(utcOrbSlotLabel(startDay, 287));
  });

  it("consumes a rejected entry attempt and never repeats it that day", async () => {
    state.bars = fixture().map((row) =>
      row.date === utcOrbSlotLabel(startDay, 2)
        ? { ...row, open: 102, high: 102.5, low: 101.5, close: 102 }
        : row,
    );
    const loaded = await loadTheoryOrbSource(options());
    const result = runPortfolio({
      market: "crypto",
      initial: 0.001,
      start: loaded.start,
      end: loaded.end,
      calendar: loaded.calendar,
      instruments: loaded.instruments.map(freezePortfolioExecution),
      strategies: [utcOrbStrategy(["cxBTCUSDT"])],
      sleeves: [
        { id: "breakout", share: 1, riskPerTrade: 0.01, maxPositions: 2 },
      ],
    });
    const buys = result.orders.filter((order) => order.side === "buy");
    expect(buys).toHaveLength(1);
    expect(buys[0]!.status).toBe("rejected");
    expect(result.fills.filter((fill) => fill.side === "buy")).toHaveLength(0);
  });

  it("proves next-open execution: 00:15 signal fills at 00:20, 23:55 exit at 00:00", async () => {
    state.bars = fixture().map((row) =>
      row.date === utcOrbSlotLabel(startDay, 2)
        ? { ...row, open: 102, high: 102.5, low: 101.5, close: 102 }
        : row,
    );
    const loaded = await loadTheoryOrbSource(options());
    const strategy = utcOrbStrategy(["cxBTCUSDT"]);
    const request = {
      market: "crypto" as const,
      initial: 100000,
      start: loaded.start,
      end: loaded.end,
      calendar: loaded.calendar,
      instruments: loaded.instruments.map(freezePortfolioExecution),
      strategies: [strategy],
      sleeves: [
        {
          id: "breakout",
          share: 1,
          riskPerTrade: 0.01,
          maxPositions: 2,
        },
      ],
    };
    const result = runPortfolio(request);
    const buys = result.fills.filter((fill) => fill.side === "buy");
    expect(buys).toHaveLength(1);
    expect(buys[0]!.signalAt).toBe(utcOrbSlotLabel(startDay, 2));
    expect(buys[0]!.date).toBe(utcOrbSlotLabel(startDay, 3));
    const sells = result.fills.filter((fill) => fill.side === "sell");
    expect(sells.at(-1)!.signalAt).toBe(utcOrbSlotLabel(startDay, 286));
    expect(sells.at(-1)!.date).toBe(utcOrbSlotLabel(startDay, 287));
    const evidence = labBacktestEvidence(request, result);
    expect(evidence.signals.length).toBeGreaterThan(0);
    expect(evidence.signals[0]!.evidence.kind).toBe("utc-orb");
    expect(evidence.diagnostics[0]!.evaluated).toBeGreaterThan(0);
  });
});
