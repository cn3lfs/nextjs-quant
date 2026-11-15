import { describe, expect, it } from "vitest";
import {
  validationDefaults,
  validationRowReasons,
  validationScorePasses,
  type ValidationScore,
  type ValidationRow,
} from "../src/index.js";
const score = (
  returns = 0.1,
  difference: number | null = 0.2,
): ValidationScore => ({
  return: returns,
  excess: -0.5,
  drawdown: 0.2,
  trades: 10,
  daily: [0.01, -0.02, 0.03],
  events: {
    entries: 10,
    exits: 10,
    orders: 20,
    fills: 20,
    rejectionAttempts: 0,
  },
  riskAdjusted: {
    sharpe: 1,
    benchmarkSharpe: 0.8,
    sharpeDifference: difference,
    calmar: 1,
    benchmarkCalmar: 1,
    calmarDifference: 0,
    basis: "fixture",
  },
});
function row(): ValidationRow {
  const run = {
    start: "2020-01-01",
    end: "2020-12-31",
    base: score(),
    doubledCost: score(),
    delayed: score(),
  };
  return {
    id: "fixture",
    family: "fixture",
    inSample: score(),
    holdout: structuredClone(run),
    windows: Array.from({ length: 5 }, () => structuredClone(run)),
    neighbors: [{ id: "neighbor", excess: 0.1 }],
    positiveWindows: 0,
    stressPositiveWindows: 0,
    closedTrades: 50,
    reasons: [],
    passed: false,
  };
}
const policy = { ...validationDefaults, trainBars: 40, testBars: 10 };
describe("risk adjusted promotion criterion", () => {
  it("requires positive absolute after-cost return and positive same-window Sharpe difference", () => {
    expect(validationDefaults.returnCriterion).toBe("risk-adjusted");
    expect(validationScorePasses(score())).toBe(true);
    for (const s of [
      score(0),
      score(-0.1),
      score(0.1, 0),
      score(0.1, -0.1),
      score(0.1, null),
      { ...score(), riskAdjusted: undefined },
    ])
      expect(validationScorePasses(s)).toBe(false);
    expect(validationScorePasses(score(), "raw-excess")).toBe(false);
  });
  it("reassesses frozen scores and retains the old verdict alongside the new", () => {
    const r = row();
    expect(validationRowReasons(r, policy)).toEqual([]);
    expect(
      validationRowReasons(r, { ...policy, returnCriterion: "raw-excess" }),
    ).toEqual([
      "oos-positive-excess-majority",
      "cost-or-delay-stress",
      "holdout-positive-excess",
    ]);
    r.holdout.delayed = score(-0.01);
    expect(validationRowReasons(r, policy)).toEqual(["cost-or-delay-stress"]);
  });
  it("requires each stress to pass 60 percent, and all unchanged safety gates", () => {
    const r = row();
    r.windows[0]!.doubledCost = score(-0.1);
    r.windows[1]!.doubledCost = score(-0.1);
    r.windows[3]!.delayed = score(-0.1);
    r.windows[4]!.delayed = score(-0.1);
    expect(validationRowReasons(r, policy)).toEqual([]);
    r.windows[2]!.delayed = score(-0.1);
    expect(validationRowReasons(r, policy)).toContain("cost-or-delay-stress");
    r.closedTrades = 29;
    r.windows[0]!.base.drawdown = 0.250001;
    r.neighbors[0]!.excess = 0;
    expect(validationRowReasons(r, policy)).toEqual([
      "cost-or-delay-stress",
      "insufficient-closed-trades",
      "drawdown-bound",
      "parameter-neighborhood",
    ]);
  });
});
