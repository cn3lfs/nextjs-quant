import { expect, it } from "vitest";
import { spotTests } from "../../scripts/lib/verification";

it("adds contracts for strategy changes and rejects empty/traversing spot selections", () => {
  expect(
    spotTests(["tests/research-backtest/research-method.test.ts"]),
  ).toContain("tests/research-backtest/research-contracts.test.ts");
  expect(spotTests(["tests/persistence-infrastructure/core.test.ts"])).toEqual([
    "tests/persistence-infrastructure/core.test.ts",
  ]);
  expect(() => spotTests([])).toThrow();
  expect(() => spotTests(["tests/../x.test.ts"])).toThrow();
});

it("selects contracts from actual shared runtime dependencies even when test names differ", () => {
  const graph = new Map([
    ["tests/arbitrary.test.ts", new Set(["src/lib/shared.ts"])],
    [
      "tests/research-backtest/research-contracts.test.ts",
      new Set(["src/server/run.ts"]),
    ],
    ["src/server/run.ts", new Set(["src/lib/shared.ts"])],
  ]);
  expect(spotTests(["tests/arbitrary.test.ts"], graph)).toEqual([
    "tests/arbitrary.test.ts",
    "tests/research-backtest/research-contracts.test.ts",
  ]);
  expect(spotTests(["tests/unrelated.test.ts"], graph)).toEqual([
    "tests/unrelated.test.ts",
  ]);
});
