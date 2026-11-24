import { expect, it } from "vitest";
import {
  validationDefaults,
  type PortfolioRequest,
  type ValidationRow,
  type ValidationScore,
} from "quant-backtest";
import { assessValidationCandidates } from "~/server/research/validation-method";
import {
  runDiagnoseFamilyTimeHoldout,
  type DiagnoseFamilyCandidate,
} from "~/server/research/diagnose/time-holdout";

const dates = Array.from({ length: 240 }, (_, i) =>
  new Date(Date.UTC(2022, 0, 1 + i)).toISOString().slice(0, 10),
);
const holdoutStart = dates[220]!;
const devAxis = dates.slice(20, 220);
const policy = {
  ...validationDefaults,
  trainBars: 20,
  testBars: 20,
  holdoutStart,
  method: "lifecycle-2",
  purpose: "post-hoc",
  minimumDsr: 0.95,
  maximumPbo: 0.5,
  clusterCorrelation: 0.95,
} as const;

function matrixRow(id: string): ValidationRow {
  const score: ValidationScore = {
    dailyDates: devAxis,
    daily: devAxis.map(
      (_, i) =>
        (i % 2 ? 1 : -1) / 1024 +
        (id === "B" ? 0 : i < 120 ? 1 / 256 : -1 / 256),
    ),
    return: null,
    excess: null,
    drawdown: null,
    trades: 0,
    events: { entries: 0, exits: 0, orders: 0, fills: 0, rejectionAttempts: 0 },
  };
  const stress = { ...score, daily: score.daily.map(() => null) };
  const window = {
    start: devAxis[0]!,
    end: devAxis.at(-1)!,
    base: score,
    doubledCost: stress,
    delayed: stress,
  };
  return {
    id,
    family: "family",
    windows: [window],
    holdout: { ...window, start: holdoutStart, base: stress },
    inSample: stress,
    neighbors: [],
    positiveWindows: 0,
    stressPositiveWindows: 0,
    closedTrades: 0,
    reasons: [],
    passed: false,
  };
}
const assess = (rows: ValidationRow[]) =>
  assessValidationCandidates(
    rows.map((row) => ({ row, market: "cn-equity", sleeve: "family" })),
    policy,
    devAxis,
  )[0]!;

it("matches the hand-ranked Sharpe winner in all 252 complementary splits (132/252 overfit)", () => {
  // B always has zero mean and nonzero variance. A wins on a five-block
  // half iff >=3 of its blocks are positive. With 6 positive and 4 negative
  // blocks the same winner survives both halves only for a 3:3 division.
  // C(6,3)*C(4,2)=120; every other split loses out of sample.
  const { cscv } = assess([matrixRow("A"), matrixRow("B")]).family;
  const belowMedian: boolean[] = [];
  for (let mask = 1023; mask >= 0; mask--) {
    const bits = mask.toString(2).padStart(10, "0");
    if (bits.replaceAll("0", "").length !== 5) continue;
    belowMedian.push(bits.slice(0, 6).replaceAll("0", "").length !== 3);
  }
  const rankLogit = (rank: 1 | 2) => {
    const probability = rank / 3;
    return Math.log(probability / (1 - probability));
  };
  expect(cscv.lambdas).toEqual(
    belowMedian.map((loss) => rankLogit(loss ? 1 : 2)),
  );
  expect(cscv.combinations).toBe(252);
  expect(cscv.pbo.value).toBe(132 / 252);
});

it("rejects a common missing date, a shifted return axis and a cut-day observation", () => {
  const shifted = matrixRow("shift");
  shifted.windows[0]!.base.dailyDates = [...devAxis.slice(1), holdoutStart];
  const rejected = assess([shifted, matrixRow("B")]);
  expect(rejected.testing.selected.dsr.value).toBeNull();
  expect(rejected.family.excluded).toContainEqual({
    id: "shift",
    reason: "incomplete-or-misaligned-oos-returns",
  });
  const rows = [matrixRow("A"), matrixRow("B")];
  for (const row of rows) {
    row.windows[0]!.base.dailyDates = devAxis.slice(1);
    row.windows[0]!.base.daily.shift();
  }
  expect(assess(rows).family.trials).toEqual([]);
  expect(() =>
    assessValidationCandidates([], policy, [...devAxis, holdoutStart]),
  ).toThrow(/pre-cut/);
});

function candidate(
  id: string,
  maxBars: number,
  mutate = false,
): DiagnoseFamilyCandidate {
  const bars = dates.map((date, i) => {
    const close =
      30 +
      i / 40 +
      Math.sin(i * 0.4) * 3 +
      (mutate && date >= holdoutStart ? (i - 219) * 1.5 : 0);
    return {
      date,
      open: close,
      close,
      high: close + 1,
      low: close - 1,
      volume: 100000,
      amount: 1e7,
    };
  });
  const request: PortfolioRequest = {
    market: "cn-equity",
    initial: 100000,
    start: dates[0]!,
    end: dates.at(-1)!,
    calendar: dates,
    sleeves: [{ id: "s", share: 1, riskPerTrade: 1, maxPositions: 1 }],
    strategies: [
      {
        id,
        market: "cn-equity",
        version: 1,
        sleeve: "s",
        period: "day",
        universe: { kind: "symbols", symbols: ["sh600001"] },
        entry: { kind: "constant", value: true },
        exit: { maxBars },
        sizing: { kind: "weight", weight: 0.5 },
      },
    ],
    instruments: [
      {
        market: "cn-equity",
        symbol: "sh600001",
        bars,
        signalBars: bars,
        execution: {
          evidence: "fixture",
          tradable: true,
          minimum: 100,
          step: 100,
          limitUp: null,
          limitDown: null,
        },
      },
    ],
  };
  return { id, role: "base", request };
}
const options = {
  family: "time-exits",
  candidateId: "A",
  dates,
  holdoutStart,
  trainBars: 20,
  testBars: 20,
};

