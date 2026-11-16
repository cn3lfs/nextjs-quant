import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  lifecyclePreregistration,
  applyLifecyclePatch,
} from "../../scripts/lib/research/lifecycle-menu";
import { strategyObjectSchema } from "../../packages/trading-strategies/src/strategy-object";

it("freezes the exact 16 main /104 valid neighbors and keeps 8 schema noops outside the trial count", () => {
  const registry = lifecyclePreregistration();
  expect(JSON.parse(readFileSync("research/configs/l3.json", "utf8"))).toEqual(
    registry,
  );
  expect(registry.limits).toMatchObject({
    main: 16,
    neighbors: 104,
    economicConfigurations: 120,
    schemaNoops: 8,
    schemaNoopsActuallyRun: 0,
    executionScenarios: 360,
  });
  expect(
    registry.families.map((f) => [f.main, f.economicConfigurations]),
  ).toEqual([
    [7, 47],
    [1, 5],
    [4, 24],
    [4, 44],
  ]);
  const identities = [...registry.main, ...registry.neighbors].map((c) => c.id);
  expect(new Set(identities).size).toBe(120);
  for (const row of registry.main) strategyObjectSchema.parse(row.strategy);
  for (const row of registry.main.filter(
    (r) => r.strategy.market === "crypto",
  )) {
    expect(row.strategy.universe).toEqual({
      kind: "symbols",
      symbols: ["BTCUSDT", "ETHUSDT"],
    });
    expect(row.strategy.sizing).toEqual({
      kind: "equal",
      positions: 2,
      tranches: 1,
    });
  }
  for (const neighbor of registry.neighbors) {
    const parent = registry.main.find((r) => r.id === neighbor.parent)!;
    const changed = applyLifecyclePatch(parent, neighbor);
    strategyObjectSchema.parse(changed.strategy);
    expect({
      ...changed,
      id: parent.id,
      strategy: { ...changed.strategy, id: parent.id },
    }).not.toEqual(parent);
  }
  for (const neighbor of registry.schemaNoops) {
    const parent = registry.main.find((r) => r.id === neighbor.parent)!;
    const changed = applyLifecyclePatch(parent, neighbor);
    expect({
      ...changed,
      id: parent.id,
      strategy: { ...changed.strategy, id: parent.id },
    }).toEqual(parent);
  }
});
