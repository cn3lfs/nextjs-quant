<#
.SYNOPSIS
Remove only the disposable worktree and artifacts from the light-theme delivery.
.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/cleanup-light-package.ps1
.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/cleanup-light-package.ps1 -Apply
.NOTES
Default: read-only preview. -Apply also deletes previous-win-unpacked (old rollback
package). The current release/win-unpacked and other tasks are never targets.
#>
[CmdletBinding(SupportsShouldProcess)]
param([switch]$Apply)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$worktree = [IO.Path]::GetFullPath((Join-Path $repoRoot '../qlight-pack-20261113'))
$artifacts = [IO.Path]::GetFullPath((Join-Path $repoRoot '.test-data/light-package-20261113'))
$expectedHead = '25fadcc325b4b1105f0defe45c08c6daa4cd145b'
$targets = @($worktree, $artifacts)

function Invoke-Git([string]$Directory, [string[]]$Arguments) {
    $output = @(& git -C $Directory @Arguments)
    if ($LASTEXITCODE -ne 0) { throw "Git check failed in $Directory" }
    return ($output -join "`n")
}
function Canonical-Path([string]$Path) {
    if ($Path.StartsWith('\\?\') -or $Path.StartsWith('\??\')) { $Path = $Path.Substring(4) }
    return [IO.Path]::GetFullPath($Path).TrimEnd('\')
}
function Assert-Target([string]$Path) {
    $absolute = Canonical-Path $Path
    if ($absolute -notin $targets) { throw "Not an exact allowed target: $absolute" }
    $parent = $absolute
    while ($parent) {
        if (Test-Path -LiteralPath $parent) {
            if ((Get-Item -LiteralPath $parent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Linked target or ancestor refused: $parent"
            }
        }
        $parent = [IO.Path]::GetDirectoryName($parent)
    }
}
function Assert-NoUsers {
    $WhatIfPreference = $false # Read-only CIM preflight must run under -WhatIf too.
    $busy = @(Get-CimInstance Win32_Process | Where-Object {
        if ($_.ProcessId -eq $PID) { return $false }
        $command = ([string]$_.CommandLine).Replace('/', '\')
        $executable = [string]$_.ExecutablePath
        foreach ($target in $targets) {
            if ($command.IndexOf($target, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
                $executable.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase)) { return $true }
        }
        return $false
    })
    if ($busy.Count) { throw ('Target is in use. No processes stopped. PIDs: ' + ($busy.ProcessId -join ', ')) }
}
function Assert-Worktree {
    $records = (Invoke-Git $repoRoot @('worktree', 'list', '--porcelain')) -split "`n`n"
    $registered = @($records | Where-Object {
        $line = ($_ -split "`n")[0]
        $line.StartsWith('worktree ') -and (Canonical-Path $line.Substring(9)) -eq $worktree
    })
    if (-not (Test-Path -LiteralPath $worktree)) {
        if ($registered.Count) { throw 'Missing but registered worktree; inspect it instead of pruning automatically.' }
        return
    }
    if ($registered.Count -ne 1 -or $registered[0] -notmatch '(?m)^detached$' -or $registered[0] -match '(?m)^locked') {
        throw 'Expected one unlocked detached worktree; refusing removal.'
    }
    $gitFile = Get-Item -LiteralPath (Join-Path $worktree '.git') -Force
    if ($gitFile.PSIsContainer -or ($gitFile.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unexpected worktree metadata' }
    if ((Invoke-Git $worktree @('rev-parse', 'HEAD')) -ne $expectedHead) { throw 'Worktree HEAD changed since delivery' }
    if (Invoke-Git $worktree @('status', '--porcelain', '--untracked-files=all')) { throw 'Worktree contains changes; nothing removed.' }
    $ignored = Invoke-Git $worktree @('status', '--porcelain', '--ignored', '--untracked-files=normal')
    foreach ($line in ($ignored -split "`n")) {
        if (-not $line) { continue }
        $name = $line.Substring(3)
        if ($name -notmatch '^(?:\.next|desktop|node_modules|release|runtime)/$' -and
            $name -notmatch '^packages/(?:quant-backtest|quant-performance|quant-rps|trading-strategies|trading-strategy-core|tstdx)/(?:dist|node_modules)/$') {
            throw "Unreviewed ignored data in worktree: $name"
        }
    }
    $mainCommon = Canonical-Path (Join-Path $repoRoot (Invoke-Git $repoRoot @('rev-parse', '--git-common-dir')))
    $common = Invoke-Git $worktree @('rev-parse', '--git-common-dir')
    if (-not [IO.Path]::IsPathRooted($common)) { $common = Join-Path $worktree $common }
    if ((Canonical-Path $common) -ne $mainCommon) { throw 'Worktree belongs to a different repository' }
    if (@(Get-ChildItem -LiteralPath $worktree -Force -File | Where-Object { $_.Name -like '.env*' -and $_.Name -ne '.env.example' }).Count) {
        throw 'Private environment file found in temporary worktree; review before removing.'
    }
}
function Get-Inventory([string]$Root) {
    Assert-Target $Root
    $directories = [Collections.Generic.Stack[string]]::new()
    $links = [Collections.Generic.List[object]]::new()
    $directories.Push($Root)
    [long]$bytes = 0
    [long]$files = 0
    while ($directories.Count) {
        foreach ($item in Get-ChildItem -LiteralPath $directories.Pop() -Force) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                # Do not follow pnpm junctions. Only links into this same disposable
                # worktree may be unlinked; an external or unknown link stops cleanup.
                if ($Root -ne $worktree -or -not $item.PSObject.Properties['Target']) { throw "Unknown link: $($item.FullName)" }
                $linkTargets = @($item.Target)
                if ($linkTargets.Count -ne 1 -or -not $linkTargets[0]) { throw "Unknown link destination: $($item.FullName)" }
                $linkTarget = [string]$linkTargets[0]
                if (-not [IO.Path]::IsPathRooted($linkTarget)) { $linkTarget = Join-Path ([IO.Path]::GetDirectoryName($item.FullName)) $linkTarget }
                if (-not (Canonical-Path $linkTarget).StartsWith($worktree + '\', [StringComparison]::OrdinalIgnoreCase)) {
                    throw "External link refused: $($item.FullName)"
                }
                $links.Add($item)
            } elseif ($item.PSIsContainer) { $directories.Push($item.FullName) }
            else {
                $files++
                $bytes += $item.Length
                if ($item.Extension -in @('.exe', '.dll', '.node')) {
                    $handle = [IO.File]::Open($item.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
                    $handle.Dispose()
                }
            }
        }
    }
    return [pscustomobject]@{ Path = $Root; Files = $files; GiB = [Math]::Round($bytes / 1GB, 3); Links = $links.ToArray() }
}
function Read-FileHash([string]$Path) {
    # Avoid Get-FileHash's provider-path behavior under Windows PowerShell -WhatIf.
    $algorithm = [Security.Cryptography.SHA256]::Create()
    $stream = $null
    try {
        $stream = [IO.File]::OpenRead($Path)
        return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '')
    } finally {
        if ($stream) { $stream.Dispose() }
        $algorithm.Dispose()
    }
}
function Get-ReleaseIdentity {
    $release = Join-Path $repoRoot 'release/win-unpacked'
    foreach ($file in @('GuanlanQuant.exe', 'resources/app.asar', 'resources/server/server.js', 'resources/server/node-runtime/node.exe')) {
        if (-not (Test-Path -LiteralPath (Join-Path $release $file) -PathType Leaf)) { throw "Current delivery missing: $file" }
    }
    $build = (Get-Content -LiteralPath (Join-Path $release 'resources/server/.next/BUILD_ID') -Raw).Trim()
    $prepared = (Get-Content -LiteralPath (Join-Path $release 'resources/server/.next/desktop-prepared-build-id') -Raw).Trim()
    if (-not $build -or $build -ne $prepared) { throw 'Current delivery is not prepared consistently; keep the backup.' }
    return "$build|$(Read-FileHash (Join-Path $release 'GuanlanQuant.exe'))|$(Read-FileHash (Join-Path $release 'resources/app.asar'))"
}

if ((Canonical-Path (Invoke-Git $repoRoot @('rev-parse', '--show-toplevel'))) -ne $repoRoot) { throw 'Unexpected repository root' }
foreach ($target in $targets) { Assert-Target $target }
Assert-Worktree
if (Invoke-Git $repoRoot @('ls-files', '--', '.test-data/light-package-20261113')) { throw 'Task artifacts contain tracked files' }
if (Test-Path -LiteralPath $artifacts) {
    $reviewedNames = @(
        'previous-win-unpacked', '01-design-staged.diff', '02-foundation-staged.diff',
        '03-market-staged.diff', '04-research-staged.diff', 'before-commit-snapshot.json',
        'commit-groups.json', 'delivered-package.json', 'delivery-inspection.log',
        'inspect-package.mjs', 'install.log', 'pack-attempt1.log', 'pack-attempt2.log',
        'pack.log', 'publish.log', 'publish.ps1', 'source-inspection.log',
        'source-package.json', 'staged-package.json'
    )
    foreach ($item in Get-ChildItem -LiteralPath $artifacts -Force) {
        if ($item.Name -notin $reviewedNames) { throw "Unreviewed task artifact: $($item.Name)" }
    }
}
$existing = @($targets | Where-Object { Test-Path -LiteralPath $_ })
if (-not $existing.Count) { Write-Host 'Already clean. No targets remain.'; return }
Assert-NoUsers
$releaseIdentity = Get-ReleaseIdentity
$inventory = @($existing | ForEach-Object { Get-Inventory $_ })
$inventory | Select-Object Path, Files, GiB, @{Name='InternalLinks'; Expression={@($_.Links).Count}} | Format-Table -AutoSize
Write-Host 'Includes the old previous-win-unpacked rollback copy. Current release and other tasks are preserved.'
if (-not $Apply) { Write-Host 'PREVIEW ONLY. Run the same command with -Apply to remove these exact targets.'; return }

foreach ($entry in $inventory) {
    Assert-Target $entry.Path
    Assert-NoUsers
    Assert-Worktree
    if ((Get-ReleaseIdentity) -ne $releaseIdentity) { throw 'Current delivery changed during cleanup; stopped.' }
    if ($PSCmdlet.ShouldProcess($entry.Path, 'Remove reviewed disposable delivery files, including old rollback copy')) {
        $current = Get-Inventory $entry.Path
        foreach ($link in $current.Links) {
            if ($link.PSIsContainer) { [IO.Directory]::Delete($link.FullName, $false) }
            else { Remove-Item -LiteralPath $link.FullName -Force }
        }
        if ($entry.Path -eq $worktree) {
            Invoke-Git $repoRoot @('-c', 'core.longpaths=true', 'worktree', 'remove', '--', $worktree) | Out-Null
        } else { Remove-Item -LiteralPath $entry.Path -Recurse -Force }
        if (Test-Path -LiteralPath $entry.Path) { throw "Cleanup incomplete: $($entry.Path)" }
        Write-Host "Removed: $($entry.Path)"
    }
}
if ((Get-ReleaseIdentity) -ne $releaseIdentity) { throw 'Delivery identity changed; inspect the current package.' }
Write-Host 'Finished. Current delivery identity is unchanged.'
