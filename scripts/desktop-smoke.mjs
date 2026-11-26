import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { temporaryDirectory } from "./temporary-directory.mjs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import SuperJSON from "superjson";
import {
  candidateSmokePassed,
  diagnoseSmokePassed,
  isThsdkDisabledRejection,
  lifecycleSmokePassed,
  noResidualProcesses,
  readStartupConclusion,
  smokePassed,
} from "./lib/desktop-smoke-result.mjs";

/**
 * @typedef {import('node:child_process').ChildProcess} ChildProcess
 * @typedef {Parameters<typeof noResidualProcesses>[0]} ResidualProcesses
 * @typedef {{failedAt: string | null, residualProcesses: ResidualProcesses}} ShutdownResult
 * @typedef {ShutdownResult & {cleaned: boolean, retainedProfile?: string}} SmokeCleanupResult
 * @typedef {{desktopSmoke: boolean, mode: string, packaged: boolean}} SmokeSummary
 * @typedef {SmokeSummary & SmokeCleanupResult & Parameters<typeof lifecycleSmokePassed>[0]} LifecycleResult
 * @typedef {SmokeSummary & SmokeCleanupResult & Parameters<typeof diagnoseSmokePassed>[0]} DiagnoseResult
 * @typedef {keyof NonNullable<ResidualProcesses>} ProcessKind
 * @typedef {{pid: number, parent: number, since: number, creationTime: string,
 *   kind: ProcessKind, matchesProfile: boolean}} SmokeProcess
 * @typedef {{code: number | null, launchFailed: boolean}} ProcessOutcome
 */

// Unknown arguments fail before the profile, any data source or Electron.
const knownArguments = new Set([
  "--startup-only",
  "--packaged",
  "--diagnose-smoke",
  "--lifecycle-smoke",
  "--candidate-gate",
]);
const startupOnly = process.argv.includes("--startup-only");
const packaged = process.argv.includes("--packaged");
const diagnoseSmoke = process.argv.includes("--diagnose-smoke");
const lifecycleSmoke = process.argv.includes("--lifecycle-smoke");
const candidateGate = process.argv.includes("--candidate-gate");
const require = createRequire(import.meta.url);
const packagedBinary = () =>
  resolve(
    process.cwd(),
    process.env.QUANT_DESKTOP_BINARY ?? "release/win-unpacked/GuanlanQuant.exe",
  );

let data = "";
async function main() {
  const unknownArguments = process.argv
    .slice(2)
    .filter((argument) => !knownArguments.has(argument));
  if (unknownArguments.length > 0) {
    console.error(`未知参数：${unknownArguments.join(" ")}`);
    process.exit(1);
  }
  if (
    [startupOnly, diagnoseSmoke, lifecycleSmoke, candidateGate].filter(Boolean)
      .length > 1
  ) {
    console.error("请只选择一种桌面冒烟模式");
    process.exit(1);
  }
  if (candidateGate && (!packaged || !process.env.QUANT_DESKTOP_BINARY)) {
    console.error("候选包门禁要求 --packaged 和显式 QUANT_DESKTOP_BINARY");
    process.exit(1);
  }
  if (candidateGate) {
    const interrupted = new AbortController();
    const stop = () => interrupted.abort();
    process.once("SIGINT", stop).once("SIGTERM", stop);
    const result = await runCandidateGate(interrupted.signal);
    process.off("SIGINT", stop).off("SIGTERM", stop);
    await new Promise((resolve) =>
      process.stdout.write(`${JSON.stringify(result)}\n`, resolve),
    );
    process.exit(result.desktopSmoke ? 0 : 1);
  }
  if (diagnoseSmoke || lifecycleSmoke) {
    const mode = lifecycleSmoke ? "lifecycle-smoke" : "diagnose-smoke";
    /** @type {SmokeSummary & {failedAt: string | null, retainedProfile?: string}} */
    let result = {
      desktopSmoke: false,
      mode,
      packaged,
      failedAt: "profile-init",
    };
    const interrupted = new AbortController();
    const stop = () => interrupted.abort();
    process.once("SIGINT", stop).once("SIGTERM", stop);
    try {
      if (process.platform !== "win32")
        throw new Error("Desktop process inspection requires Windows");
      const parent = lifecycleSmoke
        ? join(process.cwd(), ".test-data")
        : await realpath(tmpdir());
      if (lifecycleSmoke) {
        await mkdir(parent, { recursive: true });
        if ((await realpath(parent)).toLowerCase() !== parent.toLowerCase())
          throw new Error("Unsafe desktop lifecycle profile root");
      }
      data = await mkdtemp(join(parent, "quant-desktop-"));
      windowsProcesses(data);
      result = await (lifecycleSmoke
        ? runLifecycleSmoke(interrupted.signal)
        : runDiagnoseSmoke(interrupted.signal));
    } catch {
      if (data) result.retainedProfile = data;
    } finally {
      process.off("SIGINT", stop).off("SIGTERM", stop);
    }
    await new Promise((resolve) =>
      process.stdout.write(`${JSON.stringify(result)}\n`, resolve),
    );
    process.exit(result.desktopSmoke ? 0 : 1);
  }

  const temporary = temporaryDirectory("quant-desktop-");
  data = await realpath(temporary.path);
  let sourcePath = null;
  let source = null;
  let expectedRecords = null;
  let expectedDate = null;
  if (!startupOnly) {
    // A fresh smoke profile uses the application's default TDX root and symbol.
    // Verify the current source, not a count that becomes stale after a daily download.
    sourcePath = "E:/new_tdx64/vipdoc/sh/lday/sh600519.day";
    source = await readFile(sourcePath);
    if (!source.length || source.length % 32 !== 0)
      throw new Error("Smoke source is empty or has incomplete TDX records");
    expectedRecords = source.length / 32;
    const rawDate = String(source.readUInt32LE(source.length - 32));
    expectedDate = `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`;
  }
  if (startupOnly && !seedSmokeProfile()) {
    // Fixed copy only: no seed stderr, exception text or paths.
    console.error("smoke profile seed 失败");
    process.exit(1);
  }

  const binary = packaged ? packagedBinary() : require("electron");
  const args = [
    `--user-data-dir=${join(data, "electron-profile")}`,
    ...(packaged ? [] : ["."]),
  ];
  /** @type {ReturnType<typeof observeSmokeProcess> | undefined} */
  let observed;
  let launchFailed = false;
  /** @type {ShutdownResult} */
  const shutdown = { failedAt: "process-census", residualProcesses: null };
  try {
    if (process.platform !== "win32")
      throw new Error("Desktop process inspection requires Windows");
    windowsProcesses(data);
    shutdown.failedAt = null;
    observed = observeSmokeProcess(
      () =>
        spawn(binary, args, {
          windowsHide: true,
          stdio: "ignore",
          env: {
            ...process.env,
            QUANT_DESKTOP_SMOKE: "1",
            QUANT_DATA_DIR: data,
          },
        }),
      data,
    );
    temporary.track(observed.child);
    launchFailed = !observed.contained;
  } catch {
    // A synchronous spawn failure must still produce the safe summary.
    launchFailed = true;
  }
  let timedOut = false;
  let exitCode = null;
  if (observed) {
    const wait = new AbortController();
    try {
      const outcome = await Promise.race([
        observed.outcome,
        delay(60000, null, { signal: wait.signal }),
      ]);
      timedOut = outcome === null;
      exitCode = outcome?.code ?? null;
      launchFailed ||= outcome?.launchFailed ?? false;
      if (timedOut) console.error("Desktop smoke timed out");
      await checkSmokeShutdown(shutdown, observed);
    } catch {
      shutdown.failedAt ??= "process-cleanup";
    } finally {
      wait.abort();
      observed.close();
    }
  }
  const text = await readFile(join(data, "smoke.txt"), "utf8").catch(() => ""),
    // The default mode re-reads the real source; startup-only reads none.
    afterRun = sourcePath ? await readFile(sourcePath).catch(() => null) : null,
    sourceUnchanged = startupOnly
      ? null
      : afterRun !== null && source !== null && source.equals(afterRun),
    sourceChecked = !startupOnly,
    // The desktop log and the service share the run's data root, not the Electron profile.
    startup = readStartupConclusion(
      await readFile(join(data, "server.log"), "utf8").catch(() => null),
    ),
    processState = timedOut
      ? "timeout"
      : launchFailed
        ? "launch-error"
        : exitCode === null
          ? "signalled"
          : "exited",
    // Check all seven sidebar workspaces and the rendered Today page.
    requiredLabels = [
      "今日交易",
      "行情看盘",
      "选股筛选",
      "策略回测",
      "持仓复盘",
      "资讯研报",
      "系统设置",
      "今日计划",
      "今日决策",
      "市场状态",
      "明日交易候选",
      "数据与连接",
    ],
    forbiddenLabels = [
      "启动超时",
      "本地服务已停止",
      "Forbidden",
      "Cannot find module",
    ],
    missingLabels = requiredLabels.filter((label) => !text.includes(label)),
    presentErrors = forbiddenLabels.filter((label) => text.includes(label)),
    smokeOutputPresent = text.length > 0,
    mode = startupOnly ? "startup-only" : "default",
    passed = defaultSmokePassed({
      mode,
      sourceChecked,
      sourceUnchanged,
      exitCode,
      launchFailed,
      timedOut,
      smokeOutputPresent,
      missingLabels,
      presentErrors,
      startupState: startup.state,
      ...shutdown,
    });
  console.log(
    JSON.stringify({
      desktopSmoke: passed,
      mode,
      sourceChecked,
      exitCode,
      smokeOutputPresent,
      missingLabels,
      presentErrors,
      expectedRecords,
      expectedDate,
      sourceUnchanged,
      processState,
      ...shutdown,
      startupState: startup.state,
      ...(startup.state === "not-ready"
        ? { startupStatus: startup.startupStatus }
        : {}),
      dataDirectory: data,
      // The profile is removed on exit; keep the captured page text for diagnosis.
      ...(passed ? {} : { capturedText: text.slice(0, 1500) }),
    }),
  );
  if (!passed) process.exitCode = 1;
}

