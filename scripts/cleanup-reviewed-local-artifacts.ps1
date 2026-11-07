[CmdletBinding(SupportsShouldProcess)]
param(
    [switch]$Apply,
    [string]$PlanPath = (Join-Path $PSScriptRoot '../.codex-runs/cleanup-20261107-handoff/plan.json')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$expectedPlanHash = '4521d37bb0db9c72a42b629a2b21c3839161495052304dcf286dc7210bf7e5cb'
if ((Get-FileHash -LiteralPath $PlanPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedPlanHash) {
    throw 'The reviewed plan changed. Stop and review a new plan; do not widen this cleanup.'
}
$plan = Get-Content -LiteralPath $PlanPath -Raw -Encoding UTF8 | ConvertFrom-Json
$repoRoot = [IO.Path]::GetFullPath($plan.repoRoot).TrimEnd('\')
$allowedRoots = @($plan.allowedRoots | ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd('\') })

function Assert-ReviewedPath([string]$Path) {
    $absolute = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if ($absolute -ne $Path.TrimEnd('\')) { throw "Noncanonical target: $Path" }
    $scope = $allowedRoots | Where-Object {
        $absolute.StartsWith($_ + '\', [StringComparison]::OrdinalIgnoreCase)
    } | Sort-Object Length -Descending | Select-Object -First 1
    if (-not $scope) { throw "Target outside reviewed roots: $Path" }
    $parent = $absolute
    while ($parent.Length -ge $scope.Length) {
        if (Test-Path -LiteralPath $parent) {
            $item = Get-Item -LiteralPath $parent -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Reparse point refused: $parent"
            }
        }
        if ($parent -eq $scope) { break }
        $parent = [IO.Path]::GetDirectoryName($parent)
    }
    if ($absolute -match '\\(?:\.git|node_modules|release|runtime|desktop|\.data)(?:\\|$)' -or
        $absolute -match '\\QuantWorkbench\\(?:quant\.sqlite|credentials)(?:\\|$)') {
        throw "Protected target: $absolute"
    }
}

function Get-ReviewedSnapshot([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    $children = if ($item.PSIsContainer) { @(Get-ChildItem -LiteralPath $Path -Recurse -Force) } else { @($item) }
    if (@($children | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }).Count -gt 0) {
        throw "Reparse descendant refused: $Path"
    }
    $files = @($children | Where-Object { -not $_.PSIsContainer })
    [string[]]$lines = @($files | ForEach-Object {
        $relative = if ($item.PSIsContainer) { $_.FullName.Substring($Path.Length + 1).Replace('\', '/') } else { $_.Name }
        "$relative|$($_.Length)|$($_.LastWriteTimeUtc.Ticks)"
    })
    [Array]::Sort($lines, [StringComparer]::Ordinal)
    $bytes = [Text.Encoding]::UTF8.GetBytes(($lines -join "`n") + "`n")
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $digest = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    $total = 0
    if ($files.Count -gt 0) { $total = ($files | Measure-Object Length -Sum).Sum }
    return [pscustomobject]@{ Fingerprint = $digest; Files = $files.Count; Bytes = [long]$total }
}

# One native shell end to end. No process is stopped and no live database is opened.
$busy = @(Get-CimInstance Win32_Process | Where-Object {
    if ($_.ProcessId -eq $PID) { return $false }
    $command = [string]$_.CommandLine
    $executable = [string]$_.ExecutablePath
    $usesRepo = $command.Replace('/', '\').IndexOf($repoRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
    ($usesRepo -and $command -match '(?i)(node_modules[\\/](?:next|vitest)|next\s+(?:dev|build|start)|scripts[\\/](?:r3-batch-runner|start)\.[mt]?js)') -or
    ($executable -and ($executable.StartsWith($repoRoot + '\.playwright-browsers\', [StringComparison]::OrdinalIgnoreCase) -or
        $executable.StartsWith($repoRoot + '\.venv-hikyuu\', [StringComparison]::OrdinalIgnoreCase)))
})
if ($busy.Count -gt 0) {
    throw ('Relevant build/test/cache process still active; do not stop it automatically. PIDs: ' + (($busy | Select-Object -ExpandProperty ProcessId) -join ', '))
}

$tracked = @(git -C $repoRoot -c core.quotePath=false ls-files)
if ($LASTEXITCODE -ne 0) { throw 'Cannot verify tracked-file protection' }
Write-Host 'Validating every exact target before deleting anything...'
foreach ($target in $plan.targets) {
    Assert-ReviewedPath $target.path
    if ($target.path.StartsWith($repoRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        $relative = $target.path.Substring($repoRoot.Length + 1).Replace('\', '/')
        if (@($tracked | Where-Object { $_ -eq $relative -or $_.StartsWith($relative + '/', [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0) {
            throw "Tracked files refused: $relative"
        }
    }
    if (-not (Test-Path -LiteralPath $target.path)) { continue }
    $snapshot = Get-ReviewedSnapshot $target.path
    if ($snapshot.Fingerprint -ne $target.fingerprint -or $snapshot.Files -ne $target.files -or $snapshot.Bytes -ne $target.bytes) {
        throw "Target changed since review; no deletion performed: $($target.path)"
    }
}
$plan.targets | Group-Object category | ForEach-Object {
    [pscustomobject]@{ Category = $_.Name; Targets = $_.Count; GiB = [Math]::Round(($_.Group | Measure-Object bytes -Sum).Sum / 1GB, 3) }
} | Format-Table -AutoSize
if (-not $Apply) {
    Write-Host 'PREVIEW ONLY. No deletion performed. Use -Apply only under the executor own approval policy.'
    exit 0
}

$receiptPath = Join-Path (Split-Path -Parent $PlanPath) 'receipt.json'
$records = [Collections.Generic.List[object]]::new()
function Save-Receipt {
    [pscustomobject]@{ PlanHash = $expectedPlanHash; UpdatedAt = [DateTime]::UtcNow.ToString('o'); Results = @($records.ToArray()) } |
        ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $receiptPath -Encoding UTF8
}
try {
    foreach ($target in $plan.targets) {
        if (-not (Test-Path -LiteralPath $target.path)) {
            $records.Add([pscustomobject]@{ Path = $target.path; Status = 'already-missing'; Bytes = 0 })
            continue
        }
        Assert-ReviewedPath $target.path
        if ($PSCmdlet.ShouldProcess($target.path, 'Delete exact reviewed disposable artifact')) {
            Remove-Item -LiteralPath $target.path -Recurse -Force -ErrorAction Stop
            if (Test-Path -LiteralPath $target.path) { throw "Deletion incomplete: $($target.path)" }
            $records.Add([pscustomobject]@{ Path = $target.path; Status = 'deleted'; Bytes = $target.bytes })
        }
        if ($records.Count % 25 -eq 0) { Save-Receipt }
    }
} catch {
    $records.Add([pscustomobject]@{ Path = $target.path; Status = 'failed'; Error = $_.Exception.Message; Bytes = 0 })
    throw
} finally { Save-Receipt }
$removed = @($records | Where-Object Status -eq 'deleted')
Write-Host "Removed $($removed.Count) targets; receipt: $receiptPath"
