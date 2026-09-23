import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const componentDomains = [
  "backtest",
  "common",
  "data-sources",
  "intraday",
  "market",
  "news",
  "overview",
  "panels",
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
  expect(
    readdirSync("src/lib")
      .filter((entry) => statSync(join("src/lib", entry)).isFile())
      .sort(),
  ).toEqual(["completed-bars.ts", "domain.ts", "indicators.ts", "money.ts"]);
  expect(statSync("src/lib/common/classnames.ts").isFile()).toBe(true);
  expect(() => statSync("src/lib/utils.ts")).toThrow();
  expect(
    statSync("packages/trading-strategy-core/src/indicators.ts").isFile(),
  ).toBe(true);
});

it("keeps test suites inside their owning module directories", () => {
  const suites = readdirSync("tests", { recursive: true })
    .map(String)
    .filter((entry) => /\.(test|spec)\.tsx?$/.test(entry));
  expect(suites.length).toBeGreaterThan(450);
  expect(suites.every((entry) => entry.includes("/") || entry.includes("\\"))).toBe(true);
  expect(suites.some((entry) => /(?:^|[\\/])fixtures[\\/]/.test(entry))).toBe(false);
});
