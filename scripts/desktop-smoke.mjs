import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { temporaryDirectory } from "./temporary-directory.mjs";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  readStartupConclusion,
  smokePassed,
} from "./lib/desktop-smoke-result.mjs";
const require = createRequire(import.meta.url),
  temporary = temporaryDirectory("quant-desktop-"),
  data = temporary.path;
// A fresh smoke profile uses the application's default TDX root and symbol.
// Verify the current source, not a count that becomes stale after a daily download.
const sourcePath = "E:/new_tdx64/vipdoc/sh/lday/sh600519.day";
const source = await readFile(sourcePath);
if (!source.length || source.length % 32 !== 0)
  throw new Error("Smoke source is empty or has incomplete TDX records");
const expectedRecords = source.length / 32;
const rawDate = String(source.readUInt32LE(source.length - 32));
const expectedDate = `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`;
const binary = process.argv.includes("--packaged")
  ? join(
      process.cwd(),
      process.env.QUANT_DESKTOP_BINARY ??
        "release/win-unpacked/GuanlanQuant.exe",
    )
  : require("electron");
const args = [
  `--user-data-dir=${join(data, "electron-profile")}`,
  ...(process.argv.includes("--packaged") ? [] : ["."]),
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
  // A failed second read cannot prove the source is unchanged.
  afterRun = await readFile(sourcePath).catch(() => null),
  sourceUnchanged = afterRun !== null && source.equals(afterRun),
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
  // Startup smoke checks the Today workspace and the six trading-day entries; chart coverage is separate.
  requiredLabels = [
    "今日",
    "今日决策",
    "市场状态",
    "明日计划",
    "扫描与图表",
    "策略实验室",
    "账户与复盘",
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
  passed = smokePassed({
    exitCode,
    launchFailed,
    timedOut,
    sourceUnchanged,
    smokeOutputPresent,
    missingLabels,
    presentErrors,
    startupState: startup.state,
  });
console.log(
  JSON.stringify({
    desktopSmoke: passed,
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
