import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { symbolSchema } from "~/lib/domain";
import { parseBars, isLocalFund } from "./tdx";

const script = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$requested=[string[]](Get-Content -LiteralPath $env:QUANT_FULL_SYMBOLS -Raw -Encoding UTF8 | ConvertFrom-Json)
$archive=[IO.Compression.ZipFile]::OpenRead($env:QUANT_FULL_ZIP)
try {
  $seen=@{}
  $selected=@{}
  if($archive.Entries.Count -gt 100000){throw 'Too many ZIP members'}
  foreach($entry in $archive.Entries){
    $name=$entry.FullName.Replace('\\','/')
    if($name.StartsWith('/') -or $name.Contains(':') -or @($name.Split('/') | Where-Object {$_ -eq '..' -or $_ -eq '.'}).Count){throw 'Unsafe ZIP member path'}
    if($seen.ContainsKey($name)){throw 'Duplicate ZIP member'}
    $seen[$name]=$true
    if($name -match '^(sh|sz|bj)/lday/((sh|sz|bj)[0-9]{6})\\.day$'){
      $market=$Matches[1];$symbol=$Matches[2]
      if(!$symbol.StartsWith($market)){throw 'ZIP market mismatch'}
      if($requested -contains $symbol){
        if($entry.Length -le 0 -or $entry.Length -gt 2097152 -or $entry.Length % 32){throw 'Invalid daily record size'}
        $selected[$symbol]=$entry
      }
    }
  }
  $total=0L
  foreach($entry in $selected.Values){$total += $entry.Length}
  if($total -gt 268435456){throw 'Selected ZIP data exceeds batch limit'}
  foreach($symbol in $selected.Keys){
    $target=Join-Path $env:QUANT_FULL_OUTPUT ($symbol + '.day')
    [IO.Compression.ZipFileExtensions]::ExtractToFile($selected[$symbol],$target,$false)
  }
} finally {$archive.Dispose()}
`;

/** Extract selected daily histories from a user-supplied full package.
 * Output is temporary; publication belongs to the application cache layer.
 */
export async function inspectFullDayPackage(path: string, symbols: string[]) {
  if (process.platform !== "win32")
    throw new Error("完整日线包导入需要Windows");
  if (
    !symbols.length ||
    symbols.length > 6000 ||
    new Set(symbols).size !== symbols.length
  )
    throw new Error("完整包证券清单必须非空且不重复，最多6000只");
  symbols.forEach((symbol) => symbolSchema.parse(symbol));
  const zip = resolve(path);
  const before = await stat(zip);
  if (!before.isFile() || before.size <= 0 || before.size > 2 * 1024 ** 3)
    throw new Error("完整日线包大小无效或超过2GB");
  const parent = resolve(tmpdir());
  const directory = await mkdtemp(join(parent, "quant-full-day-"));
  try {
    const list = join(directory, "symbols.json");
    await writeFile(list, JSON.stringify(symbols), { flag: "wx" });
    await promisify(execFile)(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        windowsHide: true,
        timeout: 120000,
        maxBuffer: 16384,
        env: {
          ...process.env,
          QUANT_FULL_ZIP: zip,
          QUANT_FULL_SYMBOLS: list,
          QUANT_FULL_OUTPUT: directory,
        },
      },
    );
    const after = await stat(zip);
    if (
      before.size !== after.size ||
      before.ino !== after.ino ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error("完整包在读取期间发生变化");
    const records = [];
    const missing: string[] = [];
    for (const symbol of symbols) {
      let bytes: Buffer;
      try {
        bytes = await readFile(join(directory, `${symbol}.day`));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        missing.push(symbol);
        continue;
      }
      const bars = parseBars(
        bytes,
        "day",
        undefined,
        isLocalFund(symbol) ? 3 : 2,
      );
      if (!bars.length) throw new Error(`${symbol}完整日线为空`);
      records.push({
        symbol,
        bytes,
        bars,
        hash: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    return { source: "tdx-full-package" as const, records, missing };
  } finally {
    if (dirname(directory) !== parent)
      throw new Error("完整包临时目录边界无效");
    await rm(directory, { recursive: true, force: true });
  }
}
