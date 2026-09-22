import { historicalDateSchema } from "~/lib/historical-screen";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";

const maxBytes = 16 * 1024 * 1024;
const extractScript = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($env:QUANT_INCREMENT_ZIP)
try {
  $expected = @('sh', 'sz', 'bj') | ForEach-Object { "$($_)$($env:QUANT_INCREMENT_DAY).cod"; "$($_)$($env:QUANT_INCREMENT_DAY).md1" }
  $names = @($archive.Entries | ForEach-Object { $_.FullName })
  if ($names.Count -ne 6 -or @($names | Select-Object -Unique).Count -ne 6 -or @(Compare-Object $expected $names).Count -ne 0) { throw 'Unexpected ZIP members' }
  $total = 0L
  foreach ($entry in $archive.Entries) {
    if ($entry.Length -le 0 -or $entry.Length -gt 33554432) { throw 'Invalid ZIP member size' }
    $total += $entry.Length
  }
  if ($total -gt 100663296) { throw 'ZIP payload exceeds limit' }
  foreach ($entry in $archive.Entries) {
    $target = Join-Path $env:QUANT_INCREMENT_DIR $entry.FullName
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
    if ((Get-Item -LiteralPath $target).Length -ne $entry.Length) { throw 'Incomplete ZIP member' }
  }
} finally { $archive.Dispose() }
`;

/** Built-in Windows ZIP implementation; fixed member allowlist, isolated output. */
export async function extractDailyIncrement(bytes: Buffer, date: string) {
  historicalDateSchema.parse(date);
  if (bytes.length > maxBytes) throw new Error("通达信增量包超过16MB上限");
  if (process.platform !== "win32") throw new Error("日线增量解压需要Windows");
  const parent = resolve(tmpdir());
  const directory = await mkdtemp(join(parent, "quant-increment-unzip-"));
  try {
    const zip = join(directory, "package.zip");
    await writeFile(zip, bytes, { flag: "wx" });
    const day = date.replaceAll("-", "").slice(2);
    await promisify(execFile)(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(extractScript, "utf16le").toString("base64"),
      ],
      {
        windowsHide: true,
        timeout: 60000,
        maxBuffer: 16384,
        env: {
          ...process.env,
          QUANT_INCREMENT_ZIP: zip,
          QUANT_INCREMENT_DIR: directory,
          QUANT_INCREMENT_DAY: day,
        },
      },
    );
    const result = [];
    for (const market of ["sh", "sz", "bj"] as const)
      result.push({
        market,
        cod: await readFile(join(directory, `${market}${day}.cod`)),
        md1: await readFile(join(directory, `${market}${day}.md1`)),
      });
    return result;
  } finally {
    if (dirname(resolve(directory)) !== parent)
      throw new Error("增量临时目录边界非法");
    await rm(directory, { recursive: true, force: true });
  }
}
/** A missing daily package is a retryable publication state, never empty success. */
export async function downloadDailyIncrement(
  date: string,
  request: typeof fetch = fetch,
) {
  historicalDateSchema.parse(date);
  const url = `https://www.tdx.com.cn/products/data/data/g4day/${date.replaceAll("-", "")}.zip`;
  const response = await request(url, {
    signal: AbortSignal.timeout(60000),
    redirect: "error",
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return { status: "not-published" as const, date, url };
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`通达信增量下载失败（${response.status}）`);
  }
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw new Error("通达信增量包超过16MB上限");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("通达信增量响应为空");
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("通达信增量包超过16MB上限");
      parts.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = Buffer.concat(parts);
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50)
    throw new Error("通达信增量响应不是ZIP文件");
  return {
    status: "downloaded" as const,
    date,
    url,
    bytes,
    observedAt: Date.now(),
    hash: createHash("sha256").update(bytes).digest("hex"),
  };
}
