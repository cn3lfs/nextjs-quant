import { expect, it } from "vitest";
import { researchManagementSchema } from "../../../../src/lib/research/workflow/research-management";
import {
  swingExitTemplate,
  swingExitKind,
} from "trading-strategies/research/swing/research-swing-exits";
import { researchSpecSchema } from "../../../../src/lib/research/strategy-research";
import { researchMethodSnapshot } from "../../../../src/server/research/research-method";
const dates = Array.from(
  { length: 12 },
  (_, i) => `2024-01-${String(i + 2).padStart(2, "0")}`,
);
function spec(tail: boolean) {
  return researchSpecSchema.parse({
    strategy: "dual-breakout",
    start: dates[0],
    end: dates[11],
    validationStart: dates[11],
    initialCapital: 45000,
    maxPositions: 1,
    holdingDays: 60,
    risk: { fraction: 0.1, maxWeight: 1 },
    management: swingExitTemplate(
      researchManagementSchema.parse({
        stop: { kind: "percent", fraction: 0.03 },
      }),
      tail,
    ),
    costs: {
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    },
  });
}
it("preserves initial risk and time choices while removing competing lines and stale recognition", () => {
  const input = researchManagementSchema.parse({
    stop: { kind: "percent", fraction: 0.02 },
    confirmations: 2,
    trail: { kind: "close-atr", period: 14, multiple: 2 },
    trailAfterScaleOut: true,
    scaleOut: [{ atR: 2, fraction: 0.5, raiseStopR: 0 }],
    breakeven: { atR: 1 },
    timeExit: { days: 5, minR: 0.5 },
  });
  const copy = structuredClone(input),
    next = swingExitTemplate(input, true);
  expect(input).toEqual(copy);
  expect(next.stop).toEqual(input.stop);
  expect(next.timeExit).toEqual(input.timeExit);
  expect(next).not.toHaveProperty("breakeven");
  expect(next).not.toHaveProperty("trailAfterScaleOut");
  expect(swingExitKind(next)).toBe("prior-target");
  expect(swingExitKind({ ...next, confirmations: 2 })).toBeNull();
  const changed = structuredClone(next);
  changed.scaleOut![1]!.atR = 4;
  expect(swingExitKind(changed)).toBeNull();
  expect(researchManagementSchema.parse(next)).toEqual(next);
});
it("pins the recognized rule and both source files without naming edited custom parameters", () => {
  for (const tail of [false, true]) {
    const input = spec(tail),
      saved = researchMethodSnapshot(input);
    expect(saved.swingExit).toMatchObject({
      version: "swing-exits-1",
      kind: tail ? "prior-target" : "r1-r2",
    });
    expect(saved.sources.map((s) => s.path)).toEqual(
      expect.arrayContaining([
        "swing-trader/references/trading-system.md",
        "swing-trader/references/position-management.md",
      ]),
    );
    const before = researchMethodSnapshot(input);
    input.management!.scaleOut![1]!.atR = 3;
    expect(researchMethodSnapshot(input)).not.toHaveProperty("swingExit");
    expect(researchMethodSnapshot(input)).not.toEqual(before);
  }
});
