import { expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyTestFiles } from "../../scripts/lib/test-projects";
it("follows runtime dependencies and fails closed for opaque IO, dynamic imports and unreviewed packages", () => {
  const root = mkdtempSync(join(tmpdir(), "classification-"));
  mkdirSync(join(root, "tests"));
  const add = (file: string, source: string) =>
    writeFileSync(join(root, file), source);
  try {
    add("pure.ts", "export const twice=(n:number)=>n*2");
    add(
      "io.ts",
      'import {writeFileSync as save} from "node:fs"; export const run=()=>save("x","x")',
    );
    add("tests/pure.test.ts", 'import {twice} from "../pure";');
    add("tests/io.test.ts", 'import {run} from "../io";');
    add("tests/types.test.ts", 'import type {run} from "../io";');
    add("tests/opaque.test.ts", 'import fs from "node:fs";');
    add("tests/dynamic.test.ts", "const load=(s:string)=>import(s);");
    add("tests/package.test.ts", 'import runtime from "unknown-runtime";');
    add("tests/read.test.ts", 'import {readFileSync} from "node:fs";');
    add("tests/promises.test.ts", 'import {promises} from "node:fs";');
    const groups = classifyTestFiles(root);
    expect(groups.parallel).toEqual([
      "tests/pure.test.ts",
      "tests/read.test.ts",
      "tests/types.test.ts",
    ]);
    expect(groups.serial).toEqual([
      "tests/dynamic.test.ts",
      "tests/io.test.ts",
      "tests/opaque.test.ts",
      "tests/package.test.ts",
      "tests/promises.test.ts",
    ]);
    expect(groups.reasons["tests/io.test.ts"]).toContain(
      "io.ts: writable filesystem",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("partitions all root tests among heavy, io and pure without overlaps", () => {
  const { heavy, serial, parallel, reasons } = classifyTestFiles();
  const files = readdirSync("tests", { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map((entry) => join(entry.parentPath, entry.name).replaceAll("\\", "/"))
    .sort();

  expect([...heavy, ...serial, ...parallel].sort()).toEqual(files);
  expect(heavy).toEqual(
    expect.arrayContaining([
      "tests/engineering-validation/formula-worker-termination.test.ts",
      "tests/engineering-validation/lint-rules.test.ts",
      "tests/engineering-validation/local-check.test.ts",
      "tests/engineering-validation/quant-team-process.test.ts",
      "tests/market-chart/five-minute-audit.test.ts",
      "tests/market-chart/five-minute-estimate.test.ts",
      "tests/research-backtest/backtest/financial-replay-cli.test.ts",
    ]),
  );
  expect(serial.every((file) => file in reasons)).toBe(true);
  expect(parallel.every((file) => !(file in reasons))).toBe(true);
});
