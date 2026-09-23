import { expect, it } from "vitest";
import { resolve } from "node:path";
import {
  compareFailures,
  knownFailures,
  spotTests,
} from "../../scripts/lib/verification";
const failure = {
  file: "tests/x.test.ts",
  line: 1,
  assertion: "case",
  reason: "guard",
  reviewWhen: "next change",
};
const report = (status: string) => ({
  numTotalTests: 1,
  numFailedTests: status === "failed" ? 1 : 0,
  testResults: [
    {
      name: resolve(failure.file),
      status,
      assertionResults: [{ fullName: "case", status }],
    },
  ],
});
it("compares both directions and never treats load errors as registered assertions", () => {
  expect(knownFailures("```json\n[]\n```")).toEqual([]);
  expect(compareFailures(report("passed"), [])).toEqual([]);
  expect(compareFailures(report("failed"), [])).toHaveLength(1);
  expect(compareFailures(report("failed"), [failure])).toEqual([]);
  expect(compareFailures(report("passed"), [failure])).toHaveLength(1);
  expect(
    compareFailures(
      {
        ...report("failed"),
        testResults: [
          {
            name: resolve(failure.file),
            status: "failed",
            assertionResults: [],
          },
        ],
      },
      [failure],
    ).length,
  ).toBeGreaterThan(0);
  expect(() => knownFailures("[]")).toThrow();
});
it("adds contracts for strategy changes and rejects empty/traversing spot selections", () => {
  expect(spotTests(["tests/research-backtest/research-method.test.ts"])).toContain(
    "tests/research-backtest/research-contracts.test.ts",
  );
  expect(spotTests(["tests/persistence-infrastructure/core.test.ts"])).toEqual(["tests/persistence-infrastructure/core.test.ts"]);
  expect(() => spotTests([])).toThrow();
  expect(() => spotTests(["tests/../x.test.ts"])).toThrow();
});

it("selects contracts from actual shared runtime dependencies even when test names differ", () => {
  const graph = new Map([
    ["tests/arbitrary.test.ts", new Set(["src/lib/shared.ts"])],
    ["tests/research-backtest/research-contracts.test.ts", new Set(["src/server/run.ts"])],
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
