import { expect, it } from "vitest";
import { researchStrategyIds } from "../../src/lib/research/specs/research-strategies";
import { researchMethodSnapshot } from "../../src/server/research/research-method";

it("every executable strategy resolves non-empty source paths", () => {
  for (const strategy of researchStrategyIds) {
    const method = researchMethodSnapshot(strategy);
    expect(method.sources.length).toBeGreaterThan(0);
    expect(
      method.sources.every(
        (source) => typeof source.path === "string" && source.path.length > 0,
      ),
    ).toBe(true);
    expect(researchMethodSnapshot(strategy)).toEqual(method);
  }
});

it("changes the method snapshot when configuration or source paths change", () => {
  const saved = researchMethodSnapshot("ma-cross");
  expect(researchMethodSnapshot("czsc")).not.toEqual(saved);
  expect(researchMethodSnapshot("ma-cross", true)).not.toEqual(saved);
  const changed = structuredClone(saved);
  changed.sources[0]!.path = "changed.md";
  expect(researchMethodSnapshot("ma-cross")).not.toEqual(changed);
});
