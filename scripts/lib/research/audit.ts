import { task, config, json, readArtifact, delivery } from "./context";
import { readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
const tests = [
  "tests/research-backtest/backtest/corporate-actions.test.ts",
  "tests/research-backtest/backtest/portfolio-event.test.ts",
  "tests/research-backtest/research-corporate-actions.test.ts",
  "tests/research-backtest/crypto-sizing.test.ts",
  "tests/research-backtest/portfolio-score-mode.test.ts",
];
let output = "";
const exitCode = await new Promise<number>((resolveExit, reject) => {
  const child = spawn(
    process.execPath,
    [resolve("node_modules/vitest/vitest.mjs"), "run", ...tests],
    {
      cwd: resolve("."),
      windowsHide: true,
      env: {
        ...process.env,
        QUANT_DATA_DIR: join(task, "audit-test-data"),
        FORCE_COLOR: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (data: Buffer) => {
    output += data.toString();
  });
  child.stderr.on("data", (data: Buffer) => {
    output += data.toString();
  });
  child.on("error", reject);
  child.on("exit", (code) => resolveExit(code ?? 1));
});
await writeFile(join(task, "audit-tests.log"), output);
if (exitCode !== 0)
  throw new Error(
    "Financial hand-calculation/parity tests failed; see audit-tests.log",
  );
const verified = [];
for (const name of await readdir(task)) {
  if (!name.endsWith("-pointer.json") && !name.endsWith("-progress.json"))
    continue;
  const value = await json<{
    path?: string;
    sha256?: string;
    pointer?: { path: string; sha256: string };
  }>(join(task, name));
  const pointer =
    value.pointer ??
    (value.path && value.sha256
      ? { path: value.path, sha256: value.sha256 }
      : null);
  if (pointer) {
    await readArtifact(pointer);
    verified.push(name);
  }
}
const testsPassed = Number(output.match(/Tests\s+(\d+) passed/)?.[1] ?? 0);
if (testsPassed === 0) throw new Error("Zero tests is not an audit pass");
await delivery({
  engineAudit: {
    status: "passed",
    batch: config.batch,
    exitCode,
    testsPassed,
    tests,
    verifiedPointers: verified.length,
    evidence: "audit-tests.log",
  },
});
console.log(
  JSON.stringify({
    audit: true,
    exitCode,
    testsPassed,
    verifiedPointers: verified.length,
  }),
);
process.exit(0);
