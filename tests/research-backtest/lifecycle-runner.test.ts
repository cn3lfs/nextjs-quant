import { expect, it } from "vitest";
import {
  lifecycleTrials,
  lifecycleExecutionPlan,
  lifecycleWeeklySeed,
  resolveLifecycleMissing,
  lifecyclePrepareSummary,
  lifecycleLowZoneEvidence,
} from "../../scripts/lib/research/lifecycle-runner";
import {
  lifecycleConfigHash,
  type LifecycleSourceBundle,
} from "~/server/research/lifecycle-source";
import { assessValidationCandidates } from "~/server/research/validation-method";
import {
  validationDefaults,
  type ValidationRow,
  type ValidationScore,
} from "quant-backtest";
it("each independent segment takes its most recent completed weekly signal, including a midweek capital reset", () => {
  const calendar = [
    "2026-01-08",
    "2026-01-09",
    "2026-01-12",
    "2026-01-13",
    "2026-01-16",
    "2026-01-19",
  ];
  expect(lifecycleWeeklySeed(calendar, "2026-01-12")).toBe("2026-01-09");
  expect(lifecycleWeeklySeed(calendar, "2026-01-13")).toBe("2026-01-09");
  expect(lifecycleWeeklySeed(calendar, "2026-01-19")).toBe("2026-01-16");
});

it("does not materialize low-zone stock/market projections for missing or empty-axis rows, while runnable evidence is unchanged", () => {
  const lowTrials = lifecycleTrials().filter(
    (trial) => trial.candidate.detector,
  );
  expect(lowTrials).toHaveLength(5);
  let calls = 0;
  const exact = { market: [{ date: "2026-01-01" }] };
  const project = () => {
    calls++;
    return exact;
  };
  for (const { candidate } of lowTrials) {
    expect(
      lifecycleLowZoneEvidence(
        candidate,
        { missingRefs: ["known-source-gap"] },
        ["2026-01-01"],
        project,
      ),
    ).toBeNull();
    expect(
      lifecycleLowZoneEvidence(candidate, { missingRefs: [] }, [], project),
    ).toBeNull();
  }
  expect(calls).toBe(0);
  expect(
    lifecycleLowZoneEvidence(
      lowTrials[0]!.candidate,
      { missingRefs: [] },
      ["2026-01-01"],
      project,
    ),
  ).toBe(exact);
  expect(calls).toBe(1);
});

it("predeclares real segmented calls and keeps neighbors outside the selectable main menu", () => {
  const axis = Array.from({ length: 100 }, (_, i) =>
    new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
  );
  const market = (symbol: string) => ({
    request: {
      market: symbol === "BTCUSDT" ? "crypto" : "cn-equity",
      initial: 100000,
      calendar: axis,
      instruments: [],
    },
    benchmark: [],
    bookFacts: {
      benchmark: { symbol, bars: [] },
      classicWeeks: [
        { date: axis[0]!, nextDate: axis[1]!, marketBudget: 1, rows: [] },
      ],
      roundTripCost: 0.003,
    },
    inputHash: "1".repeat(64),
    source: "pure plan fixture",
    missing: [],
  });
  const source = {
    version: "lifecycle-source-1",
    configHash: lifecycleConfigHash,
    frozenAt: "2026-11-16T00:00:00Z",
    inputHash: "2".repeat(64),
    source: "fixture",
    biasTags: [],
    markets: {
      "cn-day": market("sh000906"),
      "crypto-day": market("BTCUSDT"),
      "crypto-4h": market("BTCUSDT"),
    },
    families: Object.fromEntries(
      [
        "cn-equity:swing",
        "cn-equity:low-zone",
        "crypto:swing",
        "crypto:breakout",
      ].map((id) => [
        id,
        {
          dailyAxis: axis,
          axisHash: "3".repeat(64),
          sourceKeys: [],
          warmupStart: axis[0],
          warmupBars: 132,
          targetThrough: axis.at(-1),
          valuationThrough: axis.at(-1),
          missing: [],
        },
      ]),
    ),
    manifestPath: "fixture-source.json",
  } as LifecycleSourceBundle;
  const trials = lifecycleTrials(),
    plan = lifecycleExecutionPlan(source, "4".repeat(64));
  expect(trials).toHaveLength(120);
  expect(trials.filter((t) => t.selectable)).toHaveLength(16);
  expect(plan.scenarioIdentities).toBe(360);
  expect(plan.trials.every((t) => t.segments.length === 20)).toBe(true);
  expect(plan.estimatedPhysicalEngineCalls).toBe(2300); // Five low-zone configurations explicitly lack their adapter evidence.
  expect(
    plan.trials.find((t) => t.id === "l3-cn-swing-weekly-classic-open")
      ?.entryParameterSensitivity,
  ).toBe("required");
  expect(
    plan.trials.find((t) => t.id === "l3-cn-low-zone-market")
      ?.entryParameterSensitivity,
  ).toBe("required");
  const completeGaps = Array.from(
    { length: 2000 },
    (_, i) => `shared-source-gap-${i}: actual evidence ${"detail".repeat(10)}`,
  );
  source.markets["cn-day"].missing = completeGaps;
  source.families["cn-equity:swing"]!.missing = [...completeGaps];
  const blocked = lifecycleExecutionPlan(source, "4".repeat(64));
  const shared = blocked.trials
    .filter((t) => t.family === "cn-equity:swing")
    .slice(0, 2);
  expect(shared[0]!.missingRefs).toEqual(shared[1]!.missingRefs);
  expect(shared[0]!.estimatedPhysicalEngineCalls).toBe(0);
  expect(blocked.estimatedPhysicalEngineCalls).toBe(1360);
  expect(
    Object.values(blocked.missingEvidence).filter((rows) =>
      rows.includes(completeGaps[0]!),
    ),
  ).toHaveLength(1);
  expect(resolveLifecycleMissing(blocked, shared[0]!)).toEqual(completeGaps);
  expect(JSON.stringify(blocked).split("shared-source-gap-1999:")).toHaveLength(
    2,
  );
  const summary = lifecyclePrepareSummary({
    source,
    plan: blocked,
    oracle: { available: true },
    planPath: "fixture-plan.gz",
    parityPath: "fixture-parity.gz",
  });
  expect(summary.families["cn-equity:swing"]!.missingFacts).toBe(2000);
  expect(JSON.stringify(summary)).not.toContain("shared-source-gap-");
  expect(JSON.stringify(summary).length).toBeLessThan(10000);
  expect(() =>
    resolveLifecycleMissing({ missingEvidence: {} }, shared[0]!),
  ).toThrow("reference/content");
});

