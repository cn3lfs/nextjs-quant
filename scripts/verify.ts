import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { compareFailures, knownFailures, spotTests } from "./lib/verification";
import { collectMethodEvidence } from "./lib/trading-method-evidence";

const [mode, ...files] = process.argv.slice(2);
if (mode !== "spot" && mode !== "batch")
  throw new Error("Use verify:spot <tests...> or verify:batch");
if (mode === "batch" && files.length)
  throw new Error("verify:batch takes no arguments");
const selected =
  mode === "spot" ? spotTests(files, collectMethodEvidence([]).imports) : [];
const pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error("Run through pnpm verify:spot / verify:batch");
const parent = resolve(tmpdir(), "quant-verification");
mkdirSync(parent, { recursive: true });
function remove(name: string) {
  const target = resolve(parent, name);
  if (dirname(target) !== parent || !/^\d+-[\w-]+$/.test(name))
    throw new Error("Unsafe cleanup path");
  rmSync(target, { recursive: true, force: true, maxRetries: 3 });
}
// This command owns only timestamped runs here. A crashed run is reclaimed after 24h.
for (const entry of readdirSync(parent, { withFileTypes: true })) {
  if (
    entry.isDirectory() &&
    /^\d+-[\w-]+$/.test(entry.name) &&
    Date.now() - Number(entry.name.split("-")[0]) > 86400000
  )
    remove(entry.name);
}
const run = mkdtempSync(join(parent, `${Date.now()}-`));
const env = {
  ...process.env,
  QUANT_DATA_DIR: join(run, "data"),
  TEMP: run,
  TMP: run,
  TMPDIR: run,
  QUANT_VERIFY_RUNTIME_REPORT: join(run, "runtime-errors.json"),
};
const failures: string[] = [];
function command(args: string[], tolerateTestExit = false) {
  console.log(`\n> pnpm ${args.join(" ")}`);
  const result = spawnSync(process.execPath, [pnpm!, ...args], {
    env,
    stdio: "inherit",
  });
  if (
    result.error ||
    result.signal ||
    (result.status !== 0 && !(tolerateTestExit && result.status === 1))
  )
    failures.push(args.join(" "));
  return result.status;
}
try {
  if (mode === "spot") command(["run", "test", ...selected]);
  else {
    command(["typecheck"]);
    const registered = knownFailures(
      readFileSync("docs/known-test-failures.md", "utf8"),
    );
    const report = join(run, "vitest.json");
    command(
      [
        "run",
        "test",
        "--reporter=default",
        "--reporter=json",
        "--reporter=./scripts/lib/verification-reporter.ts",
        `--outputFile=${report}`,
      ],
      registered.length > 0,
    );
    try {
      failures.push(
        ...compareFailures(
          JSON.parse(readFileSync(report, "utf8")),
          registered,
        ),
      );
    } catch (error) {
      failures.push(`Invalid/missing test report: ${String(error)}`);
    }
    try {
      const runtime = JSON.parse(
        readFileSync(env.QUANT_VERIFY_RUNTIME_REPORT, "utf8"),
      ) as { reason: string; errors: unknown[] };
      if (
        !Array.isArray(runtime.errors) ||
        runtime.errors.length ||
        !["passed", "failed"].includes(runtime.reason)
      )
        failures.push("Unhandled runtime errors or interrupted tests");
    } catch (error) {
      failures.push(`Missing runtime error report: ${String(error)}`);
    }
    command(["build"]);
    command(["exec", "tsx", "scripts/audit-trading-skills.ts"]);
    command(["exec", "tsx", "scripts/audit-trading-methods.ts"]);
    command(["format:check"]);
    const diff = spawnSync("git", ["diff", "--check"], {
      env,
      stdio: "inherit",
    });
    if (diff.status !== 0) failures.push("git diff --check");
  }
} finally {
  try {
    remove(run.slice(parent.length + 1));
  } catch (error) {
    failures.push(`Cleanup failed: ${run}: ${String(error)}`);
  }
}
console.log(JSON.stringify({ mode, failures }, null, 2));
if (failures.length) process.exitCode = 1;
