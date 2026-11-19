import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { temporaryDirectory } from "./temporary-directory.mjs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  readStartupConclusion,
  smokePassed,
} from "./lib/desktop-smoke-result.mjs";
// Unknown arguments fail before the profile, any data source or Electron.
const knownArguments = new Set(["--startup-only", "--packaged"]);
const unknownArguments = process.argv
  .slice(2)
  .filter((argument) => !knownArguments.has(argument));
if (unknownArguments.length > 0) {
  console.error(`未知参数：${unknownArguments.join(" ")}`);
  process.exit(1);
}
const startupOnly = process.argv.includes("--startup-only");
const packaged = process.argv.includes("--packaged");
const require = createRequire(import.meta.url),
  temporary = temporaryDirectory("quant-desktop-"),
  data = temporary.path;
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
if (startupOnly) {
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
  if (seed.status !== 0) {
    // Fixed copy only: no seed stderr, exception text or paths.
    console.error("smoke profile seed 失败");
    process.exit(1);
  }
}
const binary = packaged
  ? join(
      process.cwd(),
      process.env.QUANT_DESKTOP_BINARY ??
        "release/win-unpacked/GuanlanQuant.exe",
    )
  : require("electron");
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
