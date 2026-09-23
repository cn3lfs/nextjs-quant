import { expect, it } from "vitest";
import { researchStrategyIds } from "../../src/lib/research/specs/research-strategies";
import {
  researchMethodSnapshot,
  validateResearchMethod,
} from "../../src/server/research/research-method";

it("every executable strategy resolves pinned source hashes without installed skills", () => {
  for (const strategy of researchStrategyIds) {
    const method = researchMethodSnapshot(strategy);
    expect(method.sources.length).toBeGreaterThan(0);
    expect(
      method.sources.every((source) => /^[a-f0-9]{64}$/.test(source.sha256)),
    ).toBe(true);
    expect(researchMethodSnapshot(strategy)).toEqual(method);
    expect(() => validateResearchMethod(strategy, method)).not.toThrow();
  }
});

it("rejects changed source, interpretation and strategy before replay; missing legacy provenance stays missing", () => {
  const saved = researchMethodSnapshot("ma-cross");
  expect(() => validateResearchMethod("ma-cross", undefined)).not.toThrow();
  expect(() => validateResearchMethod("czsc", saved)).toThrow("方法版本");
  expect(() =>
    validateResearchMethod("ma-cross", { ...saved, interpretation: "changed" }),
  ).toThrow("方法版本");
  const changed = structuredClone(saved);
  changed.sources[0]!.sha256 = "0".repeat(64);
  expect(() => validateResearchMethod("ma-cross", changed)).toThrow("方法版本");
});
