<#
.SYNOPSIS
Preview removal of three stale Zod junctions left by an isolated-to-hoisted pnpm installation change.
.DESCRIPTION
Only removes the reviewed junction entries, never their targets. The packages then
resolve the existing physical root dependency. No package versions or lockfiles change.
Run without -Apply first; close development/test/build processes before applying.
#>
[CmdletBinding(SupportsShouldProcess)]
param([switch]$Apply)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$physical = Join-Path $repoRoot 'node_modules\zod'
$oldTarget = Join-Path $repoRoot 'node_modules\.pnpm\zod@3.25.76\node_modules\zod'

function Assert-PlainAncestors([string]$Path) {
    $current = $Path
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $entry = Get-Item -LiteralPath $current -Force
            if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Unexpected ancestor link: $current"
            }
        }
        $current = [IO.Path]::GetDirectoryName($current)
    }
}

function Assert-StaleLink([string]$Path) {
    if (-not $Path.StartsWith($repoRoot + '\packages\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Outside package scope: $Path"
    }
    Assert-PlainAncestors ([IO.Path]::GetDirectoryName($Path))
    $entry = Get-Item -LiteralPath $Path -Force
    $targets = @($entry.Target)
    if ($entry.LinkType -ne 'Junction' -or $targets.Count -ne 1 -or
        [IO.Path]::GetFullPath($targets[0]) -ne $oldTarget) {
        throw "Not the reviewed stale junction: $Path"
    }
}

Assert-PlainAncestors $physical
if (-not (Test-Path -LiteralPath $physical -PathType Container)) { throw 'Root Zod installation is missing.' }
$manifest = Get-Content -LiteralPath (Join-Path $physical 'package.json') -Raw | ConvertFrom-Json
if ($manifest.name -ne 'zod' -or $manifest.version -ne '3.25.76') { throw 'Unexpected root Zod version.' }
if (-not (Select-String -LiteralPath (Join-Path $repoRoot '.npmrc') -Pattern '^node-linker=hoisted\s*$' -Quiet)) {
    throw 'This repair only applies to node-linker=hoisted.'
}
$targets = @()
foreach ($name in @('quant-backtest', 'trading-strategies', 'trading-strategy-core')) {
    $path = [IO.Path]::GetFullPath((Join-Path $repoRoot "packages\$name\node_modules\zod"))
    if (Test-Path -LiteralPath $path) {
        Assert-StaleLink $path
        $targets += $path
    } else {
        Write-Output "Already absent: $path"
    }
}
Write-Output "Physical dependency retained: $physical"
Write-Output "Old target retained: $oldTarget"
$targets | ForEach-Object { Write-Output "Junction entry only: $_" }
if (-not $Apply) {
    Write-Output "Preview only: $($targets.Count) junctions. Add -Apply to repair. No dependency contents will be deleted."
    exit 0
}
$active = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -match '^(node|electron)(\.exe)?$' -and $_.CommandLine -and
    $_.CommandLine.IndexOf($repoRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
})
if ($active.Count) { throw "Close repository Node/Electron processes first: $($active.ProcessId -join ', ')" }
foreach ($path in $targets) {
    if ($PSCmdlet.ShouldProcess($path, 'Remove stale junction entry only')) {
        Assert-StaleLink $path
        # Non-recursive Directory.Delete removes the junction, not its contents.
        [IO.Directory]::Delete($path)
        if (Test-Path -LiteralPath $path) { throw "Junction remains: $path" }
    }
}
Write-Output 'Repair finished. Run pnpm check --build to verify the current installation.'
