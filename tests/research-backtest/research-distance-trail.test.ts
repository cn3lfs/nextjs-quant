import { expect, it } from "vitest";
import { researchManagementSchema } from "../../src/lib/research/workflow/research-management";
import { researchSpecSchema } from "../../src/lib/research/strategy-research";
import { researchMethodSnapshot } from "../../src/server/research/research-method";
const dates = ["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05"];
const spec = researchSpecSchema.parse({
  strategy: "dual-breakout",
  start: dates[0],
  end: dates[3],
  validationStart: dates[3],
  initialCapital: 100000,
  holdingDays: 60,
  risk: { fraction: 0.05, maxWeight: 0.5 },
  management: {
    stop: { kind: "percent", fraction: 0.1 },
    trail: { kind: "distance", distance: 5 },
  },
  costs: {
    commissionBps: 0,
    minimumCommission: 5,
    sellTaxBps: 0,
    slippageBps: 0,
  },
});
it("validates price units and versions only the enabled distance method", () => {
  for (const distance of [0, -1, NaN, Infinity])
    expect(
      researchManagementSchema.safeParse({
        trail: { kind: "distance", distance },
      }).success,
    ).toBe(false);
  expect(
    researchManagementSchema.parse({
      trail: { kind: "distance", distance: 0.01 },
    }).trail,
  ).toEqual({ kind: "distance", distance: 0.01 });
  expect(researchMethodSnapshot(spec)).toHaveProperty(
    "distanceTrail.version",
    "research-distance-trail-1",
  );
  expect(
    researchMethodSnapshot({
      strategy: "dual-breakout",
      management: researchManagementSchema.parse({}),
    }),
  ).not.toHaveProperty("distanceTrail");
});
