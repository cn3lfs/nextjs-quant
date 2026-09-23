import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const componentDomains = [
  "backtest",
  "common",
  "intraday",
  "market",
  "news",
  "portfolio",
  "research",
  "screening",
  "signals",
  "ui",
  "workbench",
];

it("keeps business components out of the components root", () => {
  const rootFiles = readdirSync("src/components").filter((entry) =>
    statSync(join("src/components", entry)).isFile(),
  );
  expect(rootFiles).toEqual([]);
  expect(readdirSync("src/components").sort()).toEqual(componentDomains.sort());
});

it("keeps shared class names and strategy primitives in explicit ownership", () => {
  expect(statSync("src/lib/common/classnames.ts").isFile()).toBe(true);
  expect(() => statSync("src/lib/utils.ts")).toThrow();
  expect(
    statSync("packages/trading-strategy-core/src/indicators.ts").isFile(),
  ).toBe(true);
});
