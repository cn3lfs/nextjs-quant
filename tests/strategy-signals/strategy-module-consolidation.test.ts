import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";
import {
  classicIds,
  classicIndicatorSeries,
  createClassicRule,
} from "../../packages/trading-strategies/src/classics/index";

function ascendingBars(count = 310) {
  return Array.from({ length: count }, (_, index) => ({
    date: new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(0, 10),
    open: 100 + index,
    close: 100 + index,
    high: 101 + index,
    low: 99 + index,
    volume: 1000,
    amount: (100 + index) * 1000,
  }));
}

const strategySource = resolve("packages/trading-strategies/src");

function dependencyViolations(text: string, file: string) {
  const violations: string[] = [];
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  function dependency(value: string) {
    if (value.startsWith(".")) {
      const location = relative(strategySource, resolve(dirname(file), value));
      if (location === ".." || /^\.\.[\\/]/.test(location))
        violations.push(value);
      return;
    }
    if (value !== "zod" && !/^trading-strategy-core(?:\/.*)?$/.test(value))
      violations.push(value);
  }
  function visit(node: ts.Node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      dependency(node.moduleSpecifier.text);
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      dependency(node.argument.literal.text);
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression)
    )
      dependency(node.moduleReference.expression.text);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteral(argument)) dependency(argument.text);
      else violations.push("computed import");
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return violations;
}

it("all strategy calculations and contracts belong to the independent package", () => {
  for (const name of readdirSync(strategySource, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".ts"))) {
    const file = resolve(strategySource, name);
    expect(
      dependencyViolations(readFileSync(file, "utf8"), file),
      name,
    ).toEqual([]);
  }
});

it("retires original algorithm files instead of retaining forwarding compatibility modules", () => {
  const ledger: unknown = JSON.parse(
    readFileSync(resolve("docs/strategy-module-migration.json"), "utf8"),
  );
  if (typeof ledger !== "object" || ledger === null || Array.isArray(ledger))
    throw new Error("Migration ledger must be an old-to-new path mapping");
  const entries = Object.entries(ledger);
  expect(entries).toHaveLength(128);
  expect(new Set(entries.map(([, destination]) => destination)).size).toBe(128);
  expect(entries.filter(([source]) => source.endsWith(".json"))).toHaveLength(
    1,
  );
  for (const [source, destination] of entries) {
    if (typeof destination !== "string")
      throw new Error(`Invalid destination for ${source}`);
    expect(source.startsWith("src/"), source).toBe(true);
    expect(
      destination.startsWith("packages/trading-strategies/src/"),
      destination,
    ).toBe(true);
    expect(existsSync(resolve(source)), source).toBe(false);
    expect(existsSync(resolve(destination)), destination).toBe(true);
    if (source.endsWith(".json"))
      expect(
        JSON.parse(readFileSync(resolve(destination), "utf8")),
      ).not.toBeNull();
  }
  for (const file of [
    ["src", "lib", "research", "methods", "volume", "research-volume.ts"].join(
      "/",
    ),
    [
      "src",
      "lib",
      "research",
      "methods",
      "chan",
      "research-chan-native.ts",
    ].join("/"),
    [
      "src",
      "lib",
      "research",
      "methods",
      "swing",
      "research-swing-core.ts",
    ].join("/"),
    ["src", "server", "strategies", "breakout", "breakout.ts"].join("/"),
    ["src", "server", "strategies", "canslim", "vcp.ts"].join("/"),
    ["src", "lib", "research", "technical", "research-execution.ts"].join("/"),
  ])
    expect(existsSync(resolve(file)), file).toBe(false);
  for (const file of [
    "research/volume/research-volume.ts",
    "research/chan/research-chan-native.ts",
    "research/swing/research-swing-core.ts",
  ])
    expect(existsSync(resolve(strategySource, file)), file).toBe(true);
});

it("rejects reverse dependencies even when hidden behind type-only or dynamic imports", () => {
  const file = resolve(strategySource, "negative-control.ts");
  const cases = [
    ['import type { Bar } from "~/lib/domain";', "~/lib/domain"],
    ['type State = import("quant-backtest").BacktestResult;', "quant-backtest"],
    [
      'type State = import("../../../src/server/db").State;',
      "../../../src/server/db",
    ],
    ['const source = import("node:fs");', "node:fs"],
    ['export type { State } from "~/server/db";', "~/server/db"],
    ['import source = require("node:fs");', "node:fs"],
  ];
  for (const [code, expected] of cases)
    expect(dependencyViolations(code!, file)).toEqual([expected]);
  expect(dependencyViolations("const source = import(name);", file)).toEqual([
    "computed import",
  ]);
  expect(
    dependencyViolations(
      'import type { Bar } from "trading-strategy-core/bars";',
      file,
    ),
  ).toEqual([]);
});

it("new classics obey independently calculated IBS, Aroon, KAMA and Vortex examples", () => {
  const bars = ascendingBars();
  expect(classicIndicatorSeries("classic-ibs", bars)[0]).toEqual({
    value: 0.5,
    signal: 0.5,
  });
  expect(classicIndicatorSeries("classic-aroon", bars)[25]).toEqual({
    value: 100,
    signal: 0,
  });
  expect(classicIndicatorSeries("classic-kama", bars)[10]!.value).toBeCloseTo(
    109 + 4 / 9,
    12,
  );
  expect(classicIndicatorSeries("classic-vortex", bars)[14]).toEqual({
    value: 1,
    signal: 0,
  });
  const nvi = classicIndicatorSeries("classic-nvi", bars);
  expect(nvi.at(-1)).toEqual({ value: 1000, signal: 1000 });
});

it("every new classic has causal prefixes, preserves inputs and suppresses unavailable observations", () => {
  const bars = ascendingBars().map((bar, index) => ({
    ...bar,
    close: bar.close + Math.sin(index / 5) / 2,
  }));
  const before = structuredClone(bars);
  for (const id of classicIds) {
    const short = classicIndicatorSeries(id, bars.slice(0, 280));
    expect(classicIndicatorSeries(id, bars).slice(0, 280), id).toEqual(short);
    const rule = createClassicRule(id, bars)!;
    for (const [index, point] of short.entries()) {
      if (point.value === null || point.signal === null)
        expect(
          rule(index, { entry: 100, entryIndex: 0 }),
          `${id}:${index}`,
        ).toEqual({ enter: false, exit: false });
    }
  }
  expect(bars).toEqual(before);
});
