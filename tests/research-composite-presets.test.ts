import { describe, expect, it } from "vitest";
import {
  buildResearchCompositeSpec,
  researchCompositeMethodIds,
  researchCompositePresetIds,
  researchCompositePresets,
} from "../src/lib/research-composite-presets";
import { researchSpecSchema } from "../src/lib/strategy-research";

const base = researchSpecSchema.parse({
  strategy: "dual-breakout",
  symbols: ["sh600000"],
  pool: null,
  start: "2000-01-04",
  end: "2022-11-30",
  validationStart: "2017-01-04",
  holdingDays: 60,
  initialCapital: 100000,
  maxPositions: 5,
  entryMaxWait: 3,
});

describe("R3b named composite presets", () => {
  it("declares one fixed-entry preset for every B2/B5 method", () => {
    expect(researchCompositePresets).toHaveLength(162);
    expect(new Set(researchCompositeMethodIds).size).toBe(162);
    expect(new Set(researchCompositePresetIds).size).toBe(162);
    for (const preset of researchCompositePresets) {
      expect(preset.baseline).toBe("dual-breakout");
      expect(preset.id).toContain("-dual-breakout");
      expect(preset.component).toContain(preset.methodId);
      expect(buildResearchCompositeSpec(preset.id, base).strategy).toBeTruthy();
    }
  });
});
