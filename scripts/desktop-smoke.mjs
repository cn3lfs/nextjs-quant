import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  realpath,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { temporaryDirectory } from "./temporary-directory.mjs";
import { basename, dirname, join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import SuperJSON from "superjson";
import {
  readStartupConclusion,
  smokePassed,
} from "./lib/desktop-smoke-result.mjs";
// Unknown arguments fail before the profile, any data source or Electron.
const knownArguments = new Set([
  "--startup-only",
  "--packaged",
  "--diagnose-smoke",
]);
const unknownArguments = process.argv
  .slice(2)
  .filter((argument) => !knownArguments.has(argument));
if (unknownArguments.length > 0) {
  console.error(`未知参数：${unknownArguments.join(" ")}`);
  process.exit(1);
}
const startupOnly = process.argv.includes("--startup-only");
const packaged = process.argv.includes("--packaged");
const diagnoseSmoke = process.argv.includes("--diagnose-smoke");
const require = createRequire(import.meta.url),
  temporary = temporaryDirectory("quant-desktop-"),
  data = temporary.path;
const packagedBinary = () =>
  join(
    process.cwd(),
    process.env.QUANT_DESKTOP_BINARY ?? "release/win-unpacked/GuanlanQuant.exe",
  );

if (diagnoseSmoke) {
  const result = await runDiagnoseSmoke();
  await new Promise((resolve) =>
    process.stdout.write(`${JSON.stringify(result)}\n`, resolve),
  );
  process.exit(result.desktopSmoke ? 0 : 1);
}

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
      env: { ...process.env, QUANT_DATA_DIR: data },
      encoding: "utf8",
      windowsHide: true,
      timeout: 60000,
    },
  );
  return seed.status === 0;
}
const binary = packaged ? packagedBinary() : require("electron");
const args = [
  `--user-data-dir=${join(data, "electron-profile")}`,
  ...(packaged ? [] : ["."]),
];
let child = null;
let launchFailed = false;
try {
  child = temporary.track(
    spawn(binary, args, {
      windowsHide: true,
      stdio: "pipe",
      env: { ...process.env, QUANT_DESKTOP_SMOKE: "1", QUANT_DATA_DIR: data },
    }),
  );
} catch {
  // A synchronous spawn failure must still produce the safe summary.
  launchFailed = true;
}
let timedOut = false;
let timer = null;
let exitCode = null;
if (child) {
  try {
    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      console.error("Desktop smoke timed out");
      process.exitCode = 1;
    }, 60000);
    child.stderr.on("data", () => {});
    // Whichever arrives first settles the launch; a late counterpart is ignored.
    const outcome = await new Promise((resolve) => {
      child.once("error", () => resolve({ type: "error" }));
      child.once("exit", (code) => resolve({ type: "exit", code }));
    });
    if (outcome.type === "exit") exitCode = outcome.code;
    else launchFailed = true;
  } finally {
    if (timer) clearTimeout(timer);
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
  passed = smokePassed({
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
 * in a separate process while this profile still has no database. */
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
 * benchmark and stock share a calendar; the GBBQ header declares zero events. */
async function writeDiagnoseMarket(symbol) {
  const daily = join(data, "tdx", "vipdoc", "sh", "lday");
  const actions = join(data, "tdx", "T0002", "hq_cache");
  await mkdir(daily, { recursive: true });
  await mkdir(actions, { recursive: true });
  const rows = [];
  for (let day = 4; rows.length < 48; day++) {
    const date = new Date(Date.UTC(2024, 2, day));
    if (date.getUTCDay() === 0 || date.getUTCDay() === 6) continue;
    const row = Buffer.alloc(32);
    row.writeUInt32LE(
      Number(date.toISOString().slice(0, 10).replaceAll("-", "")),
      0,
    );
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
}

function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const socket = createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const { port } = socket.address();
      socket.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

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

async function runDiagnoseSmoke() {
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
    gracefulShutdown: false,
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
  let service;
  let closed;
  let processClosed = false;
  let origin;
  const token = randomBytes(32).toString("hex");
  const running = () =>
    !!service?.pid &&
    !processClosed &&
    service.exitCode === null &&
    service.signalCode === null;
  async function rpc(name, input, method = "GET", timeoutMs = 8000) {
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
      signal: AbortSignal.timeout(timeoutMs),
      ...(method === "POST" && { body: data }),
    });
    const body = await response.json();
    if (!response.ok || !body.result?.data)
      throw new Error(`Smoke RPC failed: ${name}`);
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
      result.schemaVersion = db.pragma("user_version", { simple: true });
      if (result.schemaVersion !== 23)
        throw new Error("Unexpected SQLite schema version");
    } finally {
      db.close();
    }
    await mkdir(archive, { recursive: true });
    await writeFile(archiveFile, fixture, { flag: "wx" });
    await writeDiagnoseMarket(symbol);

    stage = "server-health";
    const root = packaged
      ? join(dirname(packagedBinary()), "resources", "server")
      : join(process.cwd(), ".next", "standalone");
    const bundledNode = join(root, "node-runtime", "node.exe");
    const binary =
      packaged || existsSync(bundledNode) ? bundledNode : process.execPath;
    const port = await freeLoopbackPort();
    origin = `http://127.0.0.1:${port}`;
    service = temporary.track(
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
          QUANT_SESSION_TOKEN: token,
          QUANT_WORKER_DIR: join(root, "runtime"),
        },
      }),
    );
    service.on("error", () => {});
    closed = new Promise((resolve) =>
      service.once("close", (code) => {
        processClosed = true;
        resolve({ code });
      }),
    );
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
      summaries[0].id !== id ||
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
      (state) => !["queued", "running"].includes(state?.status),
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
  } catch {
    result.failedAt = stage;
  } finally {
    if (closed && running()) {
      const request = new AbortController();
      void fetch(`${origin}/api/shutdown`, {
        method: "POST",
        headers: { "x-quant-session": token },
        redirect: "error",
        signal: request.signal,
      })
        .then((response) => response.body?.cancel())
        .catch(() => {});
      const exit = await Promise.race([closed, delay(4000)]);
      request.abort();
      result.gracefulShutdown = exit?.code === 0;
      if (running()) {
        if (process.platform === "win32")
          spawnSync("taskkill.exe", ["/PID", String(service.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
            timeout: 10000,
          });
        if (running()) service.kill();
        await Promise.race([closed, delay(4000)]);
      }
    }
    if (!result.gracefulShutdown) result.failedAt ??= "server-shutdown";
    try {
      if (
        running() ||
        relative(
          join(await realpath(tmpdir()), basename(data)),
          await realpath(data),
        ) !== ""
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
    }
  }
  result.desktopSmoke = result.failedAt === null;
  return result;
}
