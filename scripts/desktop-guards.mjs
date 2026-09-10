import { execFileSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

export const prepareAdvice =
  "桌面准备已停止：GuanlanQuant 或 pnpm start / Node 服务可能正在占用目标文件。请退出本仓库的 GuanlanQuant，并在运行 pnpm start 的终端按 Ctrl+C；关闭占用程序后重新运行 pnpm desktop:prepare。现有 release 已保留。";
export const startAdvice =
  "启动已停止：.next/standalone 静态资源与当前 build 不匹配或准备未完成。请先运行 pnpm desktop:prepare，成功后再运行 pnpm start。";

// Query only this checkout; do not stop or kill any process. Exclusive opens
// also detect older servers launched with relative command lines.
export function assertDesktopClosed(
  root,
  run = execFileSync,
  platform = process.platform,
) {
  if (platform !== "win32") return;
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$root = [IO.Path]::GetFullPath($env:QUANT_PREPARE_ROOT)
$standalone = Join-Path $root '.next\\standalone'
$release = Join-Path $root 'release'
$running = Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -eq 'GuanlanQuant.exe' -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($release + '\\', [StringComparison]::OrdinalIgnoreCase)) -or
  ($_.Name -in @('node.exe', 'electron.exe', 'GuanlanQuant.exe') -and (
    ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($standalone + '\\', [StringComparison]::OrdinalIgnoreCase)) -or
    ($_.CommandLine -and $_.CommandLine.Replace('/', '\\').IndexOf($root + '\\', [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.CommandLine -match 'server\\.js|start\\.mjs|electron')
  ))
}
if ($running) {
  $running | ForEach-Object { Write-Output ($_.Name + ' PID ' + $_.ProcessId) }
  exit 2
}
if (Test-Path -LiteralPath $standalone) {
  Get-ChildItem -LiteralPath $standalone -Recurse -File | Where-Object { $_.Extension -in @('.dll', '.exe') } | ForEach-Object {
    try {
      $handle = [IO.File]::Open($_.FullName, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
      $handle.Dispose()
    } catch {
      Write-Output ('无法独占访问文件：' + $_.FullName)
      exit 2
    }
  }
}
`;
  try {
    run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, QUANT_PREPARE_ROOT: resolve(root) },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    const detail = error?.stdout?.toString().trim();
    throw new Error(
      `${prepareAdvice}${detail ? `\n${detail}` : "\n无法确认目标文件未被占用，请检查进程访问权限。"}`,
    );
  }
}

export function preparationError(error) {
  return ["EPERM", "EBUSY", "EACCES"].includes(error?.code)
    ? `${prepareAdvice}\n无法写入：${error.path ?? error.dest ?? "桌面目标文件"}`
    : error instanceof Error
      ? error.message
      : String(error);
}

async function staticInventory(directory) {
  const names = await readdir(directory, { recursive: true });
  const files = await Promise.all(
    names.map(async (name) => {
      const info = await stat(join(directory, name));
      return info.isFile() ? [name.replaceAll("\\", "/"), info.size] : null;
    }),
  );
  return files.filter(Boolean).sort((a, b) => a[0].localeCompare(b[0]));
}

export async function assertStandaloneReady(root) {
  try {
    const next = join(root, ".next");
    const bundled = join(next, "standalone", ".next");
    const [current, standalone, prepared, sourceFiles, bundledFiles] =
      await Promise.all([
        readFile(join(next, "BUILD_ID"), "utf8"),
        readFile(join(bundled, "BUILD_ID"), "utf8"),
        readFile(join(bundled, "desktop-prepared-build-id"), "utf8"),
        staticInventory(join(next, "static")),
        staticInventory(join(bundled, "static")),
      ]);
    if (
      !current.trim() ||
      current !== standalone ||
      current !== prepared ||
      !sourceFiles.length ||
      JSON.stringify(sourceFiles) !== JSON.stringify(bundledFiles)
    ) {
      throw new Error("mismatch");
    }
  } catch {
    throw new Error(startAdvice);
  }
}
