<#
.SYNOPSIS
Preview removal of reviewed, unused historical outputs. Add -Apply to delete.
.DESCRIPTION
Only the exact files and hashes below are allowed. No database, source input,
WDZ snapshot, directory or Git history is deleted. Missing files are harmless.
#>
[CmdletBinding(SupportsShouldProcess)]
param([switch]$Apply)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$targets = @(
    @{
        Path = 'docs\review\u8-calibration-distribution.json'
        Hash = 'C008D6D223D10E652508C98D8B6A689BB64B07B9EF4C22DD4945027895FB2038'
        Reason = 'Retired synthetic research calibration output; not a data source'
    }
)
$verified = @()
foreach ($entry in $targets) {
    $target = [IO.Path]::GetFullPath((Join-Path $repoRoot $entry.Path))
    if (-not $target.StartsWith($repoRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Target outside repository: $target"
    }
    $ancestor = $target
    while ($ancestor) {
        if (Test-Path -LiteralPath $ancestor) {
            if (((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Reparse point refused: $ancestor"
            }
        }
        $ancestor = [IO.Path]::GetDirectoryName($ancestor)
    }
    if (-not (Test-Path -LiteralPath $target)) {
        Write-Output "Already absent: $target"
        continue
    }
    $file = Get-Item -LiteralPath $target -Force
    if ($file.PSIsContainer) { throw "Directories are not allowed: $target" }
    if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $entry.Hash) {
        throw "File changed; nothing deleted: $target"
    }
    $verified += [PSCustomObject]@{ Path = $target; Bytes = $file.Length; Hash = $entry.Hash; Reason = $entry.Reason }
}
# Old copies of the generator may still be running in another shell.
$writers = @(Get-CimInstance Win32_Process | Where-Object {
    $_.ProcessId -ne $PID -and $_.Name -match '^(node|bun|deno)\.exe$' -and
    $_.CommandLine -match 'u8-calibration-distribution'
})
if ($writers.Count -gt 0) {
    throw ('Calibration process still running; close it first. PIDs: ' + (($writers | ForEach-Object { $_.ProcessId }) -join ', '))
}
$verified | Select-Object Path, Bytes, Reason | Format-List
if (-not $Apply) {
    Write-Output 'Preview only. Review the exact targets above, then add -Apply to delete.'
    exit 0
}
foreach ($entry in $verified) {
    if ($PSCmdlet.ShouldProcess($entry.Path, 'Delete the verified retired output')) {
        if ((Get-FileHash -LiteralPath $entry.Path -Algorithm SHA256).Hash -ne $entry.Hash) {
            throw "File changed during cleanup: $($entry.Path)"
        }
        Remove-Item -LiteralPath $entry.Path -Force
        if (Test-Path -LiteralPath $entry.Path) { throw "Removal incomplete: $($entry.Path)" }
        Write-Output "Removed: $($entry.Path)"
    }
}
