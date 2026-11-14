import { describe, expect, it } from "vitest";
import {
  buildResearchCompositeSpec,
  researchCompositeMethodIds,
  researchCompositePresetIds,
  researchCompositePresets,
} from "../../src/lib/research/specs/research-composite-presets";
import { researchSpecSchema } from "../../src/lib/research/strategy-research";

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

  // Regression guard for a real integration mistake (manager-verified against
  // an external, non-repo batch runner): a preset id is not a valid
  // `strategy` enum value, so `researchSpecSchema.parse({strategy: id, ...})`
  // throws `invalid_enum_value`. The only correct entry point is
  // `buildResearchCompositeSpec`, which expands the
  // preset onto a shared baseline strategy via `management`/`risk` instead.
  it("rejects every preset id as a `strategy` enum value (guards the direct schema.parse trap)", () => {
    for (const preset of researchCompositePresets)
      expect(
        researchSpecSchema.safeParse({ ...base, strategy: preset.id }).success,
        preset.id,
      ).toBe(false);
  });
});
