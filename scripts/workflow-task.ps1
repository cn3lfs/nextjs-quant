param([ValidateSet('download', 'late')][string]$Phase = 'download')
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$server = Join-Path $repo 'release\win-unpacked\resources\server'
$node = Join-Path $server 'node-runtime\node.exe'
$runner = Join-Path $server 'runtime\workflow-runner.cjs'
if (!(Test-Path -LiteralPath $runner)) { throw '请先更新包含每日工作流的桌面包' }
$data = Join-Path $env:LOCALAPPDATA 'QuantWorkbench'
$env:QUANT_DATA_DIR = $data
$date = Get-Date -Format 'yyyy-MM-dd'
$time = Get-Date -Format 'HH:mm'
$slot = 'late'
if ($Phase -eq 'download') {
    $slot = if ($time -ge '12:00' -and $time -lt '13:00') { 'noon' } else { 'close' }
    $downloader = 'E:\new_tdx64\auto_download\tdx_download.ps1'
    $downloadArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $downloader)
    if ($time -lt '20:00') { $downloadArgs += '-MarketOnly' }
    & powershell.exe @downloadArgs
    if ($LASTEXITCODE -ne 0) { throw "通达信下载未成功（$LASTEXITCODE），保留上一批排名" }
    New-Item -ItemType Directory -Path $data -Force | Out-Null
    $receipt = Join-Path $data "download-$date-$slot.json"
    $temporary = "$receipt.tmp"
    @{ date = $date; phase = $slot; exitCode = 0; completedAt = [DateTimeOffset]::Now.ToUnixTimeMilliseconds() } | ConvertTo-Json | Set-Content -LiteralPath $temporary -Encoding UTF8
    Move-Item -LiteralPath $temporary -Destination $receipt -Force
}
Push-Location -LiteralPath $server
try {
    & $node $runner --phase $slot
    exit $LASTEXITCODE
} finally { Pop-Location }