/** @param {Parameters<typeof smokePassed>[0] & ShutdownResult} result */
export function defaultSmokePassed(result) {
  return (
    result.failedAt === null &&
    noResidualProcesses(result.residualProcesses) &&
    smokePassed(result)
  );
}

function seedSmokeProfile() {
  // The seed gets exactly this run's absolute profile. It validates the path
  // and the live runner PID before opening the isolated database.
  const seedPath = fileURLToPath(
    new URL("./desktop-smoke-profile.ts", import.meta.url),
  );
  const seed = spawnSync(
    process.execPath,
    [
      "--import",
      pathToFileURL(require.resolve("tsx")).href,
      seedPath,
      data,
      String(process.pid),
    ],
    {
      env: {
        ...process.env,
        QUANT_DATA_DIR: data,
        // The existing seed checks that its profile is a child of os.tmpdir().
        ...(lifecycleSmoke && { TEMP: dirname(data), TMP: dirname(data) }),
      },
      encoding: "utf8",
      windowsHide: true,
      timeout: 60000,
    },
  );
  return seed.status === 0;
}

/** @param {string} id @param {string} symbol */
function smokeArchive(id, symbol) {
  return {
    summary: {
      id,
      title: "Synthetic desktop diagnosis",
      source: "lab-archive",
      generatedAt: "2024-05-31T00:00:00.000Z",
      strategyKeys: ["dual-ma"],
      symbols: [symbol],
      scenarios: ["strict"],
      statusCounts: { ok: 1, blocked: 0, failed: 0, zeroSignal: 1 },
      missingFiles: [],
      driftWarnings: [],
    },
    cells: [
      {
        strategyKey: "dual-ma",
        symbols: [symbol],
        mode: "per-symbol",
        scenarios: [
          {
            scenarioId: "strict",
            label: "Strict 基线",
            executionProfile: "strict",
            status: "ok",
            counts: {
              bars: 40,
              warmup: 25,
              signals: 0,
              orders: 0,
              fills: 0,
              rejections: 0,
              closedTrades: 0,
            },
            maxParticipation: null,
            capacityPolicy: null,
            capacityActive: false,
            totalFees: null,
            totalReturn: null,
            maxDrawdown: null,
            rejectionReasons: [],
            checks: [],
            findings: [],
            sampleOrders: [],
            sampleFills: [],
            sampleRejections: [],
          },
        ],
      },
    ],
    pagination: { page: 1, pageSize: 1, totalCells: 1 },
    boundaryState: "zero-signal",
  };
}

/** Production startup initializes SQLite. Exercise the real archive readers
 * in a separate process while this profile still has no database.
 * @param {string} id */
function probeArchivesWithoutDatabase(id) {
  const archiveModule = new URL(
    "../src/server/research/diagnose/archive.ts",
    import.meta.url,
  ).href;
  const probe = spawnSync(
    process.execPath,
    [
      "--import",
      pathToFileURL(require.resolve("tsx")).href,
      "--input-type=module",
      "--eval",
      `
        const [moduleUrl, id] = process.argv.slice(1);
        const { listDiagnoseArchives, readDiagnoseArchive } = await import(moduleUrl);
        const { existsSync } = await import("node:fs");
        const { join } = await import("node:path");
        const db = join(process.env.QUANT_DATA_DIR, "quant.sqlite");
        if (existsSync(db)) process.exit(1);
        const summaries = await listDiagnoseArchives({ source: "lab-archive" });
        if (existsSync(db) || summaries.length !== 1 || summaries[0].id !== id) process.exit(1);
        const detail = await readDiagnoseArchive(id);
        if (existsSync(db) || detail?.boundaryState !== "zero-signal" || detail.cells.length !== 1) process.exit(1);
      `,
      archiveModule,
      id,
    ],
    {
      env: { ...process.env, QUANT_DATA_DIR: data },
      stdio: "ignore",
      windowsHide: true,
      timeout: 25000,
    },
  );
  return probe.status === 0;
}

/** Constant synthetic closes cannot cross the dual moving averages. The
 * benchmark and stock share a calendar; the GBBQ header declares zero events.
 * @param {string} symbol */
async function writeDiagnoseMarket(symbol) {
  const daily = join(data, "tdx", "vipdoc", "sh", "lday");
  const actions = join(data, "tdx", "T0002", "hq_cache");
  await mkdir(daily, { recursive: true });
  await mkdir(actions, { recursive: true });
  const rows = [];
  const dates = [];
  for (let day = 1; rows.length < 160; day++) {
    const date = new Date(Date.UTC(2023, 9, day));
    if (date.getUTCDay() === 0 || date.getUTCDay() === 6) continue;
    const row = Buffer.alloc(32);
    const iso = date.toISOString().slice(0, 10);
    dates.push(iso);
    row.writeUInt32LE(Number(iso.replaceAll("-", "")), 0);
    for (const offset of [4, 8, 12, 16]) row.writeUInt32LE(1000, offset);
    row.writeFloatLE(1_000_000, 20);
    row.writeUInt32LE(100_000, 24);
    rows.push(row);
  }
  const bars = Buffer.concat(rows);
  await Promise.all([
    writeFile(join(daily, `${symbol}.day`), bars, { flag: "wx" }),
    writeFile(join(daily, "sh000001.day"), bars, { flag: "wx" }),
    writeFile(join(actions, "gbbq"), Buffer.alloc(4), { flag: "wx" }),
  ]);
  // The native strategy requires 140 warmup bars and two execution days.
  return { start: dates[140], end: dates[141] };
}

/** @returns {Promise<number>} */
function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const socket = createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      socket.close((error) => {
        if (error) reject(error);
        else if (!address || typeof address === "string")
          reject(new Error("Smoke loopback port unavailable"));
        else resolve(address.port);
      });
    });
  });
}

