<#
.SYNOPSIS
Preview or remove the four temporary files left by the 2026-11-13 cleanup.
.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/cleanup-history-tools.ps1
.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/cleanup-history-tools.ps1 -Apply
#>
[CmdletBinding(SupportsShouldProcess)]
param([switch]$Apply)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$target = [IO.Path]::GetFullPath((Join-Path $repoRoot '.codex-runs\cleanup-history-20261113'))
$expected = @{
    'cleanup.ps1' = '4015AF5A1004AF29A2C9579EFD46CEDE5463D14138863522E9EE3622535A7DF2'
    'plan-first.json' = 'FC2AB075E5FD374E75DF1DD0F7F49EB610A7D37BE8A9703EA684C1DA2FDDAEF5'
    'plan.json' = '69D1D02FACE39F7EC493DA95B181CAD2AB64393E79A5D592B0FB6852A39D740B'
    'receipt.json' = '557EB6C7591785A2141E7A5B67D3BD477527C2336099D443756A3542D5116787'
}

if (-not $target.StartsWith($repoRoot + '\.codex-runs\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Target is outside the expected task directory.'
}
$ancestor = $target
while ($ancestor) {
    if (Test-Path -LiteralPath $ancestor) {
        $entry = Get-Item -LiteralPath $ancestor -Force
        if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Reparse point refused: $ancestor"
        }
    }
    $ancestor = [IO.Path]::GetDirectoryName($ancestor)
}
if (-not (Test-Path -LiteralPath $target)) {
    Write-Output "Already clean: $target"
    exit 0
}
$tracked = @(& git -C $repoRoot ls-files -- '.codex-runs/cleanup-history-20261113')
if ($LASTEXITCODE -ne 0 -or $tracked.Count -gt 0) {
    throw 'Git verification failed or the target contains tracked files.'
}
$children = @(Get-ChildItem -LiteralPath $target -Force)
foreach ($child in $children) {
    if ($child.PSIsContainer -or ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Unexpected directory or link: $($child.FullName)"
    }
    if (-not $expected.ContainsKey($child.Name)) {
        throw "Unexpected file; nothing deleted: $($child.FullName)"
    }
    if ((Get-FileHash -LiteralPath $child.FullName -Algorithm SHA256).Hash -ne $expected[$child.Name]) {
        throw "File changed; nothing deleted: $($child.FullName)"
    }
}
Write-Output "Exact target: $target"
$children | Select-Object FullName, Length | Format-Table -AutoSize
$bytes = 0L
foreach ($child in $children) { $bytes += $child.Length }
Write-Output "Files: $($children.Count); bytes: $bytes"
if (-not $Apply) {
    Write-Output 'Preview only. Add -Apply to delete these files and the empty task directory.'
    exit 0
}
if ($PSCmdlet.ShouldProcess($target, 'Delete verified temporary files and empty directory')) {
    foreach ($child in $children) {
        # Recheck immediately before deletion; partial prior runs are supported.
        if ((Get-FileHash -LiteralPath $child.FullName -Algorithm SHA256).Hash -ne $expected[$child.Name]) {
            throw "File changed during cleanup: $($child.FullName)"
        }
        Remove-Item -LiteralPath $child.FullName -Force
    }
    if (@(Get-ChildItem -LiteralPath $target -Force).Count -ne 0) {
        throw 'New files appeared. The directory was not removed.'
    }
    Remove-Item -LiteralPath $target
    if (Test-Path -LiteralPath $target) { throw "Cleanup incomplete: $target" }
    Write-Output 'Cleanup complete. Data sources, application data and release were not targeted.'
}
