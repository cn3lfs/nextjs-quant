import { afterEach, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  runLocalChecks,
  spawnCommand,
} from "../../scripts/lib/local-check.mjs";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});
function fixture() {
  // The real CLI derives workspaceRoot from scripts/check.mjs. Its fixtures
  // must therefore live under the real workspace, regardless of system TEMP.
  const workspaceTests = resolve(".test-data");
  const requested = resolve(process.env.QUANT_DATA_DIR!);
  const rel = relative(workspaceTests, requested);
  const parent =
    rel.startsWith("..") || isAbsolute(rel) ? workspaceTests : requested;
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "check-fixture-"));
  roots.push(root);
  const production = join(root, "production");
  mkdirSync(production);
  writeFileSync(join(production, "sentinel"), "preserve");
  vi.stubEnv("QUANT_DATA_DIR", production);
  return { root, production };
}

it("uses fresh data and temp directories, preserves the caller's data, and includes the requested build", async () => {
  const { root, production } = fixture();
  vi.stubEnv("QUANT_RESEARCH_BAR_STORE_DIR", join(production, "shared-cache"));
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
  const first = await runLocalChecks(options);
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
  expect((await runLocalChecks(options)).dataDirectory).not.toBe(
    first.dataDirectory,
  );
  expect(
    envs.every((env) => env.QUANT_RESEARCH_BAR_STORE_DIR === undefined),
  ).toBe(true);
  expect(existsSync(join(production, "child-write"))).toBe(false);
  expect(readFileSync(join(production, "sentinel"), "utf8")).toBe("preserve");
  expect(process.env.QUANT_DATA_DIR).toBe(production);
});

