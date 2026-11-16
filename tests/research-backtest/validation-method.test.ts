import { describe, expect, it } from "vitest";
import {
  validationAdditionalReasons,
  validationDefaults,
  validationNeighborhood,
  validationEntryParameterSensitivity,
  validationRowReasons,
  type ValidationRow,
  type ValidationScore,
} from "quant-backtest";
import {
  clusterOosTrials,
  assessValidationCandidates,
} from "~/server/research/validation-method";
import {
  effectiveMultipleTesting,
  multipleTesting,
  sharpeDaily,
} from "~/lib/backtest/multiple-testing";
import { numericNeighbors } from "~/server/research/validation-replay";
import {
  researchCandidates,
  strategyObjectSchema,
  type StrategyObjectInput,
} from "trading-strategies";
import { captureValidationInput } from "~/server/research/validation-capture";
import { validationInputSchema } from "~/server/research/validation-model";

const policy = {
  ...validationDefaults,
  method: "lifecycle-2" as const,
  purpose: "preregistered" as const,
  clusterCorrelation: 0.95,
  maximumPbo: 0.5,
  minimumDsr: 0.95,
  trainBars: 100,
  testBars: 40,
};
const dates = Array.from({ length: 240 }, (_, i) =>
  new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10),
);
function row(id: string, factor = 1): ValidationRow {
  const score = (index: number): ValidationScore => ({
    return: 0.1,
    excess: -0.5,
    drawdown: 0.1,
    trades: 10,
    daily: Array.from({ length: 40 }, (_, i) =>
      i % 2 ? 0.005 * factor : -0.001,
    ),
    dailyDates: dates.slice(index * 40, (index + 1) * 40),
    tradeListHash: `${id}-${index}`,
    riskAdjusted: {
      sharpe: 1,
      benchmarkSharpe: 0,
      sharpeDifference: 1,
      calmar: 1,
      benchmarkCalmar: 0,
      calmarDifference: 1,
      basis: "fixed input",
    },
    events: {
      entries: 10,
      exits: 10,
      orders: 20,
      fills: 20,
      rejectionAttempts: 0,
    },
  });
  const windows = Array.from({ length: 6 }, (_, i) => ({
    start: dates[i * 40]!,
    end: dates[(i + 1) * 40 - 1]!,
    base: score(i),
    doubledCost: score(i),
    delayed: score(i),
  }));
  return {
    id,
    entryParameterSensitivity: "required",
    family: "declared",
    inSample: score(0),
    holdout: windows.at(-1)!,
    windows,
    neighbors: [],
    positiveWindows: 6,
    stressPositiveWindows: 6,
    closedTrades: 60,
    reasons: [],
    passed: false,
  };
}
describe("declared lifecycle validation method", () => {
  it("perturbs historical-low, screening and factor entries within their declared schema boundaries", () => {
    const base = researchCandidates(["sh600000"], "cn-equity")[0]!;
    const entries: StrategyObjectInput["entry"][] = [
      {
        kind: "historical-low",
        side: "entry",
        config: { years: 10, minimumBars: 1000, recoveryPercentile: 0.4 },
      },
      {
        kind: "screening-metrics",
        fast: 5,
        slow: 20,
        minChange: -0.02,
        maxChange: 0.1,
        minVolumeRatio: 0,
      },
      {
        kind: "factor",
        side: "entry",
        strategy: {
          id: "factor-combination-v1",
          version: 1,
          name: "fixture",
          entry: {
            mode: "all",
            conditions: [
              {
                left: { id: "sma", parameters: { period: 5 } },
                operator: "gt",
                right: { constant: 10 },
              },
            ],
          },
          exit: {
            mode: "all",
            conditions: [
              {
                left: { id: "sma", parameters: { period: 5 } },
                operator: "lt",
                right: { constant: 10 },
              },
            ],
          },
        },
      },
    ];
    for (const entry of entries) {
      const candidate = {
        ...base,
        strategy: strategyObjectSchema.parse({ ...base.strategy, entry }),
      };
      expect(validationEntryParameterSensitivity([candidate.strategy])).toBe(
        "required",
      );
      const perturbed = numericNeighbors(candidate, "lifecycle-2").filter((c) =>
        c.strategy.id.includes("-neighbor-entry-"),
      );
      expect(perturbed).toHaveLength(2);
      for (const neighbor of perturbed) {
        expect(strategyObjectSchema.safeParse(neighbor.strategy).success).toBe(
          true,
        );
        expect(neighbor.strategy.entry).not.toEqual(candidate.strategy.entry);
        expect(neighbor.strategy.exit).toEqual(candidate.strategy.exit);
      }
    }
  });
  it("fixed entry rules declare no tunable parameters without bypassing exit-neighbor evidence", () => {
    const strategy = researchCandidates(["sh600000"], "cn-equity").find(
      (c) => c.family === "double-breakout",
    )!.strategy;
    expect(validationEntryParameterSensitivity([strategy])).toBe(
      "not-applicable",
    );
    expect(
      validationEntryParameterSensitivity([
        {
          ...strategy,
          entry: { kind: "external", id: "frozen", side: "entry" },
        },
      ]),
    ).toBeUndefined();
    const base = {
      ...row("base"),
      entryParameterSensitivity: "not-applicable" as const,
    };
    const neighbors = validationNeighborhood(
      base,
      [row("base-neighbor-90", 1.1)],
      policy,
    );
    expect(validationRowReasons({ ...base, neighbors }, policy)).not.toContain(
      "entry-neighborhood-not-testable",
    );
    expect(validationRowReasons({ ...base, neighbors: [] }, policy)).toContain(
      "parameter-neighborhood",
    );
    expect(
      validationRowReasons(
        { ...base, entryParameterSensitivity: undefined, neighbors },
        policy,
      ),
    ).toContain("missing-entry-parameter-declaration");
    expect(
      validationRowReasons(
        { ...base, entryParameterSensitivity: "required", neighbors },
        policy,
      ),
    ).toContain("entry-neighborhood-not-testable");
  });
  it("rejects a new raw-excess capture before attempting data IO", async () => {
    const input = validationInputSchema.parse({
      market: "crypto",
      start: "2020-01-01",
      end: "2020-12-31",
      policy: { returnCriterion: "raw-excess" },
    });
    await expect(captureValidationInput(input, "not-a-source")).rejects.toThrow(
      "risk-adjusted",
    );
    expect(input.policy.method).toBeUndefined();
  });
  it("identical series form one effective trial; missing or shifted dates do not get zero-filled", () => {
    const a = { id: "a", dates: dates.slice(0, 3), returns: [0.1, -0.1, 0.2] };
    expect(clusterOosTrials([a, { ...a, id: "b" }], 0.95)).toMatchObject({
      effectiveTrials: 1,
      clusters: [["a", "b"]],
      reason: null,
    });
    expect(
      clusterOosTrials([a, { ...a, id: "b", returns: [0.1, null, 0.2] }], 0.95)
        .effectiveTrials,
    ).toBeNull();
    expect(
      clusterOosTrials([a, { ...a, id: "b", dates: dates.slice(1, 4) }], 0.95)
        .reason,
    ).toBe("incomplete-or-misaligned-oos-returns");
  });
  it("a no-op trade neighbour is not stable or an effective trial, even with positive training excess", () => {
    const base = row("base");
    const same = structuredClone(base);
    same.id = "base-neighbor-90";
    same.inSample.excess = 1;
    const different = row("base-neighbor-entry-90", 1.1);
    const neighbors = validationNeighborhood(base, [same, different], policy);
    expect(neighbors[0]).toMatchObject({
      testable: false,
      reason: "identical-oos-trades",
      oosPassed: false,
    });
    expect(neighbors[1]).toMatchObject({
      testable: true,
      perturbed: "entry",
      oosPassed: true,
    });
    const assessed = assessValidationCandidates(
      [base, same, different].map((r) => ({
        row: r,
        market: "crypto" as const,
        sleeve: "swing",
      })),
      policy,
    )[0]!;
    expect(assessed.family.excluded).toContainEqual({
      id: same.id,
      reason: "identical-oos-trades",
    });
    expect(assessed.family.cluster.effectiveTrials).toBe(1);
    expect(assessed.testing.selected.dsr.value).not.toBeNull();
    expect(assessed.testing.selected.threshold.value).toBe(0);
  });
  it("uses OOS risk-adjusted neighbour success, rather than positive in-sample raw excess", () => {
    const base = row("base"),
      neighbor = row("base-neighbor-entry-90");
    neighbor.inSample.excess = 10;
    neighbor.windows.forEach((w) => {
      w.base.riskAdjusted!.sharpeDifference = -1;
    });
    const neighbors = validationNeighborhood(base, [neighbor], policy);
    expect(neighbors[0]!.oosPassed).toBe(false);
    expect(validationRowReasons({ ...base, neighbors }, policy)).toContain(
      "parameter-neighborhood",
    );
    expect(
      validationRowReasons(
        { ...base, neighbors: [{ id: "old", excess: 10 }] },
        { ...policy, method: "legacy" },
      ),
    ).not.toContain("parameter-neighborhood");
  });
  it("DSR and CSCV pools are market x sleeve, and terminal/replay scenarios do not add trials", () => {
    const swing = [
      { row: row("base"), market: "crypto" as const, sleeve: "swing" },
      {
        row: row("base-neighbor-entry-90", 1.1),
        market: "crypto" as const,
        sleeve: "swing",
      },
    ];
    const initial = assessValidationCandidates(swing, policy)[0]!;
    const extended = assessValidationCandidates(
      [
        ...swing,
        { row: row("breakout", -5), market: "crypto", sleeve: "breakout" },
        {
          row: row("valuation", 10),
          market: "crypto",
          sleeve: "swing",
          role: "terminal-accounting",
        },
        {
          row: row("replay", -10),
          market: "crypto",
          sleeve: "swing",
          role: "replay",
        },
      ],
      policy,
    )[0]!;
    expect(extended.testing).toEqual(initial.testing);
    expect(extended.family.cscv).toEqual(initial.family.cscv);
    expect(extended.family.cscv.pbo.value).not.toBeNull();
    expect(extended.family.cscv.combinations).toBe(252);
  });
  it("post-hoc evidence and missing CSCV cannot promote; N=1 explicitly uses the zero-benchmark PSR", () => {
    const candidate = {
      row: row("base"),
      market: "crypto" as const,
      sleeve: "swing",
    };
    const result = assessValidationCandidates([candidate], {
      ...policy,
      purpose: "post-hoc",
    })[0]!;
    expect(result.label).toBe("post-hoc re-evaluation");
    expect(result.row.passed).toBe(false);
    expect(result.row.reasons).toContain(
      "post-hoc-re-evaluation-not-promotable",
    );
    expect(result.row.reasons).toContain("family-cscv-pbo");
    const returns = row("other").windows.flatMap((w) => w.base.daily);
    const test = effectiveMultipleTesting(returns, [sharpeDaily(returns)], 1);
    expect(test.effectiveTrialBasis).toBe("one-correlation-cluster-psr-zero");
    expect(test.selected.dsr).toEqual(
      multipleTesting(returns, [sharpeDaily(returns)]).selected.psr,
    );
    expect(
      validationAdditionalReasons({
        minimumDsr: 0.95,
        dsr: 0.95,
        pbo: { value: 0.5, maximum: 0.5 },
      }),
    ).toEqual([]);
  });
  it("adds declared entry perturbations without changing the old numeric menu", () => {
    const candidates = researchCandidates(["cxBTCUSDT", "cxETHUSDT"], "crypto");
    const base = candidates.find(
      (c) => c.family === "dual-ma-day" && c.variant === "trailing",
    )!;
    expect(numericNeighbors(base)).toHaveLength(2);
    const corrected = numericNeighbors(base, "lifecycle-2");
    expect(corrected).toHaveLength(4);
    expect(
      corrected
        .filter((c) => c.strategy.id.includes("-neighbor-entry-"))
        .map((c) => c.strategy.entry),
    ).toEqual([
      { kind: "dual-ma", fast: 9, slow: 36, side: "entry" },
      { kind: "dual-ma", fast: 11, slow: 44, side: "entry" },
    ]);
    expect(corrected.slice(0, 2)).toEqual(numericNeighbors(base));
  });
});
