import { expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";
import {
  checkStrategyAvailability,
  evaluateStrategy,
  getStrategyDefinition,
  unifiedStrategyCatalog,
} from "trading-strategies";

function forbiddenStrategyImports(source: string, file: string): string[] {
  const forbidden: string[] = [];
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  function check(id: string) {
    if (id.startsWith(".")) {
      const boundary = relative(
        resolve("packages/trading-strategies/src"),
        resolve(dirname(file), id),
      );
      if (
        boundary === ".." ||
        boundary.startsWith("../") ||
        boundary.startsWith("..\\")
      )
        forbidden.push(id);
    } else if (
      id !== "zod" &&
      id !== "quant-rps" &&
      !/^trading-strategy-core(?:\/.*)?$/.test(id)
    ) {
      forbidden.push(id);
    }
  }
  function visit(node: ts.Node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      check(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteral(argument)) check(argument.text);
      else forbidden.push("computed import");
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return forbidden;
}

it("strategy rules depend only on shared primitives and schemas, never app, execution or IO", () => {
  const root = resolve("packages/trading-strategies/src");
  for (const name of readdirSync(root, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".ts"))) {
    const file = resolve(root, name);
    expect(
      forbiddenStrategyImports(readFileSync(file, "utf8"), file),
      name,
    ).toEqual([]);
  }
  const file = resolve(root, "negative-control.ts");
  for (const id of [
    "quant-backtest",
    "node:fs",
    "~/server/db",
    "../../../src/server/db.js",
  ])
    expect(
      forbiddenStrategyImports(
        `import { value } from ${JSON.stringify(id)};`,
        file,
      ),
    ).toEqual([id]);
  expect(
    forbiddenStrategyImports('export * from "quant-backtest";', file),
  ).toEqual(["quant-backtest"]);
  expect(
    forbiddenStrategyImports('const fs = import("node:fs");', file),
  ).toEqual(["node:fs"]);
});

it("exposes distinct identities and keeps unavailable research non executable", () => {
  expect(new Set(unifiedStrategyCatalog.map((item) => item.id)).size).toBe(
    unifiedStrategyCatalog.length,
  );
  expect(getStrategyDefinition("not-a-strategy")).toBeUndefined();
  expect(checkStrategyAvailability("not-a-strategy", []).available).toBe(false);
  for (const definition of unifiedStrategyCatalog.filter(
    (item) => item.implementation !== "implemented",
  )) {
    expect(
      checkStrategyAvailability(definition.id, definition.capabilities)
        .available,
    ).toBe(false);
    expect(() =>
      evaluateStrategy({ strategyId: definition.id }, { asOf: "2026-11-06" }),
    ).toThrow();
  }
});

it("ranking excludes future and missing observations, uses deterministic ties and does not mutate input", () => {
  const context = {
    asOf: "2026-11-06",
    candidates: [
      { symbol: "b", availableAt: "2026-11-06", values: { momentum: 1 } },
      { symbol: "a", availableAt: "2026-11-06", values: { momentum: 1 } },
      { symbol: "future", availableAt: "2026-11-07", values: { momentum: 9 } },
      {
        symbol: "missing",
        availableAt: "2026-11-06",
        values: { momentum: null },
      },
    ],
  };
  const original = structuredClone(context);
  expect(
    evaluateStrategy(
      { strategyId: "rank-momentum", parameters: { topK: 1 } },
      context,
    ),
  ).toEqual({
    kind: "weights",
    weights: [{ symbol: "a", weight: 1 }],
    excluded: ["future", "missing"],
  });
  expect(context).toEqual(original);
});

it("inverse-volatility allocation returns normalized finite weights and empty pools remain empty", () => {
  const result = evaluateStrategy(
    { strategyId: "allocation-inverse-volatility" },
    {
      asOf: "2026-11-06",
      candidates: [
        { symbol: "a", availableAt: "2026-11-06", values: { volatility: 0.1 } },
        { symbol: "b", availableAt: "2026-11-06", values: { volatility: 0.2 } },
        {
          symbol: "zero",
          availableAt: "2026-11-06",
          values: { volatility: 0 },
        },
      ],
    },
  );
  expect(result.kind).toBe("weights");
  if (result.kind !== "weights") throw new Error("expected weights");
  expect(
    result.weights.find((item) => item.symbol === "a")!.weight,
  ).toBeCloseTo(2 / 3);
  expect(
    result.weights.find((item) => item.symbol === "b")!.weight,
  ).toBeCloseTo(1 / 3);
  expect(result.excluded).toEqual(["zero"]);
  expect(
    evaluateStrategy(
      { strategyId: "rank-quality" },
      { asOf: "2026-11-06", candidates: [] },
    ),
  ).toEqual({ kind: "weights", weights: [], excluded: [] });
});

it("daily signals use the decision prefix, reject malformed dates and require sufficient warmup", () => {
  const bars = Array.from({ length: 340 }, (_, index) => {
    const price = 100 + index / 10;
    return {
      date: new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10),
      open: price,
      high: price + 1,
      low: price - 1,
      close: price,
      volume: 1000,
      amount: 1000 * price,
    };
  });
  const instance = { strategyId: "sma200" };
  const asOf = bars[320]!.date;
  expect(
    evaluateStrategy(instance, { asOf, bars: bars.slice(0, 321) }),
  ).toEqual({
    kind: "signal",
    enter: true,
    exit: false,
  });
  expect(evaluateStrategy(instance, { asOf, bars })).toEqual(
    evaluateStrategy(instance, { asOf, bars: bars.slice(0, 321) }),
  );
  expect(() =>
    evaluateStrategy(instance, { asOf, bars: bars.slice(0, 10) }),
  ).toThrow();
  expect(() =>
    evaluateStrategy(instance, { asOf: "2026-02-30", bars }),
  ).toThrow();
});
