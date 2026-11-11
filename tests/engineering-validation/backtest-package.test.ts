import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import ts from "typescript";

function forbiddenImports(
  source: string,
  file = resolve("packages/quant-backtest/src/module.ts"),
) {
  const ast = ts.createSourceFile(
    "module.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  return ast.statements.filter(ts.isImportDeclaration).flatMap((node) => {
    const id = (node.moduleSpecifier as ts.StringLiteral).text;
    if (id.startsWith(".")) {
      const boundary = relative(
        resolve("packages/quant-backtest/src"),
        resolve(dirname(file), id),
      );
      return boundary === ".." ||
        boundary.startsWith("../") ||
        boundary.startsWith("..\\")
        ? [id]
        : [];
    }
    return id === "zod" ||
      id === "trading-strategies" ||
      /^trading-strategy-core(?:\/.*)?$/.test(id)
      ? []
      : [id];
  });
}
it("package core depends only on shared primitives and schema validation, never the app or IO", () => {
  for (const file of readdirSync("packages/quant-backtest/src", {
    recursive: true,
  })
    .map(String)
    .filter((f) => f.endsWith(".ts")))
    expect(
      forbiddenImports(
        readFileSync(resolve("packages/quant-backtest/src", file), "utf8"),
        resolve("packages/quant-backtest/src", file),
      ),
      file,
    ).toEqual([]);
  expect(forbiddenImports('import { sqlite } from "~/server/db";')).toEqual([
    "~/server/db",
  ]);
  expect(
    forbiddenImports('import { sqlite } from "../../../src/server/db.js";'),
  ).toEqual(["../../../src/server/db.js"]);
});
it("built package executes from outside the app directory through public ESM exports", () => {
  const url = pathToFileURL(
    resolve("packages/quant-backtest/dist/index.js"),
  ).href;
  const code = `import { runMaBaseline,maBaselineInputSchema } from ${JSON.stringify(url)};
  const input=maBaselineInputSchema.parse({symbol:'sh600519',start:'2026-10-12',end:'2026-10-12',costs:{commissionBps:0,minimumCommission:0,sellTaxBps:0,slippageBps:0}});
  const bars=Array.from({length:40},(_,i)=>{const m=575+(i%20)*5;const close=i<20?10:11;return {date:(i<20?'2026-10-09':'2026-10-12')+'T'+String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0')+':00+08:00',open:10,high:12,low:9,close,volume:100,amount:1000};});
  const result=runMaBaseline(input,bars);console.log(JSON.stringify({version:result.engineVersion,fills:result.fills.length,shares:result.shares}));`;
  const result = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", code],
    { cwd: tmpdir(), encoding: "utf8", windowsHide: true },
  );
  expect(JSON.parse(result)).toEqual({
    version: "ts-backtest-foundation-1",
    fills: 1,
    shares: 10000,
  });
});
