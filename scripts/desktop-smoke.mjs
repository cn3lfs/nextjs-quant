import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url),
  data = await mkdtemp(join(tmpdir(), "quant-desktop-"));
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
const child = spawn(binary, process.argv.includes("--packaged") ? [] : ["."], {
  windowsHide: true,
  stdio: "pipe",
  env: { ...process.env, QUANT_DESKTOP_SMOKE: "1", QUANT_DATA_DIR: data },
});
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
  passed =
    code === 0 &&
    sourceUnchanged &&
    text.includes(`通达信本地 · ${expectedDate} · ${expectedRecords} 条记录`) &&
    !text.includes("Forbidden") &&
    !text.includes("Cannot find module");
console.log(
  JSON.stringify({
    desktopSmoke: passed,
    exitCode: code,
    expectedRecords,
    expectedDate,
    sourceUnchanged,
    dataDirectory: data,
  }),
);
if (!passed) process.exitCode = 1;
