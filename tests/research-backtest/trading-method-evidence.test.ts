import { expect, it } from "vitest";
import raw from "../../docs/trading-skills-method-map.json";
import { tradingMethodMapSchema } from "../../scripts/lib/trading-method-map";
import {
  collectMethodEvidence,
  reconcileMethodEvidence,
  type MethodEvidence,
} from "../../scripts/lib/trading-method-evidence";
import { researchStrategyFamilies } from "../../src/lib/research/specs/research-strategies";
const map = tradingMethodMapSchema.parse(raw);
const evidence = collectMethodEvidence(researchStrategyFamilies);
it("includes package-owned rule tests and resolves their source imports", () => {
  const test =
    "packages/trading-strategies/tests/growth-intraday-policy.test.ts";
  expect(evidence.tests.has(test)).toBe(true);
  expect(evidence.imports.get(test)).toContain(
    "packages/trading-strategies/src/research/growth/growth-intraday-policy.ts",
  );
});
it("requires a declared test consumer for each library export without a retired application entrypoint", () => {
  const file = "src/lib/example.ts";
  const test = "tests/example.test.ts";
  const fixture = {
    ...map,
    methods: [
      {
        ...map.methods[0]!,
        id: "RK-export-fixture",
        implementation: [file],
        tests: [test],
        bindings: {
          presets: [],
          exports: [{ file, name: "compute" }],
          completion: "implemented-variant" as const,
        },
      },
    ],
  };
  const covered: MethodEvidence = {
    owners: new Map(),
    exports: new Map([[file, new Set(["compute"])]]),
    imports: new Map([[test, new Set([file])]]),
    tests: new Set([test]),
    files: new Set([file, test]),
  };
  expect(reconcileMethodEvidence(fixture, covered).errors).toEqual([]);
  const disconnected = { ...covered, imports: new Map<string, Set<string>>() };
  expect(reconcileMethodEvidence(fixture, disconnected).errors).toContain(
    `RK-export-fixture: implementation export missing/uncovered: ${file}#compute`,
  );
  const absent = { ...covered, exports: new Map<string, Set<string>>() };
  expect(reconcileMethodEvidence(fixture, absent).errors).toContain(
    `RK-export-fixture: implementation export missing/uncovered: ${file}#compute`,
  );
});
it("discovers every executable preset and consumes real test modules without manual counts", () => {
  const result = reconcileMethodEvidence(map, evidence);
  expect(result.errors).toEqual([]);
  expect(result.changes).toEqual([]);
  expect(result.map.methods).toHaveLength(695);
  for (const family of researchStrategyFamilies)
    expect(Object.keys(family.strategies).sort()).toEqual(
      [...family.ids].sort(),
    );
});
it("reports registration absent from map, and claimed implementation without code/tests", () => {
  const unknown = {
    ...evidence,
    owners: new Map([
      ...evidence.owners,
      [
        "flag-unmapped",
        "packages/trading-strategies/src/research/technical/research-channels.ts",
      ],
    ]),
  };
  expect(reconcileMethodEvidence(map, unknown).errors).toContain(
    "registered preset missing from method map: flag-unmapped",
  );
  const missing = { ...evidence, owners: new Map(evidence.owners) };
  missing.owners.delete("flag-10");
  expect(
    reconcileMethodEvidence(map, missing).errors.some((e) =>
      e.includes("preset has no implementation: flag-10"),
    ),
  ).toBe(true);
  const noTests = { ...evidence, tests: new Set<string>() };
  expect(
    reconcileMethodEvidence(map, noTests).errors.some((e) =>
      e.includes("no test consumes implementation"),
    ),
  ).toBe(true);
});
it("backfills stale fields deterministically but never infers semantic completeness from a green test", () => {
  const changed = structuredClone(map);
  const row = changed.methods.find((m) => m.id === "SW05-flag")!;
  row.status = "planned";
  row.implementation = [];
  row.tests = [];
  const result = reconcileMethodEvidence(changed, evidence);
  const fixed = result.map.methods.find((m) => m.id === row.id)!;
  expect(fixed.status).toBe("implemented-variant");
  expect(fixed.implementation).toContain(
    "packages/trading-strategies/src/research/technical/research-channels.ts",
  );
  expect(fixed.tests).toContain(
    "tests/research-backtest/research-contracts.test.ts",
  );
  expect(result.changes.map((c) => c.id)).toContain(row.id);
  expect(reconcileMethodEvidence(result.map, evidence).changes).toEqual([]);
});