it("stops on nonzero exit or launch failure and writes a reviewable result", async () => {
  const { root } = fixture();
  const summary = vi.spyOn(console, "table").mockImplementation(() => {});
  let now = 100;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const commands: string[] = [];
  const report = await runLocalChecks({
    workspaceRoot: root,
    pnpmCli: "fixture",
    checkRoot: join(root, ".test-data/checks"),
    runCommand: (_command: string, args: string[]) => {
      const name = args.at(-1)!;
      commands.push(name);
      now += 17;
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
    ),
  ).toEqual(report);
  expect(report.totalElapsedMs).toBe(85);
  expect(report.totalElapsedMs).toBe(report.finishedAt! - report.startedAt);
  expect(summary).toHaveBeenCalledWith([
    ...commands.slice(0, -1).map((name) => ({
      Step: name,
      "Elapsed (ms)": 17,
      Exit: 0,
      Timeout: false,
    })),
    {
      Step: "lint",
      "Elapsed (ms)": 17,
      Exit: 23,
      Timeout: false,
    },
  ]);
  expect(
    (
      await runLocalChecks({
        workspaceRoot: root,
        pnpmCli: "fixture",
        checkRoot: join(root, ".test-data/checks"),
        runCommand: () => {
          throw new Error("Cannot launch");
        },
      })
    ).exitCode,
  ).toBe(1);
});

it("closes child stdin and bounds every stage with a timeout", async () => {
  const { root } = fixture();
  const inputs: { stdio?: unknown; timeout?: number; windowsHide?: boolean }[] =
    [];
  await runLocalChecks({
    workspaceRoot: root,
    pnpmCli: "fixture",
    checkRoot: join(root, ".test-data/checks"),
    stepTimeoutMs: 1234,
    runCommand: (
      _command: string,
      _args: string[],
      input: { stdio?: unknown; timeout?: number; windowsHide?: boolean },
    ) => {
      inputs.push(input);
      return { status: 0 };
    },
  });
  expect(inputs.length).toBe(6);
  for (const input of inputs) {
    expect(input.stdio).toEqual(["ignore", "inherit", "inherit"]);
    expect(input.timeout).toBe(1234);
    expect(input.windowsHide).toBe(true);
  }
});

it("records a timed-out stage and does not start later stages", async () => {
  const { root } = fixture();
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const cleanupError = "TerminateJobObject failed (Win32 5)";
  const commands: string[] = [];
  const report = await runLocalChecks({
    workspaceRoot: root,
    pnpmCli: "fixture",
    checkRoot: join(root, ".test-data/checks"),
    runCommand: (_command: string, args: string[]) => {
      const name = args.at(-1)!;
      commands.push(name);
      return {
        status: null,
        signal: "SIGTERM",
        error: Object.assign(new Error(cleanupError), {
          code: "ETIMEDOUT",
        }),
      };
    },
  });
  expect(commands).toEqual(["format:check"]);
  expect(errors).toHaveBeenCalledWith(expect.stringContaining(cleanupError));
  expect(report.exitCode).toBe(1);
  expect(report.steps).toEqual([
    expect.objectContaining({
      name: "format:check",
      exitCode: 1,
      timedOut: true,
    }),
  ]);
  expect(
    JSON.parse(
      readFileSync(join(report.dataDirectory, "check-result.json"), "utf8"),
    ).steps[0].timedOut,
  ).toBe(true);
});

function persistentDescendant(pidFile: string) {
  return `const fs = require("node:fs");
const marker = ${JSON.stringify(pidFile)};
fs.writeFileSync(marker, String(process.pid));
// A failed assertion still removes the fixture and lets a leaked process exit.
setInterval(() => { if (!fs.existsSync(marker)) process.exit(0); }, 1000);`;
}

async function expectDescendantDead(pidFile: string) {
  const marker = readFileSync(pidFile, "utf8");
  expect(marker).toMatch(/^[1-9]\d*$/);
  const pid = Number(marker);
  expect(Number.isSafeInteger(pid)).toBe(true);
  await expect
    .poll(
      () => {
        try {
          process.kill(pid, 0);
          return "running";
        } catch (error) {
          return (error as NodeJS.ErrnoException).code;
        }
      },
      { timeout: 500, interval: 20 },
    )
    .toBe("ESRCH");
}

it.skipIf(process.platform !== "win32")(
  "terminates the launcher's process tree when a stage times out",
  async () => {
    const { root } = fixture();
    const pnpm = join(root, "hanging-pnpm.cjs");
    const pidFile = join(root, "grandchild.pid");
    writeFileSync(
      pnpm,
      `const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", ${JSON.stringify(persistentDescendant(pidFile))}], { stdio: "ignore" });
setInterval(() => {}, 1000);`,
    );
    const report = await runLocalChecks({
      workspaceRoot: root,
      pnpmCli: pnpm,
      checkRoot: join(root, ".test-data/checks"),
      stepTimeoutMs: 1500,
    });
    expect(report.steps[0]).toMatchObject({ timedOut: true, exitCode: 1 });
    await expectDescendantDead(pidFile);
  },
  15000,
);

it.skipIf(process.platform !== "win32")(
  "terminates a detached grandchild holding the pipes after both ancestors exit",
  async () => {
    const { root } = fixture();
    const pidFile = join(root, "orphan.pid");
    const spawnAndExit = (code: string) =>
      `const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", ${JSON.stringify(code)}], {
  detached: true,
  stdio: ["ignore", "inherit", "inherit"],
});
process.exit(0);`;
    const middle = spawnAndExit(persistentDescendant(pidFile));
    const launcher = spawnAndExit(middle);

    const result = await spawnCommand(process.execPath, ["-e", launcher], {
      env: process.env,
      captureOutput: true,
      timeout: 1500,
    });

    expect(result).toMatchObject({
      status: 0,
      timedOut: true,
      error: { code: "ETIMEDOUT", message: `${process.execPath} ETIMEDOUT` },
    });
    await expectDescendantDead(pidFile);
  },
  15000,
);

it.skipIf(process.platform !== "win32")(
  "closes the job and terminates a detached descendant after a successful exit",
  async () => {
    const { root } = fixture();
    const pidFile = join(root, "descendant.pid");
    const launcher = `const { spawn } = require("node:child_process");
const { statSync } = require("node:fs");
spawn(process.execPath, ["-e", ${JSON.stringify(persistentDescendant(pidFile))}], {
  detached: true,
  stdio: "ignore",
});
setInterval(() => {
  if (statSync(${JSON.stringify(pidFile)}, { throwIfNoEntry: false })?.size) process.exit(0);
}, 20);`;

    const result = await spawnCommand(process.execPath, ["-e", launcher], {
      env: process.env,
      timeout: 5000,
    });

    expect(result.status).toBe(0);
    expect(result.timedOut).toBeUndefined();
    await expectDescendantDead(pidFile);
  },
  15000,
);

it("rejects an invalid stage timeout before running any command", async () => {
  const { root } = fixture();
  const runCommand = vi.fn();
  await expect(
    runLocalChecks({
      workspaceRoot: root,
      pnpmCli: "fixture",
      checkRoot: join(root, ".test-data/checks"),
      stepTimeoutMs: "zero",
      runCommand,
    }),
  ).rejects.toThrow("stepTimeoutMs");
  expect(runCommand).not.toHaveBeenCalled();
});

it("rejects a requested data root outside the workspace test area before running any command", async () => {
  const { root, production } = fixture();
  const runCommand = vi.fn();
  await expect(
    runLocalChecks({
      workspaceRoot: root,
      pnpmCli: "fixture",
      checkRoot: production,
      runCommand,
    }),
  ).rejects.toThrow(".test-data");
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