it("central gates use registered entry block provenance and audit real execution noops with frozen L3 identities", () => {
  const score = (hash: string, offset: number): ValidationScore => ({
    return: 0.1,
    excess: 0.02,
    drawdown: 0.1,
    trades: 30,
    events: {
      entries: 30,
      exits: 30,
      orders: 60,
      fills: 60,
      rejectionAttempts: 0,
    },
    dailyDates: Array.from({ length: 30 }, (_, i) =>
      new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
    ),
    daily: Array.from(
      { length: 30 },
      (_, i) => 0.001 + Math.sin(i + offset) * 0.002,
    ),
    tradeListHash: hash,
    riskAdjusted: {
      sharpe: 1,
      benchmarkSharpe: 0,
      sharpeDifference: 1,
      calmar: 1,
      benchmarkCalmar: 0,
      calmarDifference: 1,
      basis: "fixed fixture",
    },
  });
  const row = (id: string, hash: string, offset: number): ValidationRow => {
    const s = score(hash, offset),
      run = {
        start: "2026-01-01",
        end: "2026-01-30",
        base: s,
        doubledCost: s,
        delayed: s,
      };
    return {
      id,
      family: "cn-equity:swing",
      entryParameterSensitivity: "required",
      inSample: s,
      holdout: run,
      windows: [run],
      neighbors: [],
      positiveWindows: 1,
      stressPositiveWindows: 1,
      closedTrades: 30,
      reasons: [],
      passed: false,
    };
  };
  const result = assessValidationCandidates(
    [
      {
        row: row("main", "baseline", 0),
        market: "cn-equity",
        sleeve: "swing",
        neighborhoodCenter: "main",
      },
      {
        row: row("main-n-entry-rank-90", "changed", 1),
        market: "cn-equity",
        sleeve: "swing",
        neighborhoodCenter: "main",
        neighborhoodKind: "entry",
      },
      {
        row: row("main-n-entry-rank-110", "baseline", 0),
        market: "cn-equity",
        sleeve: "swing",
        neighborhoodCenter: "main",
        neighborhoodKind: "entry",
      },
    ],
    {
      ...validationDefaults,
      trainBars: 20,
      testBars: 5,
      method: "lifecycle-2",
      purpose: "preregistered",
      clusterCorrelation: 0.95,
      maximumPbo: 0.5,
      minimumDsr: 0.95,
    },
  );
  expect(result[0]!.row.neighbors).toMatchObject([
    { id: "main-n-entry-rank-90", perturbed: "entry", testable: true },
    {
      id: "main-n-entry-rank-110",
      perturbed: "entry",
      testable: false,
      reason: "identical-oos-trades",
    },
  ]);
  expect(result[0]!.family.excluded).toContainEqual({
    id: "main-n-entry-rank-110",
    reason: "identical-oos-trades",
  });
  expect(result[0]!.row.reasons).not.toContain(
    "entry-neighborhood-not-testable",
  );
});
