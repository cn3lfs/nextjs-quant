import { lstatSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/** @param {string} workspaceRoot @param {string} directory */
function checkDirectory(workspaceRoot, directory) {
  const owner = join(workspaceRoot, ".test-data");
  const rel = relative(owner, directory);
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new Error(
      "Check data must stay under this workspace's .test-data directory",
    );
  for (let path = directory; ; path = dirname(path)) {
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error(`Linked check directory refused: ${path}`);
    if (dirname(path) === path) break;
  }
}

const DEFAULT_STEP_TIMEOUT_MS = 15 * 60_000;

/**
 * @typedef {import('node:child_process').SpawnSyncOptions & {env: NodeJS.ProcessEnv}} CheckSpawnOptions
 * @typedef {{status: number | null | undefined, signal?: NodeJS.Signals | null,
 * timedOut?: boolean, pid?: number,
 * error?: {code?: string, message?: string}}} CheckSpawnResult
 * @typedef {(command: string, args: string[],
 * options: CheckSpawnOptions & {timeout?: number}) =>
 * CheckSpawnResult | Promise<CheckSpawnResult>} CheckRunCommand
 * @typedef {{workspaceRoot: string, pnpmCli?: string, checkRoot?: string,
 * includeBuild?: boolean, stepTimeoutMs?: number | string,
 * runCommand?: CheckRunCommand}} CheckOptions
 */

/**
 * The launcher may have spawned the real runner; kill its whole tree.
 * @param {number} pid
 * @returns {boolean} whether the tree kill was attempted successfully
 */
function killProcessTree(pid) {
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return result.status === 0;
  }
  try {
    process.kill(pid, "SIGKILL");
    return true;
  } catch {
    // Already exited.
    return false;
  }
}

/**
 * Async so a timeout can terminate the process tree, not just the launcher.
 * @param {string} command
 * @param {string[]} args
 * @param {CheckSpawnOptions & {timeout?: number}} options
 */
function spawnCommand(command, args, options) {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true,
    });
    let settled = false;
    let timedOut = false;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let fallback;
    /** @param {CheckSpawnResult} result */
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(fallback);
      resolveResult(result);
    };
    timer = setTimeout(() => {
      timedOut = true;
      if (typeof child.pid === "number") killProcessTree(child.pid);
      // taskkill may be missing or fail; still try the direct launcher.
      child.kill();
      // A launcher that survives both attempts must not hang the whole gate.
      fallback = setTimeout(
        () =>
          finish({
            status: null,
            signal: null,
            pid: child.pid,
            timedOut: true,
            error: {
              code: "ETIMEDOUT",
              message: `${command} ETIMEDOUT; launcher did not exit`,
            },
          }),
        5000,
      );
      fallback.unref?.();
    }, options.timeout ?? DEFAULT_STEP_TIMEOUT_MS);
    child.on("error", (error) => finish({ status: null, error }));
    child.on("exit", (status, signal) =>
      finish({
        status,
        signal,
        pid: child.pid,
        ...(timedOut
          ? {
              timedOut: true,
              error: {
                code: "ETIMEDOUT",
                message: `${command} ETIMEDOUT`,
              },
            }
          : {}),
      }),
    );
  });
}

/** @param {unknown} value */
function positiveInteger(value) {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isInteger(parsed) && parsed > 0
    ? parsed
    : null;
}

/**
 * A fresh database and temp directory are mandatory, even if the caller has production env settings.
 * @param {CheckOptions} options
 */
export async function runLocalChecks({
  workspaceRoot,
  pnpmCli,
  checkRoot,
  includeBuild = false,
  stepTimeoutMs = DEFAULT_STEP_TIMEOUT_MS,
  runCommand = spawnCommand,
}) {
  workspaceRoot = resolve(workspaceRoot);
  checkRoot = resolve(checkRoot ?? join(workspaceRoot, ".test-data/checks"));
  checkDirectory(workspaceRoot, checkRoot);
  if (!pnpmCli) throw new Error("Run this entry through pnpm check");
  const timeout = positiveInteger(stepTimeoutMs);
  if (timeout === null)
    throw new Error("stepTimeoutMs must be a positive integer");
  mkdirSync(checkRoot, { recursive: true });
  const dataDirectory = mkdtempSync(join(checkRoot, "check-"));
  const temporaryDirectory = join(dataDirectory, "temp");
  mkdirSync(temporaryDirectory);
  const inherited = { ...process.env };
  for (const key of Object.keys(inherited)) {
    if (
      [
        "QUANT_DATA_DIR",
        "TEMP",
        "TMP",
        "TMPDIR",
        "QUANT_CHECK_ACTIVE",
        "QUANT_RESEARCH_BAR_STORE_DIR",
      ].includes(key.toUpperCase())
    )
      delete inherited[key];
  }
  const env = {
    ...inherited,
    QUANT_CHECK_ACTIVE: "1",
    QUANT_DATA_DIR: dataDirectory,
    TEMP: temporaryDirectory,
    TMP: temporaryDirectory,
    TMPDIR: temporaryDirectory,
  };
  /** @type {{startedAt: number, finishedAt: number|null, dataDirectory: string, stepTimeoutMs: number, exitCode: number, steps: {name:string,exitCode:number,elapsedMs:number,timedOut?:true}[]}} */
  const report = {
    startedAt: Date.now(),
    finishedAt: null,
    dataDirectory,
    stepTimeoutMs: timeout,
    exitCode: 0,
    steps: [],
  };
  const commands = [
    "format:check",
    "check:dependencies",
    "runtime:build",
    "typecheck",
    "lint",
    "test",
    ...(includeBuild ? ["build"] : []),
  ];
  for (const name of commands) {
    console.log(`\n[check] ${name}`);
    const started = Date.now();
    let result;
    try {
      // stdin stays closed: a child that waits on the caller's terminal (watch
      // modes, interactive prompts) would otherwise block the whole gate.
      result = await runCommand(process.execPath, [pnpmCli, "run", name], {
        cwd: workspaceRoot,
        env,
        stdio: ["ignore", "inherit", "inherit"],
        windowsHide: true,
        timeout,
      });
    } catch (error) {
      console.error(
        `Could not start ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      result = { status: 1 };
    }
    const timedOut =
      result.timedOut === true || result.error?.code === "ETIMEDOUT";
    if (timedOut)
      console.error(
        `[check] ${name} timed out after ${timeout}ms; later stages were not started`,
      );
    else if (
      typeof result.status !== "number" ||
      !Number.isInteger(result.status) ||
      result.status < 0
    )
      console.error(
        `[check] ${name} did not exit normally${result.signal ? ` (signal ${result.signal})` : ""}${result.error?.message ? `: ${result.error.message}` : ""}`,
      );
    const exitCode =
      !timedOut &&
      typeof result.status === "number" &&
      Number.isInteger(result.status) &&
      result.status >= 0
        ? result.status
        : 1;
    const elapsedMs = Date.now() - started;
    report.steps.push({
      name,
      exitCode,
      elapsedMs,
      ...(timedOut ? { timedOut: true } : {}),
    });
    console.log(
      `[check] ${name} ${exitCode === 0 ? "ok" : "failed"} in ${(elapsedMs / 1000).toFixed(1)}s`,
    );
    if (exitCode !== 0) {
      report.exitCode = exitCode;
      break;
    }
  }
  report.finishedAt = Date.now();
  writeFileSync(
    join(dataDirectory, "check-result.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    `[check] ${report.exitCode === 0 ? "passed" : "failed"}; isolated data: ${dataDirectory}`,
  );
  return report;
}