/**
 * @template T
 * @param {(timeoutMs: number) => Promise<T>} read
 * @param {(value: T) => boolean} done
 * @param {() => boolean} running
 * @param {number} timeoutMs
 */
async function pollSmoke(read, done, running, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (running() && Date.now() < deadline) {
    const value = await read(
      Math.min(2000, Math.max(1, deadline - Date.now())),
    );
    if (done(value)) return value;
    await delay(150);
  }
  throw new Error("Smoke polling ended before the expected state");
}

/** @param {string} dataDirectory @param {number} [pid] @returns {SmokeProcess[]} */
export function windowsProcesses(dataDirectory, pid) {
  const query = String.raw`
    $ErrorActionPreference = 'Stop'
    $root = [regex]::Escape($env:QUANT_SMOKE_CENSUS_ROOT.Replace('/', '\'))
    $profilePattern = '^(?:[^\s=]+=)?' + $root + '(?:\\|$)'
    $processes = @(Get-CimInstance Win32_Process ${pid === undefined ? "" : `-Filter 'ProcessId = ${pid}'`} | ForEach-Object {
      $kind = switch -Regex ($_.CommandLine) {
        'czsc-worker\.cjs' { 'czscWorker'; break }
        'thsdk-worker\.cjs' { 'thsdkWorker'; break }
        '[\\/]worker\.cjs' { 'worker'; break }
        '[\\/]server\.js' { 'backend'; break }
        default { 'other' }
      }
      if ($_.CreationDate) {
        $matchesProfile = $false
        if ($_.CommandLine) {
          foreach ($argument in [regex]::Matches($_.CommandLine, '(?:"(?:\\.|[^"\\])*"|[^\s"])+')) {
            if ($argument.Value.Replace('"', '').Replace('/', '\') -match $profilePattern) {
              $matchesProfile = $true
              break
            }
          }
        }
        [pscustomobject]@{
          pid = $_.ProcessId
          parent = $_.ParentProcessId
          since = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()
          creationTime = $_.CreationDate.ToUniversalTime().Ticks.ToString()
          kind = $kind
          matchesProfile = $matchesProfile
        }
      }
    })
    ConvertTo-Json -InputObject $processes -Compress
  `;
  const scan = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", query],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
      env: { ...process.env, QUANT_SMOKE_CENSUS_ROOT: dataDirectory },
    },
  );
  if (scan.status !== 0) throw new Error("Desktop process census failed");
  /** @type {SmokeProcess[]} */
  const processes = JSON.parse(scan.stdout);
  if (
    !Array.isArray(processes) ||
    (pid === undefined && !processes.some(({ pid }) => pid === process.pid))
  )
    throw new Error("Desktop process census incomplete");
  return processes;
}

/** @param {SmokeProcess} candidate @param {string} dataDirectory */
export function terminateSmokeProcess(candidate, dataDirectory) {
  if (!candidate.matchesProfile || candidate.pid === process.pid) return false;
  const kernel = require("koffi").load("kernel32.dll");
  const open = kernel.func("void * __stdcall OpenProcess(uint32, int, uint32)");
  const terminate = kernel.func(
    "int __stdcall TerminateProcess(void *, uint32)",
  );
  const close = kernel.func("int __stdcall CloseHandle(void *)");
  // Hold the process object across the fresh census and termination. Windows
  // cannot recycle its PID while this handle is open.
  const handle = open(0x0001, 0, candidate.pid); // PROCESS_TERMINATE
  if (!handle) return false;
  try {
    const [live] = windowsProcesses(dataDirectory, candidate.pid);
    if (
      live?.pid !== candidate.pid ||
      live.creationTime !== candidate.creationTime ||
      !live.matchesProfile
    )
      return false;
    return terminate(handle, 1) !== 0;
  } finally {
    close(handle);
  }
}

export function createSmokeJob() {
  const koffi = require("koffi");
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
  const query = kernel.func(
    "int __stdcall QueryInformationJobObject(void *, int, void *, uint32, void *)",
  );
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
  const accounting = koffi.struct({
    Times: koffi.array("int64_t", 4),
    TotalPageFaultCount: "uint32_t",
    TotalProcesses: "uint32_t",
    ActiveProcesses: "uint32_t",
    TotalTerminatedProcesses: "uint32_t",
  });
  const limits = Buffer.alloc(koffi.sizeof(extendedLimits));
  const counts = Buffer.alloc(koffi.sizeof(accounting));
  const pointerBytes = koffi.sizeof("uintptr_t");
  limits.writeUInt32LE(0x00002000, koffi.offsetof(basicLimits, "LimitFlags")); // KILL_ON_JOB_CLOSE
  let job = create(null, null);
  if (!job) throw new Error("Cannot create desktop smoke job");
  if (!setLimits(job, 9, limits, limits.length)) {
    // JobObjectExtendedLimitInformation
    close(job);
    throw new Error("Cannot configure desktop smoke job");
  }
  return {
    /** @param {ChildProcess} child */
    attach(child) {
      // Call in the spawn turn while libuv still holds the original process handle.
      if (!child.pid) return false;
      const launcher = open(0x0101, 0, child.pid); // PROCESS_SET_QUOTA | PROCESS_TERMINATE
      if (!launcher) return false;
      try {
        return assign(job, launcher) !== 0;
      } finally {
        close(launcher);
      }
    },
    terminate() {
      if (!terminate(job, 1))
        throw new Error("Cannot terminate desktop smoke job");
    },
    activeProcesses() {
      // JobObjectBasicAccountingInformation also sees descendants of exited roots.
      if (!query(job, 1, counts, counts.length, null))
        throw new Error("Cannot query desktop smoke job");
      return counts.readUInt32LE(koffi.offsetof(accounting, "ActiveProcesses"));
    },
    processIds() {
      const active = this.activeProcesses();
      if (active === 0) return [];
      let capacity = active + 8;
      for (let attempt = 0; attempt < 3; attempt++) {
        const ids = Buffer.alloc(8 + capacity * pointerBytes);
        // JobObjectBasicProcessIdList starts with assigned and returned counts.
        if (query(job, 3, ids, ids.length, null)) {
          return Array.from({ length: ids.readUInt32LE(4) }, (_, index) => {
            const offset = 8 + index * pointerBytes;
            return pointerBytes === 8
              ? Number(ids.readBigUInt64LE(offset))
              : ids.readUInt32LE(offset);
          });
        }
        capacity = Math.max(capacity * 2, ids.readUInt32LE(0));
      }
      throw new Error("Cannot list desktop smoke job processes");
    },
    close() {
      if (job) close(job);
      job = null;
    },
  };
}

async function readLifecycleBackendPids() {
  const trace = await readFile(
    join(data, "lifecycle-backends.txt"),
    "utf8",
  ).catch((error) => {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
    return "";
  });
  return trace
    .split("\n")
    .filter((line) => /^[1-9]\d*$/.test(line))
    .map(Number);
}

/**
 * @param {() => ChildProcess} launch
 * @param {string} dataDirectory
 * @param {() => Promise<number[]>} [readBackendPids]
 */
