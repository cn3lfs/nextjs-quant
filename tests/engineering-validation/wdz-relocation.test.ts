import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve, join, sep } from "node:path";
import { expect, it } from "vitest";

const script = resolve("scripts/relocate-wdz-snapshot.ps1");
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

it.skipIf(process.platform !== "win32")(
  "validates snapshot identity and paths without invoking relocation or deletion",
  () => {
    const taskRoot = resolve(".test-data/optimization-20261113");
    mkdirSync(taskRoot, { recursive: true });
    const root = mkdtempSync(join(taskRoot, "wdz-script-test-"));
    const source = join(root, "source");
    const target = join(root, "copy");
    const bytes = Buffer.from("SH600000\r\n", "utf8");
    mkdirSync(join(source, "概念"), { recursive: true });
    writeFileSync(join(source, "概念/a.txt"), bytes);
    const manifest = {
      fileCount: 1,
      files: [
        {
          path: "概念/a.txt",
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      ],
    };
    writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
    symlinkSync(source, join(root, "linked"), "junction");
    // Import only function definitions. Top-level migration and removal never run.
    const command = `
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(${quote(script)}, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Script parse failed' }
foreach ($fn in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
    . ([scriptblock]::Create($fn.Extent.Text))
}
$manifest = Get-Content -LiteralPath ${quote(join(root, "manifest.json"))} -Raw -Encoding UTF8 | ConvertFrom-Json
$sourceRoot = ${quote(source)}
$restoreRoot = ${quote(join(root, "restore"))}
$targetRoot = ${quote(target)}
Assert-Snapshot $sourceRoot
Copy-Snapshot $sourceRoot $targetRoot
Assert-Snapshot $targetRoot
function Expect-Rejection([scriptblock]$Action, [string]$Message) {
    $rejected = $false
    try { & $Action | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw $Message }
}
Expect-Rejection { Resolve-Child $sourceRoot '../outside.txt' } 'Traversal accepted'
Expect-Rejection { Resolve-Child $sourceRoot 'C:\\outside.txt' } 'Absolute path accepted'
Expect-Rejection { Resolve-Child $sourceRoot 'file:stream' } 'Alternate stream accepted'
Expect-Rejection { Copy-Snapshot $sourceRoot $targetRoot } 'Overwrite accepted'
Expect-Rejection { Assert-Snapshot ${quote(join(root, "linked"))} } 'Junction accepted'
Expect-Rejection { Remove-VerifiedSnapshot $targetRoot } 'Unreviewed removal target accepted'
if (-not (Test-Overlap $sourceRoot ($sourceRoot + '\\child'))) { throw 'Descendant overlap missed' }
if (-not (Test-Overlap ($sourceRoot + '\\child') $sourceRoot)) { throw 'Ancestor overlap missed' }
if (Test-Overlap $sourceRoot ($sourceRoot + '-other')) { throw 'Sibling falsely rejected' }
[IO.File]::WriteAllText((Join-Path $targetRoot 'extra.txt'), 'unexpected')
Expect-Rejection { Assert-Snapshot $targetRoot } 'Extra file accepted'
[IO.File]::WriteAllText((Join-Path $sourceRoot '概念/a.txt'), "SH600001\`r\`n")
Expect-Rejection { Assert-Snapshot $sourceRoot } 'Changed bytes accepted'
Write-Output 'snapshot-guards-passed'
`;
    try {
      // Let Windows PowerShell build its own module path; Node may inherit PowerShell 7 paths.
      const shellEnv = { ...process.env };
      for (const key of Object.keys(shellEnv))
        if (key.toLowerCase() === "psmodulepath") delete shellEnv[key];
      const result = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-EncodedCommand",
          Buffer.from(command, "utf16le").toString("base64"),
        ],
        {
          encoding: "utf8",
          windowsHide: true,
          timeout: 30000,
          env: shellEnv,
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("snapshot-guards-passed");
      expect(readFileSync(join(target, "概念/a.txt"))).toEqual(bytes);
      expect(readFileSync(join(target, "extra.txt"), "utf8")).toBe(
        "unexpected",
      );
    } finally {
      if (
        !root.startsWith(taskRoot + sep) ||
        !root.includes("wdz-script-test-")
      )
        throw new Error("Unsafe test cleanup path");
      rmSync(root, { recursive: true, force: true });
    }
  },
);
