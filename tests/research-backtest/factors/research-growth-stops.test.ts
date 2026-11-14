import { expect, it } from "vitest";
import {
  growthPivotStopIds,
  growthPivotStopTemplate,
  researchGrowthPivotStop,
} from "trading-strategies/research/factors/research-growth-stops";
import { researchManagementSchema } from "../../../src/lib/research/workflow/research-management";
import { researchInitialStop } from "trading-strategies/research/risk/research-initial-stop";
import { researchMethodSnapshot } from "../../../src/server/research/research-method";
it("keeps the contradictory MIN/MAX and CANSLIM pivot formula distinct", () => {
  expect(researchGrowthPivotStop("sepa-pivot-min", 50, 48)).toBeCloseTo(44.16);
  expect(researchGrowthPivotStop("sepa-pivot-max", 50, 48)).toBe(45);
  expect(researchGrowthPivotStop("canslim-pivot-max", 50, 48)).toBe(46);
  expect(researchGrowthPivotStop("canslim-pivot-max", 50, 52)).toBeCloseTo(
    47.84,
  );
});
it.each(growthPivotStopIds)(
  "%s rejects missing/invalid pivot and preserves exact identity",
  (kind) => {
    const management = researchManagementSchema.parse(
      growthPivotStopTemplate(kind),
    );
    for (const pivot of [undefined, 0, -1, NaN, Infinity])
      expect(researchGrowthPivotStop(kind, 50, pivot)).toBeNull();
    expect(researchInitialStop(management, 50, {})).toBeNull();
    expect(
      researchInitialStop(management, 50, {
        entryPriceRange: { min: 48, max: 50.4 },
      }),
    ).toBe(researchGrowthPivotStop(kind, 50, 48));
    expect(
      researchMethodSnapshot({ strategy: "sepa-vcp-close", management }),
    ).toMatchObject({
      growthPivotStop: { kind, version: "growth-pivot-stop-1" },
    });
  },
);
