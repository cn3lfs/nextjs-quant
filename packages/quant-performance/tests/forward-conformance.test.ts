import { describe, expect, it } from "vitest";
import {
  assessForwardConformance,
  type ForwardDistribution,
  type ForwardObservation,
} from "../src/forward-conformance.js";

const identity = {
  strategyId: "frozen",
  version: 2,
  definitionHash: "a".repeat(64),
  inputHash: "b".repeat(64),
  buildHash: "c".repeat(64),
};
function fixture() {
  const days = Array.from({ length: 240 }, (_, i) => ({
    date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10),
    return: 0.001,
    signals: 1,
  }));
  const reference: ForwardDistribution = {
    frozenAt: Date.parse("2025-12-31T00:00:00Z"),
    identity,
    days,
    tradeReturns: Array(40).fill(0.02),
    slippageBps: Array(40).fill(10),
  };
  const observed: ForwardObservation = {
    ...reference,
    days: days.slice(0, 120).map((day, i) => ({
      ...day,
      date: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10),
    })),
    entries: 30,
    tradeReturns: Array(20).fill(0.02),
    slippageBps: Array(20).fill(10),
    missingDates: [],
    unknownDecisions: 0,
  };
  return {
    market: "cn-equity" as const,
    period: "day",
    reference,
    observed,
    startedAt: Date.parse("2026-01-01T00:00:00Z"),
    asOf: Date.parse("2026-05-01T12:00:00Z"),
    expectedDates: observed.days.map((day) => day.date),
  };
}
describe("frozen distribution forward conformance", () => {
  it("uses independent calibration for a simultaneous band on nonconstant same-distribution paths", () => {
    let seed = 91;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const days = (year: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        date: new Date(Date.UTC(year, 0, i + 1)).toISOString().slice(0, 10),
        return: random() < 0.5 ? -0.01 : 0.012,
        signals: 1,
      }));
    const input = fixture();
    input.reference.days = days(2020, 400);
    let rejected = 0;
    for (let i = 0; i < 20; i++) {
      input.observed.days = days(2026, 120);
      const result = assessForwardConformance({ ...input, market: "crypto" });
      if (result.equity.status === "adverse") rejected++;
      expect(result.bootstrap.calibrationSeed).not.toBe(result.bootstrap.seed);
      expect(result.bootstrap.calibrationDraws).toBe(1000);
      expect(result.equity.simultaneousScale).toBeLessThan(1);
    }
    // The old pointwise-any-breach rule rejected 4/20 for this fixed sample.
    // This is a regression fixture, not empirical proof of universal 95% coverage.
    expect(rejected).toBeLessThanOrEqual(2);
  });
  it("rejects late-frozen references, future days, broken crypto calendars and unknown counts", () => {
    const late = fixture();
    late.reference.frozenAt = late.startedAt + 1;
    expect(assessForwardConformance(late).reasons).toContain(
      "reference-not-frozen-before-registration",
    );
    const future = fixture();
    future.asOf = future.startedAt + 86400000;
    expect(assessForwardConformance(future).reasons).toContain(
      "forward-day-outside-observed-clock",
    );
    const gap = fixture();
    gap.observed.days = gap.observed.days.map((day, i) => ({
      ...day,
      date: new Date(Date.UTC(2026, 0, i * 2 + 1)).toISOString().slice(0, 10),
    }));
    gap.asOf = Date.parse("2026-12-01T00:00:00Z");
    expect(
      assessForwardConformance({ ...gap, market: "crypto" }).reasons,
    ).toContain("incomplete-crypto-forward-calendar");
    for (const unknownDecisions of [NaN, -1, 0.5]) {
      const invalid = fixture();
      invalid.observed.unknownDecisions = unknownDecisions;
      expect(assessForwardConformance(invalid).reasons).toContain(
        "invalid-unknown-decision-count",
      );
    }
    const noSlippage = fixture();
    noSlippage.observed.slippageBps = [];
    expect(assessForwardConformance(noSlippage).reasons).toContain(
      "insufficient-forward-slippage-evidence",
    );
    const thinBaseline = fixture();
    thinBaseline.reference.tradeReturns = [0.02];
    thinBaseline.reference.slippageBps = [10];
    expect(assessForwardConformance(thinBaseline).reasons).toContain(
      "insufficient-forward-closed-trades",
    );
    expect(assessForwardConformance(thinBaseline).reasons).toContain(
      "insufficient-forward-slippage-evidence",
    );
    const noCalendar = fixture();
    noCalendar.expectedDates = [];
    expect(assessForwardConformance(noCalendar).reasons).toContain(
      "incomplete-equity-forward-calendar",
    );
  });
  it("same-version observations from the frozen distribution conform without rerunning DSR or historical neighbors", () => {
    const input = fixture();
    const result = assessForwardConformance(input);
    expect(result.verdict).toBe("conforming");
    expect(result.reasons).toEqual([]);
    expect(result.equity.lowerPath).toHaveLength(120);
    expect(assessForwardConformance(input)).toEqual(result);
  });
  it.each(["equity", "trades", "slippage", "signals"])(
    "detects an adverse shifted %s distribution",
    (metric) => {
      const input = fixture();
      if (metric === "equity")
        input.observed.days = input.observed.days.map((day) => ({
          ...day,
          return: -0.01,
        }));
      if (metric === "trades")
        input.observed.tradeReturns = Array(20).fill(-0.1);
      if (metric === "slippage")
        input.observed.slippageBps = Array(20).fill(30);
      if (metric === "signals")
        input.observed.days = input.observed.days.map((day) => ({
          ...day,
          signals: 0,
        }));
      expect(assessForwardConformance(input).verdict).toBe("degraded");
    },
  );
  it("thin data, changed version and gaps are insufficient rather than a failure of frozen backtest gates", () => {
    const input = fixture();
    input.observed = {
      ...input.observed,
      days: input.observed.days.slice(0, 20),
      entries: 3,
    };
    expect(assessForwardConformance(input).verdict).toBe("insufficient");
    const changed = fixture();
    changed.observed.identity = { ...identity, version: 3 };
    expect(assessForwardConformance(changed).reasons).toContain(
      "forward-version-mismatch",
    );
    const gap = fixture();
    gap.observed.missingDates = ["2025-02-01"];
    expect(assessForwardConformance(gap).verdict).toBe("insufficient");
    expect(
      assessForwardConformance({ ...fixture(), reference: null }).reasons,
    ).toContain("missing-frozen-forward-distribution");
    const reused = fixture();
    reused.observed.days = reused.reference.days.slice(0, 120);
    expect(assessForwardConformance(reused).reasons).toContain(
      "forward-overlaps-frozen-history",
    );
  });
  it("daily crypto uses 120 actual days of equity without waiting for 20 infrequent entries", () => {
    const input = fixture();
    input.observed.entries = 1;
    input.observed.tradeReturns = [];
    input.observed.slippageBps = [];
    const result = assessForwardConformance({ ...input, market: "crypto" });
    expect(result.verdict).toBe("conforming");
    expect(result.minimumDays).toBe(120);
    expect(result.tradeReturn.status).toBe("insufficient");
    expect(result.slippage.status).toBe("insufficient");
    expect(
      assessForwardConformance({
        ...input,
        market: "crypto",
        observed: {
          ...input.observed,
          days: input.observed.days.slice(0, 119),
        },
      }).verdict,
    ).toBe("insufficient");
  });
  it("rejects duplicated days and non-finite data instead of inventing zero returns", () => {
    const input = fixture();
    input.observed.days = [input.observed.days[0]!, ...input.observed.days];
    expect(assessForwardConformance(input).reasons).toContain(
      "invalid-forward-day-evidence",
    );
    expect(
      assessForwardConformance({
        ...fixture(),
        observed: { ...fixture().observed, slippageBps: [NaN] },
      }).verdict,
    ).toBe("insufficient");
  });
});