it("rejects unrelated entry theses despite a shared family label", () => {
  const a = candidate("A", 3),
    b = candidate("B", 9);
  b.request.strategies = b.request.strategies.map((s) => ({
    ...s,
    entry: { kind: "study-rule", strategy: "classic-ibs", side: "entry" },
  }));
  expect(() => runDiagnoseFamilyTimeHoldout([a, b], options)).toThrow(
    /同一策略家族/,
  );
});

it("rejects factor combinations with different entry thresholds even under a named family label", () => {
  const members = [candidate("A", 3), candidate("B", 9)];
  for (const [i, member] of members.entries()) {
    const conditions = (threshold: number) => ({
      mode: "all" as const,
      conditions: [
        {
          left: { id: "sma" as const, parameters: { period: 5 } },
          operator: "gt" as const,
          right: { constant: threshold },
        },
      ],
    });
    member.request.strategies = member.request.strategies.map((s) => ({
      ...s,
      entry: {
        kind: "factor",
        side: "entry",
        strategy: {
          id: "factor-combination-v1",
          version: 1,
          name: "threshold",
          entry: conditions(10 + i),
          exit: conditions(20),
        },
      },
    }));
  }
  expect(() =>
    runDiagnoseFamilyTimeHoldout(members, { ...options, family: "ch14-exits" }),
  ).toThrow(/同一策略家族/);
});

it("stress, accounting controls and incomplete base returns cannot change the trial distribution", () => {
  const a = candidate("A", 3),
    b = candidate("B", 9),
    bad = candidate("incomplete", 5);
  const bars = bad.request.instruments[0]!.bars.filter(
    (bar) => bar.date !== dates[55],
  );
  bad.request.instruments = [
    { ...bad.request.instruments[0]!, bars, signalBars: bars },
  ];
  const controls = (
    ["doubledCost", "delayed", "hold", "terminal-accounting"] as const
  ).map((role, i) => ({
    ...candidate("control-" + i, 4 + i),
    role,
  }));
  const stats = runDiagnoseFamilyTimeHoldout(
    [...controls, bad, b, a],
    options,
  ).statistics;
  const base = runDiagnoseFamilyTimeHoldout([a, b], options).statistics;
  expect(stats).toMatchObject({
    rawCandidateCount: 7,
    includedCandidateIds: ["A", "B"],
    devOosDays: 200,
    effectiveTrials: base.effectiveTrials,
    dsr: base.dsr,
    pbo: base.pbo,
    clusters: base.clusters,
    dsrThreshold: 0.95,
    excluded: [
      ...controls.map((c) => ({ id: c.id, reason: c.role })),
      { id: "incomplete", reason: "incomplete-or-misaligned-oos-returns" },
    ],
  });
  expect(stats.effectiveTrials).toBe(2);
  expect(stats.pboBasis).toContain("PBO(Sharpe)");
});

it("keeps development statistics when the holdout axis is empty or a holdout replay throws", () => {
  const a = candidate("A", 3),
    b = candidate("B", 9);
  const clean = runDiagnoseFamilyTimeHoldout([a, b], options);
  const noHoldout = runDiagnoseFamilyTimeHoldout([a, b], {
    ...options,
    dates: dates.filter((d) => d < holdoutStart),
  });
  const instrument = b.request.instruments[0]!;
  b.request.instruments = [
    {
      ...instrument,
      bars: instrument.bars.map((bar) =>
        bar.date === holdoutStart ? { ...bar, low: -1 } : bar,
      ),
    },
  ];
  const damaged = runDiagnoseFamilyTimeHoldout([a, b], options);
  expect(noHoldout.statistics).toEqual(clean.statistics);
  expect(noHoldout.holdoutRange).toBeNull();
  expect(damaged.statistics).toEqual(clean.statistics);
  expect(damaged.candidates.find((c) => c.id === "A")!.holdout).toEqual(
    clean.candidates.find((c) => c.id === "A")!.holdout,
  );
  const missing = damaged.candidates.find((c) => c.id === "B")!;
  expect(missing.holdoutFailure).toMatch(/Invalid strategy bars/);
  for (const leg of Object.values(missing.holdout))
    expect(Object.values(leg).every((value) => value === null)).toBe(true);
});

it("changing prices from the cut forward changes holdout P&L and leaves every development statistic bit-identical", () => {
  const run = (mutate: boolean) => {
    const a = candidate("A", 3, mutate),
      b = candidate("B", 9, mutate);
    return runDiagnoseFamilyTimeHoldout([a, b], {
      ...options,
      benchmark: a.request.instruments[0]!.bars,
    });
  };
  const before = run(false),
    after = run(true);
  expect(before.classification).toBe("historical-holdout-review");
  expect(before.statistics).toMatchObject({
    pbo: expect.any(Number),
    dsr: expect.any(Number),
    combinations: 252,
  });
  expect(after.candidates[0]!.holdout.base.return).not.toBe(
    before.candidates[0]!.holdout.base.return,
  );
  expect(after.statistics).toStrictEqual(before.statistics);
  expect(after.rollingSelection).toStrictEqual(before.rollingSelection);
});
