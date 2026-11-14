import { afterEach, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { runLocalChecks } from "../../scripts/lib/local-check.mjs";

afterEach(() => {
  vi.unstubAllEnvs();
});
function fixture() {
  const root = mkdtempSync(join(process.env.QUANT_DATA_DIR!, "check-fixture-"));
  const production = join(root, "production");
  mkdirSync(production);
  writeFileSync(join(production, "sentinel"), "preserve");
  vi.stubEnv("QUANT_DATA_DIR", production);
  return { root, production };
}

it("uses fresh data and temp directories, preserves the caller's data, and includes the requested build", () => {
  const { root, production } = fixture();
  const steps: string[] = [];
  const envs: NodeJS.ProcessEnv[] = [];
  const options = {
    workspaceRoot: root,
    pnpmCli: "fixture-pnpm.cjs",
    checkRoot: join(root, ".test-data/checks"),
    includeBuild: true,
    runCommand: (
      _command: string,
      args: string[],
      input: { env: NodeJS.ProcessEnv },
    ) => {
      steps.push(args.at(-1)!);
      envs.push(input.env);
      writeFileSync(join(input.env.QUANT_DATA_DIR!, "child-write"), "isolated");
      return { status: 0 };
    },
  };
  const first = runLocalChecks(options);
  expect(first.exitCode).toBe(0);
  expect(steps).toEqual([
    "format:check",
    "check:dependencies",
    "runtime:build",
    "typecheck",
    "lint",
    "test",
    "build",
  ]);
  expect(
    envs.every(
      (env) =>
        env.QUANT_DATA_DIR === first.dataDirectory &&
        env.TEMP === join(first.dataDirectory, "temp") &&
        env.TMP === env.TEMP &&
        env.TMPDIR === env.TEMP,
    ),
  ).toBe(true);
  expect(runLocalChecks(options).dataDirectory).not.toBe(first.dataDirectory);
  expect(existsSync(join(production, "child-write"))).toBe(false);
  expect(readFileSync(join(production, "sentinel"), "utf8")).toBe("preserve");
  expect(process.env.QUANT_DATA_DIR).toBe(production);
});

it("stops on nonzero exit or launch failure and writes a reviewable result", () => {
  const { root } = fixture();
  const commands: string[] = [];
  const report = runLocalChecks({
    workspaceRoot: root,
    pnpmCli: "fixture",
    checkRoot: join(root, ".test-data/checks"),
    runCommand: (_command: string, args: string[]) => {
      const name = args.at(-1)!;
      commands.push(name);
      return { status: name === "lint" ? 23 : 0 };
    },
  });
  expect(report.exitCode).toBe(23);
  expect(commands).toEqual([
    "format:check",
    "check:dependencies",
    "runtime:build",
    "typecheck",
    "lint",
  ]);
  expect(
    JSON.parse(
      readFileSync(join(report.dataDirectory, "check-result.json"), "utf8"),
    ).exitCode,
  ).toBe(23);
  expect(
    runLocalChecks({
      workspaceRoot: root,
      pnpmCli: "fixture",
      checkRoot: join(root, ".test-data/checks"),
      runCommand: () => {
        throw new Error("Cannot launch");
      },
    }).exitCode,
  ).toBe(1);
});

it("rejects a requested data root outside the workspace test area before running any command", () => {
  const { root, production } = fixture();
  const runCommand = vi.fn();
  expect(() =>
    runLocalChecks({
      workspaceRoot: root,
      pnpmCli: "fixture",
      checkRoot: production,
      runCommand,
    }),
  ).toThrow(".test-data");
  expect(runCommand).not.toHaveBeenCalled();
  expect(readdirSync(production)).toEqual(["sentinel"]);
});

it.each(["format:check", "check:dependencies", "typecheck"])(
  "propagates a real %s child failure without starting later stages",
  (failedStage) => {
    const { root, production } = fixture();
    const pnpm = join(root, "pnpm.cjs");
    writeFileSync(
      pnpm,
      `const fs=require("node:fs");const path=require("node:path");const stage=process.argv.at(-1);fs.appendFileSync(path.join(process.env.QUANT_DATA_DIR,"stages"),stage+"\\n");process.exit(stage===${JSON.stringify(failedStage)}?23:0);`,
    );
    const checkRoot = join(root, "cli-checks");
    // Windows child environments keep only one case-insensitive spelling. Remove
    // inherited aliases before injecting the stub CLI, including under pnpm run.
    const inherited = { ...process.env };
    for (const key of Object.keys(inherited)) {
      if (
        ["NPM_EXECPATH", "QUANT_CHECK_ROOT", "QUANT_CHECK_ACTIVE"].includes(
          key.toUpperCase(),
        )
      )
        delete inherited[key];
    }
    const env = {
      ...inherited,
      npm_execpath: pnpm,
      QUANT_CHECK_ROOT: checkRoot,
    };
    const probe = spawnSync(
      process.execPath,
      ["-p", "process.env.npm_execpath"],
      { env, encoding: "utf8", windowsHide: true, timeout: 5000 },
    );
    expect(probe.stdout.trim()).toBe(pnpm);
    const run = spawnSync(process.execPath, [resolve("scripts/check.mjs")], {
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    });
    expect(run.status, run.stderr).toBe(23);
    const output = join(checkRoot, readdirSync(checkRoot)[0]!);
    expect(readFileSync(join(output, "stages"), "utf8")).toBe(
      failedStage === "format:check"
        ? "format:check\n"
        : failedStage === "check:dependencies"
          ? "format:check\ncheck:dependencies\n"
          : "format:check\ncheck:dependencies\nruntime:build\ntypecheck\n",
    );
    expect(existsSync(join(production, "stages"))).toBe(false);
  },
);

it("refuses recursive check entry before starting another pipeline", () => {
  const { root } = fixture();
  const checkRoot = join(root, "nested-check");
  const run = spawnSync(process.execPath, [resolve("scripts/check.mjs")], {
    env: {
      ...process.env,
      QUANT_CHECK_ACTIVE: "1",
      QUANT_CHECK_ROOT: checkRoot,
    },
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
  });
  expect(run.status).toBe(1);
  expect(run.stderr).toContain("nested check commands are refused");
  expect(existsSync(checkRoot)).toBe(false);
});
