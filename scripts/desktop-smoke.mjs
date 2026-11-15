import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { temporaryDirectory } from "./temporary-directory.mjs";
import { join } from "node:path";
import { createRequire } from "node:module";
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
const child = temporary.track(
  spawn(binary, args, {
    windowsHide: true,
    stdio: "pipe",
    env: { ...process.env, QUANT_DESKTOP_SMOKE: "1", QUANT_DATA_DIR: data },
  }),
);
const timer = setTimeout(() => {
  child.kill();
  console.error("Desktop smoke timed out");
  process.exitCode = 1;
}, 60000);
child.stderr.on("data", () => {});
const code = await new Promise((resolve, reject) => {
  child.on("error", reject);
  child.on("exit", resolve);
});
clearTimeout(timer);
const text = await readFile(join(data, "smoke.txt"), "utf8").catch(() => ""),
  sourceUnchanged = source.equals(await readFile(sourcePath)),
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
  passed =
    code === 0 &&
    sourceUnchanged &&
    smokeOutputPresent &&
    missingLabels.length === 0 &&
    presentErrors.length === 0;
console.log(
  JSON.stringify({
    desktopSmoke: passed,
    exitCode: code,
    smokeOutputPresent,
    missingLabels,
    presentErrors,
    expectedRecords,
    expectedDate,
    sourceUnchanged,
    dataDirectory: data,
    // The profile is removed on exit; keep the captured page text for diagnosis.
    ...(passed ? {} : { capturedText: text.slice(0, 1500) }),
  }),
);
if (!passed) process.exitCode = 1;
