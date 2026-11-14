<#
.SYNOPSIS
Preview relocation of the reviewed WDZ snapshot. Add -Apply to copy, verify and remove the repository copy.
.DESCRIPTION
Preserves the external live data source. Does not stage Git changes or rewrite history.
ArchiveDirectory must be an explicit local directory outside this repository and the live source.
Default mode reads only. Every original file is listed and verified before mutation.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory = $true)][string]$ArchiveDirectory,
    [switch]$Apply
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$snapshotRoot = Join-Path $repoRoot 'docs\data-sources\wdz-blocks\2026-11-07'
$sourceRoot = Join-Path $snapshotRoot 'Blocks'
$restoreRoot = Join-Path $repoRoot '.test-data\optimization-20261113\wdz-restore-check'
$expectedHash = '3f45ff4acf69f67daff5dde9d354b604cfbcb0133e68c498ed6f71b762d87be8'

function Assert-NoLinks([string]$Path) {
    for ($ancestor = $Path; $ancestor; $ancestor = [IO.Path]::GetDirectoryName($ancestor)) {
        if (Test-Path -LiteralPath $ancestor) {
            if (((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Linked path refused: $ancestor"
            }
        }
    }
}
function Resolve-Child([string]$Root, [string]$Relative) {
    if ([IO.Path]::IsPathRooted($Relative) -or $Relative -match '(^|[\\/])\.\.?([\\/]|$)|:') {
        throw "Unsafe manifest path: $Relative"
    }
    $path = [IO.Path]::GetFullPath((Join-Path $Root $Relative))
    if (-not $path.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path outside snapshot: $path"
    }
    Assert-NoLinks $path
    return $path
}
function Test-Overlap([string]$First, [string]$Second) {
    return $First.Equals($Second, [StringComparison]::OrdinalIgnoreCase) -or
        $First.StartsWith($Second + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $Second.StartsWith($First + '\', [StringComparison]::OrdinalIgnoreCase)
}
function Get-SnapshotTree([string]$Root) {
    Assert-NoLinks $Root
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { throw "Missing snapshot: $Root" }
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push($Root)
    while ($pending.Count) {
        foreach ($entry in Get-ChildItem -LiteralPath $pending.Pop() -Force) {
            if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Linked snapshot entry refused: $($entry.FullName)"
            }
            if ($entry.PSIsContainer) { $pending.Push($entry.FullName) }
            $entry
        }
    }
}
function Assert-Snapshot([string]$Root) {
    $entries = @(Get-SnapshotTree $Root)
    $files = @($entries | Where-Object { -not $_.PSIsContainer })
    if ($files.Count -ne $manifest.fileCount) { throw "Unexpected file count at $Root : $($files.Count)" }
    foreach ($file in $manifest.files) {
        $path = Resolve-Child $Root $file.path
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing file: $path" }
        if ((Get-Item -LiteralPath $path).Length -ne $file.bytes -or
            (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $file.sha256) {
            throw "Snapshot changed: $path"
        }
    }
    # Do not silently remove an extra empty directory that is absent from the manifest.
    foreach ($directory in $entries | Where-Object { $_.PSIsContainer }) {
        $relative = $directory.FullName.Substring($Root.Length + 1).Replace('\', '/') + '/'
        if (-not @($manifest.files | Where-Object { $_.path.StartsWith($relative, [StringComparison]::Ordinal) }).Count) {
            throw "Unlisted empty directory: $($directory.FullName)"
        }
    }
}
function Copy-Snapshot([string]$From, [string]$To) {
    if (Test-Path -LiteralPath $To) { throw "Copy target already exists: $To" }
    Assert-NoLinks $To
    foreach ($file in $manifest.files) {
        $source = Resolve-Child $From $file.path
        $target = Resolve-Child $To $file.path
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
        [IO.File]::Copy($source, $target, $false)
    }
    Assert-Snapshot $To
}
function Assert-ArchiveMetadata {
    foreach ($name in @('manifest.json', 'README.md')) {
        $path = Join-Path $archiveRoot $name
        Assert-NoLinks $path
        if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne
            (Get-FileHash -LiteralPath (Join-Path $snapshotRoot $name) -Algorithm SHA256).Hash) {
            throw "Archive metadata differs: $name"
        }
    }
}
function Remove-VerifiedSnapshot([string]$Root) {
    if ($Root -ne $sourceRoot -and $Root -ne $restoreRoot) { throw "Removal target refused: $Root" }
    Assert-Snapshot $Root
    $entries = @(Get-SnapshotTree $Root)
    foreach ($file in $manifest.files) {
        $path = Resolve-Child $Root $file.path
        if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $file.sha256) {
            throw "File changed during removal: $path"
        }
        Remove-Item -LiteralPath $path -Force
    }
    foreach ($directory in $entries | Where-Object { $_.PSIsContainer } | Sort-Object { $_.FullName.Length } -Descending) {
        Assert-NoLinks $directory.FullName
        # No recursive deletion: unexpected new files must stop removal.
        [IO.Directory]::Delete($directory.FullName, $false)
    }
    Assert-NoLinks $Root
    [IO.Directory]::Delete($Root, $false)
}

Assert-NoLinks $snapshotRoot
$manifest = Get-Content -LiteralPath (Join-Path $snapshotRoot 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.fileCount -ne 2319 -or $manifest.bytes -ne 3703787 -or $manifest.sha256 -ne $expectedHash) {
    throw 'Unexpected WDZ snapshot identity.'
}
$identities = @($manifest.files | ForEach-Object { [ordered]@{ path = $_.path; bytes = $_.bytes; sha256 = $_.sha256 } })
$canonical = ConvertTo-Json -InputObject $identities -Depth 4 -Compress
$sha = [Security.Cryptography.SHA256]::Create()
try { $identityHash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($canonical))).Replace('-', '').ToLowerInvariant() }
finally { $sha.Dispose() }
if ($identityHash -ne $expectedHash) { throw 'Manifest contents do not match the reviewed snapshot hash.' }
$names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($file in $manifest.files) {
    [void](Resolve-Child $sourceRoot $file.path)
    if (-not $names.Add($file.path)) { throw "Duplicate manifest path: $($file.path)" }
}
if ($ArchiveDirectory -notmatch '^[A-Za-z]:[\\/]') { throw 'Use an absolute local drive path for ArchiveDirectory.' }
if ($ArchiveDirectory.Substring(3) -match '(^|[\\/])[^\\/]*[. ]([\\/]|$)|:') {
    throw 'Archive path cannot contain alternate streams or Windows trailing-dot/space aliases.'
}
$archiveRoot = [IO.Path]::GetFullPath($ArchiveDirectory).TrimEnd('\')
$liveRoot = [IO.Path]::GetFullPath([string]$manifest.source).TrimEnd('\')
if ((Test-Overlap $archiveRoot $repoRoot) -or (Test-Overlap $archiveRoot $liveRoot)) {
    throw 'Archive must be outside the repository and live data source, without ancestor overlap.'
}
Assert-NoLinks $archiveRoot
Assert-NoLinks $restoreRoot
$archiveBlocks = Join-Path $archiveRoot 'Blocks'
$archiveExists = Test-Path -LiteralPath $archiveRoot
if ($archiveExists) {
    $archiveEntries = @(Get-ChildItem -LiteralPath $archiveRoot -Force)
    if (@($archiveEntries | Where-Object { $_.Name -notin @('Blocks', 'manifest.json', 'README.md') }).Count) {
        throw 'Archive contains unrelated entries; nothing will be overwritten.'
    }
    Assert-Snapshot $archiveBlocks
    Assert-ArchiveMetadata
}
if (-not (Test-Path -LiteralPath $sourceRoot)) {
    if (-not $archiveExists) { throw 'Both repository snapshot and archive are absent.' }
    Write-Output "Already relocated and verified: $archiveRoot"
    return
}
Assert-Snapshot $sourceRoot
if (Test-Path -LiteralPath $restoreRoot) { throw "Restore-check directory exists; review it before retrying: $restoreRoot" }
$dirty = @(& git -C $repoRoot status --porcelain --untracked-files=all -- 'docs/data-sources/wdz-blocks/2026-11-07/Blocks')
if ($LASTEXITCODE -ne 0 -or $dirty.Count) { throw 'Snapshot has Git changes or Git inspection failed; nothing moved.' }
Write-Output "Archive: $archiveRoot"
Write-Output "Temporary restore check: $restoreRoot"
foreach ($file in $manifest.files) { Write-Output "Verified relocation target: $(Resolve-Child $sourceRoot $file.path) [$($file.bytes) bytes; $($file.sha256)]" }
if (-not $Apply) { Write-Output 'Preview only. Add -Apply to copy, restore-verify and remove only the reviewed repository snapshot.'; return }
if (-not $PSCmdlet.ShouldProcess($sourceRoot, "Relocate 2319 verified files to $archiveRoot")) { return }
if (-not $archiveExists) {
    Copy-Snapshot $sourceRoot $archiveBlocks
    foreach ($name in @('manifest.json', 'README.md')) {
        [IO.File]::Copy((Join-Path $snapshotRoot $name), (Join-Path $archiveRoot $name), $false)
    }
}
Assert-Snapshot $archiveBlocks
Assert-ArchiveMetadata
Copy-Snapshot $archiveBlocks $restoreRoot
Assert-Snapshot $sourceRoot
Remove-VerifiedSnapshot $restoreRoot
# Verify the surviving copy again immediately before removing the repository copy.
Assert-Snapshot $archiveBlocks
Remove-VerifiedSnapshot $sourceRoot
Write-Output "Relocated and verified: $archiveRoot"
Write-Output 'Review Git deletions yourself. No files have been staged and Git history is unchanged.'
