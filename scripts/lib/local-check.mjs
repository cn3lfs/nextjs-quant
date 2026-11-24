import { lstatSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
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
 * @typedef {{ok: true, detail?: string} | {ok: false, error: string}} CleanupResult
 */

/**
 * @param {string} command
 * @param {string[]} args
 * @returns {Promise<CleanupResult>}
 */
function runCleanupCommand(command, args) {
  return new Promise((resolveResult) => {
    execFile(
      command,
      args,
      { windowsHide: true, timeout: 5_000 },
      (error, stdout, stderr) => {
        if (!error) {
          resolveResult({ ok: true });
          return;
        }
        const detail =
          stderr.trim() ||
          stdout.trim() ||
          (error.killed ? "timed out" : String(error.code ?? error.signal));
        resolveResult({ ok: false, error: `${command}: ${detail}` });
      },
    );
  });
}

function loadWindowsJobs() {
  /** @type {typeof import("koffi").default} */
  const koffi = createRequire(import.meta.url)("koffi");
  const kernel = koffi.load("kernel32.dll");
  const create = kernel.func(
    "void * __stdcall CreateJobObjectW(void *, str16)",
  );
  const setLimits = kernel.func(
    "int __stdcall SetInformationJobObject(void *, int, void *, uint32)",
  );
  const open = kernel.func("void * __stdcall OpenProcess(uint32, int, uint32)");
  const assign = kernel.func(
    "int __stdcall AssignProcessToJobObject(void *, void *)",
  );
  const terminate = kernel.func(
    "int __stdcall TerminateJobObject(void *, uint32)",
  );
  const close = kernel.func("int __stdcall CloseHandle(void *)");
  const wait = kernel.func(
    "uint32 __stdcall WaitForSingleObject(void *, uint32)",
  );
  const lastError = kernel.func("uint32 __stdcall GetLastError()");

  const basicLimits = koffi.struct({
    PerProcessUserTimeLimit: "int64_t",
    PerJobUserTimeLimit: "int64_t",
    LimitFlags: "uint32_t",
    MinimumWorkingSetSize: "size_t",
    MaximumWorkingSetSize: "size_t",
    ActiveProcessLimit: "uint32_t",
    Affinity: "uintptr_t",
    PriorityClass: "uint32_t",
    SchedulingClass: "uint32_t",
  });
  const extendedLimits = koffi.struct({
    BasicLimitInformation: basicLimits,
    IoInfo: koffi.array("uint64_t", 6),
    ProcessMemoryLimit: "size_t",
    JobMemoryLimit: "size_t",
    PeakProcessMemoryUsed: "size_t",
    PeakJobMemoryUsed: "size_t",
  });
  const limits = Buffer.alloc(koffi.sizeof(extendedLimits));
  // KILL_ON_JOB_CLOSE only. Node's detached children do not request breakaway.
  limits.writeUInt32LE(0x00002000, koffi.offsetof(basicLimits, "LimitFlags"));
  const jobObjectExtendedLimitInformation = 9;

  /** @param {number} pid */
  return function assignWindowsJob(pid) {
    const job = create(null, null);
    let jobAssigned = false;
    /** @type {string} */
    let failure;
    try {
      if (!job) {
        failure = `CreateJobObjectW failed (Win32 ${lastError()})`;
      } else if (
        !setLimits(
          job,
          jobObjectExtendedLimitInformation,
          limits,
          limits.length,
        )
      ) {
        failure = `SetInformationJobObject failed (Win32 ${lastError()})`;
      } else {
        const launcher = open(0x0101, 0, pid); // PROCESS_SET_QUOTA | PROCESS_TERMINATE
        if (!launcher) {
          failure = `OpenProcess failed (Win32 ${lastError()})`;
        } else {
          try {
            jobAssigned = assign(job, launcher) !== 0;
            if (!jobAssigned) {
              failure = `AssignProcessToJobObject failed (Win32 ${lastError()})`;
            }
          } finally {
            close(launcher);
          }
        }
      }
    } finally {
      if (job && !jobAssigned) close(job);
    }
    if (jobAssigned) {
      return {
        /** @returns {CleanupResult} */
        killTree() {
          return terminate(job, 1)
            ? { ok: true }
            : {
                ok: false,
                error: `TerminateJobObject failed (Win32 ${lastError()})`,
              };
        },
        close: () => close(job),
      };
    }

    // libuv still owns the original process handle in this spawn turn. Keep
    // that process's PID reserved until the fallback has finished.
    const pinnedLauncher = open(0x00100000, 0, pid); // SYNCHRONIZE
    return {
      /** @returns {Promise<CleanupResult>} */
      async killTree() {
        const WAIT_TIMEOUT = 258;
        if (!pinnedLauncher || wait(pinnedLauncher, 0) !== WAIT_TIMEOUT) {
          return {
            ok: false,
            error: `${failure}; no confirmed live launcher for taskkill`,
          };
        }
        const result = await runCleanupCommand("taskkill", [
          "/pid",
          String(pid),
          "/t",
          "/f",
        ]);
        return result.ok
          ? { ok: true, detail: `${failure}; used taskkill fallback` }
          : { ok: false, error: `${failure}; ${result.error}` };
      },
      close: () => {
        if (pinnedLauncher) close(pinnedLauncher);
      },
    };
  };
}

const assignWindowsJob =
  process.platform === "win32" ? loadWindowsJobs() : undefined;

/**
 * Async so a timeout can terminate the process tree, not just the launcher.
 * @param {string} command
 * @param {string[]} args
 * @param {Pick<CheckSpawnOptions, "cwd" | "env"> & {timeout?: number, captureOutput?: boolean}} options
 * @returns {Promise<CheckSpawnResult & {stdout: string, stderr: string}>}
 */
export function spawnCommand(command, args, options) {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.captureOutput
        ? ["ignore", "pipe", "pipe"]
        : ["ignore", "inherit", "inherit"],
      windowsHide: true,
    });
    let job = child.pid ? assignWindowsJob?.(child.pid) : undefined;
    const closeJob = () => {
      job?.close();
      job = undefined;
    };
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    let settled = false;
    /** @type {Promise<{code: string, message: string}> | undefined} */
    let timeoutCleanup;
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
      closeJob();
      resolveResult({ ...result, stdout, stderr });
    };
    const cleanUpTimeout = async () => {
      /** @type {CleanupResult | undefined} */
      let killResult;
      try {
        killResult = await job?.killTree();
      } catch (error) {
        killResult = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        closeJob();
      }
      let message = `${command} ETIMEDOUT`;
      if (killResult && !killResult.ok)
        message += `; process tree cleanup failed: ${killResult.error}`;
      else if (killResult?.detail) message += `; ${killResult.detail}`;
      // ChildProcess.kill uses libuv's own handle on Windows.
      if (
        !killResult?.ok &&
        child.exitCode === null &&
        child.signalCode === null
      )
        child.kill("SIGKILL");
      // A launcher that survives both attempts must not hang the whole gate.
      fallback = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        finish({
          status: null,
          signal: null,
          pid: child.pid,
          timedOut: true,
          error: {
            code: "ETIMEDOUT",
            message: `${message}; child or output pipes did not close`,
          },
        });
      }, 5000);
      fallback.unref?.();
      return { code: "ETIMEDOUT", message };
    };
    timer = setTimeout(() => {
      timeoutCleanup = cleanUpTimeout();
    }, options.timeout ?? DEFAULT_STEP_TIMEOUT_MS);

    /** @param {CheckSpawnResult} result */
    const finishAfterCleanup = async (result) => {
      const timeoutError = await timeoutCleanup;
      finish({
        ...result,
        ...(timeoutError ? { timedOut: true, error: timeoutError } : {}),
      });
    };
    child.on("error", (error) => {
      // A failed kill can emit an error without closing the captured pipes.
      if (!timeoutCleanup) finish({ status: null, error });
    });
    child.on(options.captureOutput ? "close" : "exit", (status, signal) =>
      finishAfterCleanup({ status, signal, pid: child.pid }),
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
  /** @type {{startedAt: number, finishedAt: number|null, totalElapsedMs: number, dataDirectory: string, stepTimeoutMs: number, exitCode: number, steps: {name:string,exitCode:number,elapsedMs:number,timedOut?:true}[]}} */
  const report = {
    startedAt: Date.now(),
    finishedAt: null,
    totalElapsedMs: 0,
    dataDirectory,
    stepTimeoutMs: timeout,
    exitCode: 0,
    steps: [],
  };
  const steps = [
    "format:check",
    "check:dependencies",
    "runtime:build",
    "typecheck",
    "lint",
    "test",
    ...(includeBuild ? ["build"] : []),
  ];
  // A failed runtime:build stops the gate before these scripts can run.
  const preparedSteps = new Set(["typecheck", "test", "build"]);
  for (const name of steps) {
    const script = preparedSteps.has(name) ? `${name}:prepared` : name;
    console.log(`\n[check] ${name}`);
    const started = Date.now();
    let result;
    try {
      // stdin stays closed: a child that waits on the caller's terminal (watch
      // modes, interactive prompts) would otherwise block the whole gate.
      result = await runCommand(process.execPath, [pnpmCli, "run", script], {
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
        `[check] ${name} timed out after ${timeout}ms; later stages were not started${result.error?.message ? `: ${result.error.message}` : ""}`,
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
  report.totalElapsedMs = report.finishedAt - report.startedAt;
  writeFileSync(
    join(dataDirectory, "check-result.json"),
    JSON.stringify(report, null, 2),
  );
  console.table(
    report.steps.map(({ name, elapsedMs, exitCode, timedOut }) => ({
      Step: name,
      "Elapsed (ms)": elapsedMs,
      Exit: exitCode,
      Timeout: timedOut === true,
    })),
  );
  console.log(`[check] total ${report.totalElapsedMs}ms`);
  console.log(
    `[check] ${report.exitCode === 0 ? "passed" : "failed"}; isolated data: ${dataDirectory}`,
  );
  return report;
}