export function observeSmokeProcess(launch, dataDirectory, readBackendPids) {
  const job = createSmokeJob();
  const startedAt = Date.now();
  /** @type {ChildProcess} */
  let child;
  try {
    child = launch();
  } catch (error) {
    job.close();
    throw error;
  }
  let running = !!child.pid;
  const contained = job.attach(child);
  /** @type {Promise<ProcessOutcome>} */
  const outcome = new Promise((done) => {
    child.once("error", () => {
      running = false;
      done({ code: null, launchFailed: true });
    });
    child.once("exit", (code) => {
      running = false;
      done({ code, launchFailed: false });
    });
  });
  if (running && !contained) child.kill();
  /** @type {Map<number, string>} */
  const known = new Map();

  async function inspect() {
    const backendPids = readBackendPids ? await readBackendPids() : [];
    // Windows retains the parent PID after exit. Track the recorded backends
    // as roots as well, so a worker can still be found after a restart.
    const anchors = new Set([child.pid, ...backendPids]);
    const all = new Map(
      windowsProcesses(dataDirectory).map((entry) => [entry.pid, entry]),
    );
    /** @param {SmokeProcess | undefined} entry */
    function owned(entry) {
      if (entry?.pid === process.pid) return false;
      const seen = new Set();
      while (entry && !seen.has(entry.pid)) {
        if (entry.matchesProfile) return true;
        if (entry.since < startedAt) return false;
        const previous = known.get(entry.pid);
        if (previous !== undefined) return previous === entry.creationTime;
        if (entry.pid === child.pid)
          return running && entry.parent === process.pid;
        if (anchors.has(entry.pid)) return entry.parent === child.pid;
        seen.add(entry.pid);
        const parent = all.get(entry.parent);
        if (!parent) return anchors.has(entry.parent);
        if (parent.since > entry.since) return false;
        entry = parent;
      }
      return false;
    }
    const processes = [...all.values()].filter(owned);
    for (const { pid, creationTime } of processes) known.set(pid, creationTime);
    return processes;
  }

  return {
    child,
    dataDirectory,
    get running() {
      return running;
    },
    outcome,
    inspect,
    contained,
    jobProcessIds: () => job.processIds(),
    kill() {
      if (contained) job.terminate();
      else if (running) child.kill();
    },
    close: job.close,
  };
}

/** @param {SmokeProcess[]} processes @param {number[]} jobPids */
function countResidualProcesses(processes, jobPids) {
  const counts = {
    backend: 0,
    worker: 0,
    czscWorker: 0,
    thsdkWorker: 0,
    other: 0,
  };
  const inspected = new Set(processes.map(({ pid }) => pid));
  for (const { kind } of processes) counts[kind]++;
  counts.other += jobPids.filter((pid) => !inspected.has(pid)).length;
  return counts;
}

/** @param {ShutdownResult} result @param {ReturnType<typeof observeSmokeProcess>} observed */
export async function checkSmokeShutdown(result, observed) {
  if (observed.running) {
    observed.kill();
    await Promise.race([
      observed.outcome,
      delay(4000, undefined, { ref: false }),
    ]);
  }
  const deadline = Date.now() + 5000;
  let processes;
  let jobPids;
  do {
    processes = await observed.inspect();
    jobPids = observed.jobProcessIds();
    if (!processes.length && !jobPids.length && !observed.running) break;
    await delay(150);
  } while (Date.now() < deadline);
  // Report the survivors seen before forced cleanup, even if all are removed.
  result.residualProcesses = countResidualProcesses(processes, jobPids);
  if (!processes.length && !jobPids.length && !observed.running) return;

  result.failedAt ??= "residual-processes";
  observed.kill();
  const contained = new Set(jobPids);
  for (const candidate of processes) {
    if (!contained.has(candidate.pid))
      terminateSmokeProcess(candidate, observed.dataDirectory);
  }
  if (observed.running) {
    await Promise.race([
      observed.outcome,
      delay(4000, undefined, { ref: false }),
    ]);
  }
  if (
    observed.running ||
    (await observed.inspect()).length ||
    observed.jobProcessIds().length
  )
    throw new Error("Desktop smoke process cleanup failed");
}

