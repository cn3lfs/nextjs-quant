import { describe, expect, it } from "vitest";
import {
  buildResearchCompositeSpec,
  researchCompositeMethodIds,
  researchCompositePresetIds,
  researchCompositePresets,
} from "../../src/lib/research/specs/research-composite-presets";
import { researchSpecSchema } from "../../src/lib/research/strategy-research";
import {
  buildNamedResearchSpec,
  researchNamedRunSpecs,
} from "../../src/server/backtest/research-run";

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
  // `buildNamedResearchSpec`/`buildResearchCompositeSpec`, which expand the
  // preset onto a shared baseline strategy via `management`/`risk` instead.
  it("rejects every preset id as a `strategy` enum value (guards the direct schema.parse trap)", () => {
    for (const preset of researchCompositePresets)
      expect(
        researchSpecSchema.safeParse({ ...base, strategy: preset.id }).success,
        preset.id,
      ).toBe(false);
  });

  // All 162 presets currently expand onto the same shared baseline
  // `spec.strategy`, so any caller keying results by `spec.strategy` (rather
  // than the preset id) collapses them into a single row. `researchNamedRunSpecs`
  // is the tested pairing that keeps preset id and spec together so callers
  // never need to (mis)use `spec.strategy` as an identity key.
  it("enumerates every preset as an {id, spec} pair that does not collapse by spec.strategy", () => {
    const pairs = researchNamedRunSpecs(base);
    expect(pairs).toHaveLength(162);
    expect(pairs.map((p) => p.id)).toEqual(researchCompositePresetIds);
    expect(new Set(pairs.map((p) => p.id)).size).toBe(162);
    // Confirms the collapse risk is real: the distinguishing baseline field
    // alone cannot key results (most presets share it), which is exactly why
    // the pairing above must be used instead of `spec.strategy`.
    expect(new Set(pairs.map((p) => p.spec.strategy)).size).toBeLessThan(162);
    // But the full specs are not themselves collapsed: distinct presets carry
    // distinct management/risk configuration even though strategy matches.
    expect(
      new Set(pairs.map((p) => JSON.stringify(p.spec))).size,
    ).toBeGreaterThan(1);
    for (const { id, spec } of pairs)
      expect(buildNamedResearchSpec(id, base)).toEqual(spec);
  });
});
