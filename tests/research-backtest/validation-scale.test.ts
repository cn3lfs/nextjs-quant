import { describe, expect, it } from "vitest";
import { researchCandidates } from "trading-strategies";
import { runValidationSuite, type ValidationCandidate } from "quant-backtest";
import {
  runCandidateCheckpoint,
  joinCandidateCheckpoints,
  checkpointFamilySelection,
} from "~/server/research/validation-scale";
import { scoreValidationResult } from "~/server/research/validation-replay";
import type { ValidationDataset } from "~/server/research/validation-capture";

function fixture() {
  const bars = Array.from({ length: 150 }, (_, i) => {
    const price = 100 + i / 8 + 6 * Math.sin(i / 5);
    return {
      date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
      open: price,
      high: price + 1,
      low: price - 1,
      close: price,
      volume: 100000,
      amount: 10000000,
    };
  });
  const dataset: ValidationDataset = {
    period: "day",
    instruments: ["cxBTCUSDT", "cxETHUSDT"].map((symbol) => ({
      symbol,
      market: "crypto",
      bars,
      signalBars: bars,
      execution: {
        evidence: "QA only",
        minimum: 0.001,
        step: 0.001,
        limitUp: null,
        limitDown: null,
        tradable: true,
      },
    })),
    benchmark: bars,
    dates: bars.slice(50).map((b) => b.date),
    sources: [],
    benchmarkName: "QA fixture, not market evidence",
  };
  const strategies = researchCandidates(["cxBTCUSDT", "cxETHUSDT"], "crypto")
    .filter((c) => c.family === "dual-ma-day")
    .map((c, i) => ({
      ...c.strategy,
      id: i ? `center-neighbor-${i}` : "center",
    }));
  const candidates: ValidationCandidate[] = strategies.map((strategy) => ({
    id: strategy.id,
    family: "dual-ma-day",
    request: {
      market: "crypto",
      initial: 100000,
      start: dataset.dates[0]!,
      end: dataset.dates.at(-1)!,
      calendar: bars.map((b) => b.date),
      instruments: dataset.instruments,
      strategies: [strategy],
      sleeves: [
        { id: "swing", share: 1, riskPerTrade: 0.02, maxPositions: 10 },
      ],
    },
    neighborIds: strategies
      .filter((s) => s.id !== strategy.id)
      .map((s) => s.id),
  }));
  const policy = {
    trainBars: 40,
    testBars: 10,
    minimumWindows: 3,
    minimumTrades: 30,
    maximumDrawdown: 0.25,
    minimumPositiveWindows: 0.6,
    minimumStableNeighbors: 0.5,
    minimumDsr: 0.95,
  };
  return { dataset, candidates, policy };
}
describe("checkpointed large-universe validation", () => {
  it("preserves every score, stress, neighbor, window and training selector from the joint suite", () => {
    const { dataset, candidates, policy } = fixture();
    const joint = runValidationSuite(
      candidates,
      dataset.dates,
      policy,
      (result, request) => scoreValidationResult(result, request, dataset),
    );
    const checkpoints = candidates.map((candidate) =>
      runCandidateCheckpoint(candidate, dataset, policy),
    );
    const joined = joinCandidateCheckpoints(checkpoints, policy);
    joined.forEach((checkpoint, index) => {
      const expected = joint.rows[index]!;
      expect(checkpoint.row).toEqual({
        ...expected,
        reasons: [
          ...expected.reasons,
          ...(checkpoint.testing.selected.dsr.value === null ||
          checkpoint.testing.selected.dsr.value < 0.95
            ? ["multiple-testing-dsr-0.95"]
            : []),
        ],
        passed:
          expected.passed &&
          checkpoint.testing.selected.dsr.value !== null &&
          checkpoint.testing.selected.dsr.value >= 0.95,
      });
      expect(checkpoint.testing.trials).toBe(3);
    });
    const selection = checkpointFamilySelection(checkpoints)[0]!.windows;
    expect(selection.map((s) => s.selectedId)).toEqual(
      joint.selection.map((s) => s.families[0]!.selectedId),
    );
    expect(selection.map((s) => s.result)).toEqual(
      joint.selectedOos.map((s) => s.families[0]!.result),
    );
  });
  it("counts other periods and families in the same multiplicity correction and rejects duplicate checkpoints", () => {
    const { dataset, candidates, policy } = fixture();
    const first = runCandidateCheckpoint(candidates[0]!, dataset, policy);
    expect(() => joinCandidateCheckpoints([first, first], policy)).toThrow(
      "duplicate",
    );
    const other = {
      ...first,
      row: { ...first.row, id: "other-period", family: "other-family" },
      fullPeriod: {
        ...first.fullPeriod,
        daily: first.fullPeriod.daily.map((v, i) =>
          v === null ? null : v + (i % 2 ? 0.001 : -0.001),
        ),
      },
    };
    const joined = joinCandidateCheckpoints([first, other], policy);
    expect(joined.map((c) => c.testing.trials)).toEqual([2, 2]);
    expect(joined[0]!.row.reasons).toContain("parameter-neighborhood");
    expect(joined[0]!.row.passed).toBe(false);
  });
});