/** @param {SmokeCleanupResult} result @param {ReturnType<typeof observeSmokeProcess>} [observed] */
async function cleanupSmoke(result, observed) {
  try {
    if (observed) await checkSmokeShutdown(result, observed);
    observed?.close();
    if (
      resolve(await realpath(data)).toLowerCase() !==
      resolve(data).toLowerCase()
    )
      throw new Error("Unsafe smoke profile cleanup");
    await rm(data, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
    result.cleaned = true;
  } catch {
    result.failedAt ??= "profile-cleanup";
    result.retainedProfile = data;
  } finally {
    observed?.close();
  }
}

/** @param {AbortSignal} signal */
async function runLifecycleSmoke(signal) {
  /** @type {LifecycleResult} */
  const result = {
    desktopSmoke: false,
    mode: "lifecycle-smoke",
    packaged,
    exitCode: null,
    timedOut: false,
    launchFailed: false,
    taskRecovered: false,
    residualProcesses: null,
    cleaned: false,
    failedAt: null,
  };
  const jobId = "desktop-lifecycle-interrupted-job";
  let stage = "seed-isolated-profile";
  /** @type {ReturnType<typeof observeSmokeProcess> | undefined} */
  let observed;
  try {
    if (!seedSmokeProfile()) throw new Error("Smoke profile seed failed");
    const Database = require("better-sqlite3");
    /** @param {boolean} readonly */
    const openDatabase = (readonly) =>
      new Database(join(data, "quant.sqlite"), {
        readonly,
        fileMustExist: true,
      });

    stage = "desktop-launch";
    signal.throwIfAborted();
    observed = observeSmokeProcess(
      () =>
        spawn(
          packaged ? packagedBinary() : require("electron"),
          [
            `--user-data-dir=${join(data, "electron-profile")}`,
            "--quant-desktop-lifecycle-smoke",
            ...(packaged ? [] : ["."]),
          ],
          {
            windowsHide: true,
            stdio: "ignore",
            env: {
              ...process.env,
              NEXT_TELEMETRY_DISABLED: "1",
              QUANT_DESKTOP_SMOKE: "",
              QUANT_DESKTOP_LIFECYCLE_SMOKE: "1",
              QUANT_DATA_DIR: data,
              QUANT_RESEARCH_BAR_STORE_DIR: "",
            },
          },
        ),
      data,
      readLifecycleBackendPids,
    );
    if (!observed.contained)
      throw new Error("Desktop smoke job assignment failed");
    const desktop = observed;
    stage = "window-and-tray";
    const backendPid = await pollSmoke(
      () =>
        readFile(join(data, "lifecycle-ready.json"), "utf8")
          .then((text) => JSON.parse(text))
          .catch(() => null),
      (pid) => Number.isSafeInteger(pid) && pid > 0,
      () => desktop.running && !signal.aborted,
      50_000,
    );
    stage = "backend-process-census";
    const initial = await observed.inspect();
    if (
      !initial.some(({ pid, kind }) => pid === backendPid && kind === "backend")
    )
      throw new Error(
        "Desktop smoke backend is missing from the process census",
      );

    stage = "seed-interrupted-task";
    const db = openDatabase(false);
    try {
      const now = Date.now();
      db.prepare(
        "INSERT INTO records(id,kind,payload,updated_at) VALUES(?,'job',?,?)",
      ).run(
        jobId,
        JSON.stringify({
          id: jobId,
          type: "scan",
          status: "running",
          progress: 1,
          input: {},
          ownerPid: backendPid,
          createdAt: now,
          updatedAt: now,
        }),
        now,
      );
    } finally {
      db.close();
    }
    await writeFile(join(data, "lifecycle-crash"), "", { flag: "wx" });

    stage = "crash-restart-and-quit";
    const outcome = await Promise.race([
      observed.outcome,
      delay(105_000, null, { signal, ref: false }),
    ]);
    result.timedOut = outcome === null;
    result.exitCode = outcome?.code ?? null;
    result.launchFailed = outcome?.launchFailed ?? false;
    if (result.exitCode !== 0)
      throw new Error("Desktop lifecycle host did not exit cleanly");
    /** @type {Pick<LifecycleResult, 'windowHidden' | 'trayAlive' | 'windowRestored' | 'unexpectedCleanExit' | 'unexpectedSignalExit' | 'gracefulQuit'>} */
    const checks = JSON.parse(
      await readFile(join(data, "lifecycle-result.json"), "utf8"),
    );
    result.windowHidden = checks.windowHidden;
    result.trayAlive = checks.trayAlive;
    result.windowRestored = checks.windowRestored;
    result.unexpectedCleanExit = checks.unexpectedCleanExit;
    result.unexpectedSignalExit = checks.unexpectedSignalExit;
    result.gracefulQuit = checks.gracefulQuit;
    const backendPids = await readLifecycleBackendPids();
    if (
      backendPids.length !== 3 ||
      new Set(backendPids).size !== 3 ||
      backendPids[0] !== backendPid
    )
      throw new Error("Desktop lifecycle backend trace is incomplete");

    stage = "startup-task-recovery";
    const readOnlyDb = openDatabase(true);
    try {
      const payload = readOnlyDb
        .prepare("SELECT payload FROM records WHERE id=? AND kind='job'")
        .pluck()
        .get(jobId);
      if (typeof payload !== "string")
        throw new Error("Missing lifecycle job payload");
      const job = JSON.parse(payload);
      result.taskRecovered =
        job.status === "failed" &&
        job.ownerPid === backendPid &&
        job.error === "应用重启中断了任务，可重新运行";
    } finally {
      readOnlyDb.close();
    }
  } catch {
    result.failedAt = stage;
    if (observed && !observed.running) {
      const outcome = await observed.outcome;
      result.launchFailed = outcome.launchFailed;
      result.exitCode = outcome.code;
    } else if (stage === "desktop-launch" && !signal.aborted) {
      result.launchFailed = true;
    } else if (stage === "window-and-tray" && !signal.aborted) {
      result.timedOut = true;
    }
  } finally {
    await cleanupSmoke(result, observed);
  }
  result.desktopSmoke =
    result.failedAt === null && lifecycleSmokePassed(result);
  if (!result.desktopSmoke) result.failedAt ??= "lifecycle-checks";
  return result;
}

/** @typedef {import('@trpc/server').inferRouterOutputs<import('../src/server/api/root').AppRouter>} SmokeRpcOutputs */

/** @param {AbortSignal} signal */
async function runDiagnoseSmoke(signal) {
  /** @type {DiagnoseResult} */
  const result = {
    desktopSmoke: false,
    mode: "diagnose-smoke",
    packaged,
    readOnlyWithoutDatabase: false,
    healthReady: false,
    archiveRead: false,
    jobStatus: null,
    boundaryState: null,
    schemaVersion: null,
    czsc: null,
    thsdk: null,
    gracefulShutdown: false,
    residualProcesses: null,
    cleaned: false,
    failedAt: null,
  };
  const id = "lab-desktop-smoke";
  const symbol = "sh600000";
  const archiveRoot = join(data, "diagnose-archives");
  const archive = join(archiveRoot, id);
  const archiveFile = join(archive, "diagnose-group.json");
  const fixture = JSON.stringify(smokeArchive(id, symbol));
  let stage = "no-database-archive-read";
  /** @type {ReturnType<typeof observeSmokeProcess> | undefined} */
  let observed;
  let origin = "";
  const token = randomBytes(32).toString("hex");
  const running = () => observed?.running === true && !signal.aborted;
  /** @param {string} name @param {unknown} input @param {'GET' | 'POST'} method @param {number} timeoutMs */
  async function rpcResponse(name, input, method, timeoutMs) {
    const url = new URL(`/api/trpc/${name}`, origin);
    const headers = {
      "x-quant-client": "workbench",
      "content-type": "application/json",
      cookie: `quant-session=${token}`,
    };
    const data = JSON.stringify(SuperJSON.serialize(input));
    if (method === "GET") url.searchParams.set("input", data);
    const response = await fetch(url, {
      method,
      headers,
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      ...(method === "POST" && { body: data }),
    });
    return {
      status: response.status,
      ok: response.ok,
      body: await response.json(),
    };
  }
  /**
   * @template {keyof SmokeRpcOutputs} Name
   * @param {Name} name @param {unknown} [input] @param {'GET' | 'POST'} [method] @param {number} [timeoutMs]
   * @returns {Promise<SmokeRpcOutputs[Name]>}
   */
  async function rpc(name, input, method = "GET", timeoutMs = 8000) {
    const { ok, body } = await rpcResponse(name, input, method, timeoutMs);
    if (!ok || !body.result?.data) throw new Error(`Smoke RPC failed: ${name}`);
    return SuperJSON.deserialize(body.result.data);
  }
  try {
    await mkdir(archive, { recursive: true });
    await writeFile(archiveFile, fixture, { flag: "wx" });
    if (!probeArchivesWithoutDatabase(id))
      throw new Error("Read-only archive probe failed");
    result.readOnlyWithoutDatabase = true;

    stage = "seed-isolated-profile";
    // The existing seed validates that its profile is fresh and empty, then
    // claims the scheduler lease for this runner and configures local data.
    await unlink(archiveFile);
    await rmdir(archive);
    await rmdir(archiveRoot);
    if (!seedSmokeProfile()) throw new Error("Smoke profile seed failed");
    const Database = require("better-sqlite3");
    const db = new Database(join(data, "quant.sqlite"), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const schemaVersion = db.pragma("user_version", { simple: true });
      result.schemaVersion =
        typeof schemaVersion === "number" ? schemaVersion : null;
      if (result.schemaVersion !== 26)
        throw new Error("Unexpected SQLite schema version");
    } finally {
      db.close();
    }
    await mkdir(archive, { recursive: true });
    await writeFile(archiveFile, fixture, { flag: "wx" });
    const nativeWindow = await writeDiagnoseMarket(symbol);

    stage = "server-health";
    const root = packaged
      ? join(dirname(packagedBinary()), "resources", "server")
      : join(process.cwd(), ".next", "standalone");
    const bundledNode = join(root, "node-runtime", "node.exe");
    const binary =
      packaged || existsSync(bundledNode) ? bundledNode : process.execPath;
    const port = await freeLoopbackPort();
    origin = `http://127.0.0.1:${port}`;
    signal.throwIfAborted();
    observed = observeSmokeProcess(
      () =>
        spawn(binary, [join(root, "server.js")], {
          cwd: root,
          windowsHide: true,
          stdio: "ignore",
          env: {
            ...process.env,
            NODE_ENV: "production",
            NEXT_TELEMETRY_DISABLED: "1",
            HOSTNAME: "127.0.0.1",
            PORT: String(port),
            QUANT_DATA_DIR: data,
            QUANT_RESEARCH_BAR_STORE_DIR: "",
            QUANT_CZSC_IDLE_TTL_MS: "60000",
            QUANT_SESSION_TOKEN: token,
            QUANT_WORKER_DIR: join(root, "runtime"),
          },
        }),
      data,
    );
    if (!observed.contained)
      throw new Error("Desktop smoke job assignment failed");
    await pollSmoke(
      async (timeoutMs) => {
        try {
          const response = await fetch(`${origin}/api/health`, {
            signal: AbortSignal.timeout(timeoutMs),
            redirect: "error",
          });
          const health = await response.json();
          return (
            response.ok &&
            health.status === "ok" &&
            health.app === "quant-workbench"
          );
        } catch {
          return false;
        }
      },
      Boolean,
      running,
      45000,
    );
    result.healthReady = true;

    stage = "archive-rpc";
    const summaries = await rpc("strategyLabDiagnoseArchives", {
      source: "lab-archive",
    });
    const detail = await rpc("strategyLabDiagnoseArchiveDetail", { id });
    if (
      summaries.length !== 1 ||
      summaries[0]?.id !== id ||
      detail?.summary.id !== id ||
      detail.boundaryState !== "zero-signal"
    )
      throw new Error("Synthetic archive was not returned intact");
    result.archiveRead = true;

    stage = "diagnosis-terminal";
    const job = await rpc(
      "strategyLabDiagnoseRun",
      {
        symbols: [symbol],
        strategyKey: "dual-ma",
        mode: "per-symbol",
        start: "2024-04-15",
        end: "2024-05-02",
        initial: 100_000,
        costScenario: "base",
        scenarios: ["strict"],
        confirmed: true,
      },
      "POST",
    );
    if (typeof job?.id !== "string" || !job.id)
      throw new Error("Missing diagnosis job ID");
    const terminal = await pollSmoke(
      (timeoutMs) =>
        rpc("strategyLabDiagnoseResult", { jobId: job.id }, "GET", timeoutMs),
      (state) => !["queued", "running"].includes(state?.status ?? ""),
      running,
      45000,
    );
    result.jobStatus = terminal?.status ?? null;
    result.boundaryState = terminal?.detail?.boundaryState ?? null;
    const metrics = terminal?.detail?.cells?.[0]?.scenarios?.[0];
    if (
      terminal?.status !== "completed" ||
      terminal.jobId !== job.id ||
      terminal.progress !== 100 ||
      terminal.detail?.summary.id !== `lab-${job.id}` ||
      terminal.detail.boundaryState !== "zero-signal" ||
      terminal.detail.summary.symbols.join(",") !== symbol ||
      metrics?.status !== "ok" ||
      !(metrics.counts.bars > 0) ||
      metrics.counts.signals !== 0 ||
      metrics.counts.fills !== 0
    )
      throw new Error("Unexpected synthetic diagnosis result");

    stage = "czsc-native-proxy";
    // Strategy Center runs this probe in Next's main thread. The frozen job
    // identity comes from projectCzsc's DLL response, through its IPC worker.
    const nativeJob = await rpc(
      "strategyCenterRun",
      {
        strategyId: "research-chan",
        symbol,
        ...nativeWindow,
        initial: 100_000,
      },
      "POST",
    );
    const native = await pollSmoke(
      (timeoutMs) => rpc("job", { id: nativeJob.id }, "GET", timeoutMs),
      (job) => ["completed", "failed", "cancelled"].includes(job?.status ?? ""),
      running,
      45_000,
    );
    const nativeResult =
      /** @type {{frozen?: {native?: {identity?: {apiVersion: number, dllHash: string}}}} | undefined} */ (
        native?.result
      );
    const identity = nativeResult?.frozen?.native?.identity;
    if (native?.status !== "completed" || !identity)
      throw new Error("Native strategy did not return a DLL identity");
    const bundledHash = createHash("sha256")
      .update(await readFile(join(root, "runtime", "czsc", "CZSC64.dll")))
      .digest("hex");
    const workers = await observed.inspect();
    result.czsc = {
      apiVersion: identity.apiVersion,
      dllHash: identity.dllHash,
      bundledHashMatches: identity.dllHash === bundledHash,
      workerObserved: workers.some(({ kind }) => kind === "czscWorker"),
    };

    stage = "thsdk-default-disabled";
    const thsdk = await rpc("thsdkStatus");
    const { status, body } = await rpcResponse(
      "thsdkOrderBooks",
      [symbol],
      "GET",
      8000,
    );
    const error = body?.error?.json;
    const thsdkWorkerPids = new Set(
      [...workers, ...(await observed.inspect())]
        .filter(({ kind }) => kind === "thsdkWorker")
        .map(({ pid }) => pid),
    );
    result.thsdk = {
      enabled: thsdk.enabled,
      state: thsdk.state,
      rejected: isThsdkDisabledRejection({
        status,
        code: error?.data?.code,
        message: error?.message,
      }),
      workerCount: thsdkWorkerPids.size,
      sessionCreated: existsSync(join(data, "runtime-sessions", "thsdk")),
    };
  } catch {
    result.failedAt = stage;
  } finally {
    if (observed?.running) {
      const request = new AbortController();
      const acknowledged = fetch(`${origin}/api/shutdown`, {
        method: "POST",
        headers: { "x-quant-session": token },
        redirect: "error",
        signal: request.signal,
      })
        .then(
          async (response) =>
            response.ok && (await response.json()).status === "shutting-down",
        )
        .catch(() => false);
      const exit = await Promise.race([
        observed.outcome,
        delay(4000, null, { ref: false }),
      ]);
      request.abort();
      result.gracefulShutdown = exit?.code === 0 && (await acknowledged);
    }
    if (!result.gracefulShutdown) result.failedAt ??= "server-shutdown";
    await cleanupSmoke(result, observed);
  }
  result.desktopSmoke = diagnoseSmokePassed(result);
  if (!result.desktopSmoke) result.failedAt ??= "native-probe-checks";
  return result;
}

/** @param {string} path */
async function sha256File(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

/** @param {string} directory @param {number} version */
export async function seedCandidateDatabase(directory, version) {
  const { tsImport } = await import("tsx/esm/api");
  const [{ migrations }, { settingsSchema }, { createDeployment }, pipeline] =
    await Promise.all([
      tsImport("../src/server/db/migrations.ts", import.meta.url),
      tsImport("../src/lib/domain.ts", import.meta.url),
      tsImport("../src/server/db/deployment-repository.ts", import.meta.url),
      tsImport("../src/server/db/pipeline-repository.ts", import.meta.url),
    ]);
  const Database = require("better-sqlite3");
  const db = new Database(join(directory, "quant.sqlite"));
  try {
    db.transaction(() => {
      for (const sql of migrations.slice(0, version)) db.exec(sql);
      const settings = settingsSchema.parse({
        tdxRoot: join(directory, "tdx"),
        marketDataSource: "local",
        clsDbPath: join(directory, "news.sqlite"),
        industryBlocksRoot: join(directory, "blocks"),
        autoNewsAnalysis: false,
        outboundProxy: "",
      });
      const put = db.prepare(
        "INSERT INTO records(id,kind,payload,updated_at) VALUES (?,?,?,1)",
      );
      put.run("settings", "settings", JSON.stringify(settings));
      put.run(
        "scheduler-owner",
        "lease",
        JSON.stringify({ owner: "candidate-smoke", pid: process.pid }),
      );
      // A funded account, trade and settlement survive as related business facts.
      db.exec(`
        INSERT INTO sim_accounts(id,name,market,currency,initial_capital_atoms,created_at,updated_at)
        VALUES ('qa','候选包升级样本','cn-equity','CNY',1000000000,1,1);
        INSERT INTO sim_orders
          (account_id,id,client_request_id,input_hash,symbol,side,quantity_atoms,price_atoms,trade_date,confirmed_at,rules_json)
        VALUES ('qa','order','request','hash','sh600000','buy',1000000,100000,'2026-10-12',2,'{}');
        INSERT INTO sim_fills
          (account_id,id,order_id,symbol,side,quantity_atoms,price_atoms,gross_atoms,commission_atoms,tax_atoms,slippage_atoms,trade_date,executed_at)
        VALUES ('qa','fill','order','sh600000','buy',1000000,100000,10000000,50000,0,0,'2026-10-12',2);
        INSERT INTO sim_cash_flows VALUES ('qa','opening','opening','opening',1000000000,NULL,1,'');
        INSERT INTO sim_cash_flows VALUES ('qa','settlement','request','settlement',-10050000,'fill',2,'');
      `);
      if (version >= 25) {
        const { getOrCreatePipelineRun, insertOrderIntents } = pipeline;
        const deploymentId = "qa-deployment";
        createDeployment(
          {
            id: deploymentId,
            name: "升级样本策略",
            market: "cn-equity",
            strategySpec: { kind: "double-breakout" },
            universeSpec: { kind: "fixed-symbols", symbols: ["sh600000"] },
            regimeGate: { kind: "none" },
            riskPolicy: { maxConsecutiveFailures: 2 },
            venueBinding: { kind: "local_sim", simAccountId: "qa" },
            schedule: { kind: "manual_only" },
            provenance: { sourceKind: "manual" },
          },
          db,
        );
        const { run } = getOrCreatePipelineRun(
          {
            deploymentId,
            decisionDate: "2026-10-12",
            executeDate: "2026-10-12",
            triggerKind: "manual",
          },
          db,
        );
        insertOrderIntents(
          run.id,
          [
            {
              runId: run.id,
              deploymentId,
              venueKind: "local_sim",
              symbol: "sh600000",
              side: "BUY",
              phase: 2,
              quantity: 100,
              referencePrice: 10,
            },
          ],
          db,
        );
      }
      if (version === 27)
        db.exec(
          "CREATE TABLE future_only(marker TEXT); INSERT INTO future_only VALUES ('must survive')",
        );
      db.pragma(`user_version = ${version}`);
    })();
  } finally {
    db.close();
  }
}

/** @param {string} directory @param {number} version */
function candidateDatabaseSnapshot(directory, version) {
  const Database = require("better-sqlite3");
  const db = new Database(join(directory, "quant.sqlite"), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    if (
      db.pragma("user_version", { simple: true }) !== version ||
      db.pragma("integrity_check", { simple: true }) !== "ok" ||
      db.prepare("PRAGMA foreign_key_check").all().length !== 0
    )
      throw new Error("Unexpected candidate database integrity or version");
    const schema =
      /** @type {{ type: string, name: string, sql: string | null }[]} */ (
        db
          .prepare(
            "SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all()
      );
    const rows = new Map(
      schema
        .filter(({ type }) => type === "table")
        .map(({ name }) => [
          name,
          /** @type {unknown[]} */ (
            db
              .prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
              .safeIntegers()
              .all()
          ),
        ]),
    );
    return { schema, rows };
  } finally {
    db.close();
  }
}

/** @typedef {Parameters<typeof candidateSmokePassed>[0] & SmokeSummary & {retainedProfile?: string}} CandidateResult */

/**
 * @template T
 * @param {CandidateResult} result
 * @param {string} directory
 * @param {() => ChildProcess} launch
 * @param {(observed: ReturnType<typeof observeSmokeProcess>) => Promise<T>} probe
 */
async function withCandidateProcess(result, directory, launch, probe) {
  const observed = observeSmokeProcess(launch, directory);
  try {
    if (!observed.contained) throw new Error("Candidate job assignment failed");
    return await probe(observed);
  } finally {
    const shutdown = /** @type {ShutdownResult} */ ({
      failedAt: null,
      residualProcesses: null,
    });
    try {
      await checkSmokeShutdown(shutdown, observed);
    } finally {
      observed.close();
      result.residualProcesses =
        result.residualProcesses === null || shutdown.residualProcesses == null
          ? null
          : result.residualProcesses +
            Object.values(shutdown.residualProcesses).reduce(
              (sum, count) => sum + count,
              0,
            );
    }
    if (shutdown.failedAt !== null)
      throw new Error("Candidate left residual processes");
  }
}

/** @param {import("playwright").Page} page */
async function probeClsWebView(page) {
  return page.evaluate(async () => {
    const allowedUrl = "https://www.cls.cn/";
    const deniedUrls = [
      "http://www.cls.cn/",
      "https://www.cls.cn.example.invalid/",
    ];
    const started = new Set();
    const destroyed = new Set();
    const views = [allowedUrl, ...deniedUrls].map((url) => {
      const view = document.createElement("webview");
      view.addEventListener("destroyed", () => destroyed.add(url));
      view.addEventListener("did-start-navigation", (event) => {
        const nav =
          /** @type {Event & { url?: string, isMainFrame?: boolean }} */ (
            event
          );
        if (nav.isMainFrame && nav.url) started.add(nav.url);
      });
      view.setAttribute("src", url);
      return view;
    });
    try {
      // The browser is launched with outbound DNS disabled. Denied guests are
      // prevented in will-attach-webview and fire `destroyed`, while the
      // allowed guest attempts main-frame navigation to the exact URL.
      const settled = await new Promise((resolve) => {
        const deadline = Date.now() + 5000;
        const poll = () => {
          const ok =
            started.has(allowedUrl) &&
            !destroyed.has(allowedUrl) &&
            deniedUrls.every((url) => destroyed.has(url) && !started.has(url));
          if (ok) resolve(true);
          else if (Date.now() >= deadline) resolve(false);
          else setTimeout(poll, 50);
        };
        document.body.append(...views.slice(1), ...views.slice(0, 1));
        poll();
      });
      return settled;
    } finally {
      for (const view of views) view.remove();
    }
  });
}

/**
 * @param {CandidateResult} result @param {AbortSignal} signal
 * @param {string} directory @param {"startup" | "future" | "cls"} probe
 */
async function runCandidateDesktop(result, signal, directory, probe) {
  const profile = join(directory, "electron-profile");
  const serverLog = join(directory, "server.log");
  const previousLog = existsSync(serverLog)
    ? await readFile(serverLog, "utf8")
    : "";
  const smokeFile = join(directory, "smoke.txt");
  const previousSmoke = existsSync(smokeFile)
    ? await readFile(smokeFile, "utf8")
    : "";
  const readLog = async () =>
    (await readFile(serverLog, "utf8")).slice(previousLog.length);
  const env = {
    ...process.env,
    QUANT_DATA_DIR: directory,
    QUANT_DESKTOP_SMOKE: probe === "cls" ? "0" : "1",
    QUANT_DESKTOP_LIFECYCLE_SMOKE: "0",
    QUANT_RESEARCH_BAR_STORE_DIR: "",
  };
  delete (/** @type {NodeJS.ProcessEnv} */ (env).ELECTRON_RUN_AS_NODE);
  signal.throwIfAborted();
  await withCandidateProcess(
    result,
    directory,
    () =>
      spawn(
        packagedBinary(),
        [
          `--user-data-dir=${profile}`,
          "--no-proxy-server",
          "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
          ...(probe === "cls"
            ? [
                "--remote-debugging-address=127.0.0.1",
                "--remote-debugging-port=0",
              ]
            : []),
        ],
        { windowsHide: true, stdio: "ignore", env },
      ),
    async (observed) => {
      if (probe === "cls") {
        const { chromium } = await import("playwright");
        const port = await pollSmoke(
          async () =>
            Number(
              (
                await readFile(
                  join(profile, "DevToolsActivePort"),
                  "utf8",
                ).catch(() => "")
              ).split(/\r?\n/)[0],
            ),
          (port) => Number.isInteger(port) && port > 0 && port < 65536,
          () => observed.running && !signal.aborted,
          15000,
        );
        const browser = await chromium.connectOverCDP(
          `http://127.0.0.1:${port}`,
          { timeout: 10000 },
        );
        try {
          const context = browser.contexts()[0];
          const page =
            context?.pages()[0] ??
            (await context?.waitForEvent("page", { timeout: 30000 }));
          if (!page) throw new Error("Desktop window unavailable");
          await page.waitForURL((url) => url.hostname === "127.0.0.1", {
            timeout: 45000,
          });
          await pollSmoke(
            async () =>
              readStartupConclusion(await readLog().catch(() => "")).state,
            (state) => state === "ready",
            () => observed.running && !signal.aborted,
            5000,
          );
          if (!(await probeClsWebView(page)))
            throw new Error("CLS WebView policy failed");
          await page.close();
        } finally {
          await browser.close();
        }
      }
      const outcome = await Promise.race([
        observed.outcome,
        delay(60000, null, { signal, ref: false }),
      ]);
      const log = await readLog();
      const startup = readStartupConclusion(log);
      if (probe === "future") {
        if (
          !outcome ||
          !outcome.code ||
          outcome.launchFailed ||
          startup.state !== "not-ready" ||
          (startup.startupStatus !== "exited" &&
            startup.startupStatus !== "timeout") ||
          !log.includes("数据库版本高于此应用版本，请使用较新的应用") ||
          existsSync(smokeFile)
        )
          throw new Error("Future database did not fail closed");
      } else if (
        outcome?.code !== 0 ||
        outcome.launchFailed ||
        startup.state !== "ready" ||
        (probe === "startup" &&
          (await readFile(smokeFile, "utf8")).length <= previousSmoke.length)
      ) {
        throw new Error("Candidate desktop did not start and exit cleanly");
      }
    },
  );
}

/**
 * @param {CandidateResult} result @param {AbortSignal} signal @param {string} root
 * @param {string} path @param {string} sha256 @param {boolean} tampered
 */
async function probeCandidateThsdk(
  result,
  signal,
  root,
  path,
  sha256,
  tampered,
) {
  signal.throwIfAborted();
  await withCandidateProcess(
    result,
    data,
    () =>
      spawn(
        join(root, "node-runtime", "node.exe"),
        [join(root, "runtime", "thsdk-worker.cjs")],
        {
          cwd: root,
          windowsHide: true,
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(([key]) =>
                ["SYSTEMROOT", "TEMP", "TMP", "PATH"].includes(
                  key.toUpperCase(),
                ),
              ),
            ),
            NODE_ENV: "production",
          },
        },
      ),
    async ({ child, outcome }) => {
      const reply = await Promise.race([
        new Promise((resolve, reject) => {
          child.once("message", resolve);
          child.send(
            {
              type: "init",
              id: 1,
              parentPid: process.pid,
              dllPath: path,
              expectedSha256: sha256,
            },
            (error) => {
              if (error) reject(error);
            },
          );
        }),
        outcome.then(() => null),
        delay(15000, null, { signal, ref: false }),
      ]);
      const init =
        /** @type {{id?: number, ok?: boolean, errorCode?: string, abiVersion?: string, methodsCount?: number} | null} */ (
          reply
        );
      const passed =
        init?.id === 1 &&
        (tampered
          ? init.ok === false && init.errorCode === "dll_invalid"
          : init.ok === true &&
            init.abiVersion === "2.0.0" &&
            (init.methodsCount ?? 0) > 0);
      if (child.connected) child.send({ type: "shutdown", id: 2 });
      const exit = await Promise.race([
        outcome,
        delay(8000, null, { signal, ref: false }),
      ]);
      if (!passed || exit?.code !== 0 || exit.launchFailed)
        throw new Error("Unexpected THSDK handshake or shutdown");
    },
  );
}

/** @param {AbortSignal} signal @returns {Promise<CandidateResult>} */
async function runCandidateGate(signal) {
  /** @type {CandidateResult} */
  const result = {
    desktopSmoke: false,
    mode: "candidate-gate",
    packaged,
    gitCommit: null,
    appVersion: null,
    schemaVersion: null,
    czscSha256: null,
    thsdkSha256: null,
    envFileCount: null,
    residualProcesses: null,
    failedAt: "package-identity",
    checks: {
      upgradeV24: false,
      upgradeV25: false,
      rejectV27: false,
      clsWebView: false,
      thsdkLoad: false,
      thsdkRejectBadHash: false,
      diagnose: false,
      cleaned: false,
    },
  };
  try {
    if (process.platform !== "win32") throw new Error("Windows required");
    const binary = packagedBinary();
    const candidate = dirname(binary);
    const root = join(candidate, "resources", "server");
    const asarPath = join(candidate, "resources", "app.asar");
    const asar = require("@electron/asar");
    const hash = spawnSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    });
    if (hash.status !== 0 || !existsSync(binary))
      throw new Error("Candidate identity unavailable");
    result.gitCommit = hash.stdout.trim();
    result.appVersion = JSON.parse(
      asar.extractFile(asarPath, "package.json").toString("utf8"),
    ).version;
    const files = await readdir(candidate, { recursive: true });
    const envName = /(?:^|[\\/])\.env(?:\.|[\\/]|$)/i;
    result.envFileCount = [
      ...files,
      ...asar.listPackage(asarPath, { isPack: false }),
    ].filter((name) => envName.test(name)).length;
    if (result.envFileCount !== 0 || result.appVersion !== "0.4.0")
      throw new Error("Candidate package identity mismatch");
    const thsdk = join(root, "runtime", "thsdk", "hq.dll");
    result.czscSha256 = await sha256File(
      join(root, "runtime", "czsc", "CZSC64.dll"),
    );
    result.thsdkSha256 = await sha256File(thsdk);
    const { tsImport } = await import("tsx/esm/api");
    const { BUNDLED_THSDK_DLL } = await tsImport(
      "../src/server/data-sources/thsdk/thsdk-known-hashes.ts",
      import.meta.url,
    );
    if (
      result.czscSha256 !==
        (await sha256File(resolve("vendor/czsc/CZSC64.dll"))) ||
      result.thsdkSha256 !== BUNDLED_THSDK_DLL.sha256
    )
      throw new Error("Candidate native binaries do not match trusted sources");

    data = await mkdtemp(
      join(await realpath(tmpdir()), "quant-desktop-candidate-"),
    );
    result.residualProcesses = 0;
    for (const version of /** @type {const} */ ([24, 25, 27])) {
      const check =
        version === 24
          ? "upgradeV24"
          : version === 25
            ? "upgradeV25"
            : "rejectV27";
      result.failedAt = check;
      const directory = join(data, String(version));
      await mkdir(directory);
      await seedCandidateDatabase(directory, version);
      const original = candidateDatabaseSnapshot(directory, version);
      await runCandidateDesktop(
        result,
        signal,
        directory,
        version === 27 ? "future" : "startup",
      );
      const upgraded = candidateDatabaseSnapshot(
        directory,
        version === 27 ? 27 : 26,
      );
      for (const [table, rows] of original.rows) {
        const actual = upgraded.rows.get(table);
        if (
          !actual ||
          !rows.every((row) =>
            actual.some((stored) => isDeepStrictEqual(stored, row)),
          )
        )
          throw new Error("Candidate lost prior business rows");
      }
      if (version === 27) {
        if (!isDeepStrictEqual(original, upgraded))
          throw new Error("Future database was altered");
      } else {
        if (version === 25) result.failedAt = "clsWebView";
        await runCandidateDesktop(
          result,
          signal,
          directory,
          version === 25 ? "cls" : "startup",
        );
        if (version === 25) {
          result.checks.clsWebView = true;
          result.failedAt = check;
        }
        if (
          !isDeepStrictEqual(upgraded, candidateDatabaseSnapshot(directory, 26))
        )
          throw new Error("Database reopen was not idempotent");
      }
      result.checks[check] = true;
    }
    result.schemaVersion = 26;
    result.failedAt = "thsdkLoad";
    await probeCandidateThsdk(
      result,
      signal,
      root,
      thsdk,
      result.thsdkSha256,
      false,
    );
    result.checks.thsdkLoad = true;
    result.failedAt = "thsdkRejectBadHash";
    // An appended byte leaves the copy's PE image loadable. Rejection proves
    // the production worker checks the expected digest, even for a valid DLL.
    const tampered = join(data, "hq-tampered.dll");
    await writeFile(
      tampered,
      Buffer.concat([await readFile(thsdk), Buffer.from([1])]),
      { flag: "wx" },
    );
    await probeCandidateThsdk(
      result,
      signal,
      root,
      tampered,
      result.thsdkSha256,
      true,
    );
    result.checks.thsdkRejectBadHash = true;

    result.failedAt = "diagnose";
    const candidateData = data;
    data = await mkdtemp(join(await realpath(tmpdir()), "quant-desktop-"));
    try {
      const diagnose = await runDiagnoseSmoke(signal);
      if (diagnose.retainedProfile)
        result.retainedProfile = diagnose.retainedProfile;
      if (diagnose.residualProcesses == null) result.residualProcesses = null;
      else if (result.residualProcesses !== null)
        result.residualProcesses += Object.values(
          diagnose.residualProcesses,
        ).reduce((sum, count) => sum + count, 0);
      result.checks.diagnose =
        diagnose.desktopSmoke && diagnose.czsc?.dllHash === result.czscSha256;
    } finally {
      data = candidateData;
    }
    if (result.checks.diagnose) result.failedAt = null;
  } catch {
    // Keep output to stage names and receipts. Backend logs may contain paths
    // or operational detail and must never be forwarded to the release summary.
  } finally {
    if (data) {
      const cleanup = /** @type {SmokeCleanupResult} */ ({
        failedAt: null,
        residualProcesses: null,
        cleaned: false,
      });
      await cleanupSmoke(cleanup);
      result.checks.cleaned = cleanup.cleaned && !result.retainedProfile;
      if (cleanup.retainedProfile)
        result.retainedProfile ??= cleanup.retainedProfile;
      if (!result.checks.cleaned) result.failedAt ??= "profile-cleanup";
    }
  }
  result.desktopSmoke = candidateSmokePassed(result);
  return result;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main();
