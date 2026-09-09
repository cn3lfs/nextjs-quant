import { expect, it } from "vitest";
import {
  canslimScorecard,
  type CanslimScoreInput,
} from "../src/server/canslim-scorecard";
const input = (): CanslimScoreInput => ({
  id: "C1",
  maxPoints: 8,
  points: 6,
  status: "computed",
  evidenceIds: ["eps"],
  reason: "同口径季度EPS计算",
});
it("retains all 17 factors and sums actual caps to 114 without normalizing missing data", () => {
  const result = canslimScorecard([input()], ["eps"]);
  expect(result.checks).toHaveLength(17);
  expect(result).toMatchObject({
    maxPoints: 114,
    computedPoints: 6,
    computedCapacity: 8,
  });
  expect(result.missingIds).toHaveLength(16);
  expect(result.checks.map((c) => c.id).slice(-3)).toEqual(["M1", "M2", "M3"]);
});
it("rejects inflated, duplicated or uncited scores", () => {
  for (const patch of [
    { points: 9 },
    { maxPoints: 10 },
    { id: "N3" },
    { evidenceIds: [] },
    { evidenceIds: ["fake"] },
    { status: "missing" as const },
  ]) {
    expect(() =>
      canslimScorecard([{ ...input(), ...patch }], ["eps"]),
    ).toThrow();
  }
  expect(() => canslimScorecard([input(), input()], ["eps"])).toThrow();
});
it("preserves conflicts separately from missing evidence", () => {
  const result = canslimScorecard(
    [{ ...input(), status: "conflict", points: 0 }],
    ["eps"],
  );
  expect(result.conflictIds).toEqual(["C1"]);
  expect(result.computedCapacity).toBe(0);
  expect(result.missingIds).not.toContain("C1");
});
