import { expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import ts from "typescript";

function forbiddenDependencies(source: string) {
  const file = ts.createSourceFile(
    "module.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const found: string[] = [];
  function check(node: ts.Node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      if (
        !ts.isStringLiteral(node.moduleSpecifier) ||
        !node.moduleSpecifier.text.startsWith("./")
      )
        found.push(node.moduleSpecifier.getText(file));
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        node.expression.getText(file) === "require")
    )
      found.push(node.getText(file));
    ts.forEachChild(node, check);
  }
  check(file);
  return found;
}
it("keeps the performance module independent from backtest, UI and all host IO; the guard detects violations", () => {
  for (const name of readdirSync("packages/quant-performance/src"))
    expect(
      forbiddenDependencies(
        readFileSync(resolve("packages/quant-performance/src", name), "utf8"),
      ),
    ).toEqual([]);
  for (const source of [
    'import {readFile} from "node:fs";',
    'export {runBacktest} from "quant-backtest";',
    'import {db} from "../../src/server/db";',
    'import React from "react";',
    'const fs = import("node:fs");',
  ])
    expect(forbiddenDependencies(source).length).toBeGreaterThan(0);
  const performance = JSON.parse(
    readFileSync("packages/quant-performance/package.json", "utf8"),
  );
  const backtest = JSON.parse(
    readFileSync("packages/quant-backtest/package.json", "utf8"),
  );
  expect(Object.keys(performance.dependencies ?? {})).toEqual([]);
  expect(backtest.dependencies["quant-performance"]).toBeUndefined();
});
it("imports the public ESM entry outside the application and returns a report without a database or host", () => {
  const url = pathToFileURL(
    resolve("packages/quant-performance/dist/index.js"),
  ).href;
  const script = `const m=await import(${JSON.stringify(url)});const p=[{date:'2025-01-02',value:110},{date:'2025-01-03',value:88}];const r=m.createPerformanceReport(100,p);process.stdout.write(JSON.stringify({total:r.overview.totalReturn.value,quarter:r.quarter.length}));`;
  const result = JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: tmpdir(),
      encoding: "utf8",
      windowsHide: true,
    }),
  );
  expect(result.total).toBeCloseTo(-0.12);
  expect(result.quarter).toBe(1);
});
