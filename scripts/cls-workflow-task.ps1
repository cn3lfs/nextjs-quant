param([switch]$AnalyzeMorning)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$server = Join-Path $repo 'release\win-unpacked\resources\server'
$node = Join-Path $server 'node-runtime\node.exe'
$runner = Join-Path $server 'runtime\workflow-runner.cjs'
if (!(Test-Path -LiteralPath $runner)) { throw '桌面包尚未包含新闻工作流' }
$data = Join-Path $env:LOCALAPPDATA 'QuantWorkbench'
$env:QUANT_DATA_DIR = $data
$date = Get-Date -Format 'yyyy-MM-dd'
$hour = (Get-Date).Hour
$phase = if ($AnalyzeMorning -or $hour -lt 12) { 'morning' } elseif ($hour -lt 20) { 'noon' } else { 'evening' }
if (!$AnalyzeMorning) {
    & 'C:\Python312\python.exe' 'E:\pythonPrj\cls_news_collector\collector.py'
    if ($LASTEXITCODE -ne 0) { throw '财联社采集失败，不发布完成回执' }
    New-Item -ItemType Directory -Path $data -Force | Out-Null
    $receipt = Join-Path $data "cls-collected-$date-$phase.json"
    @{ date = $date; phase = $phase; completedAt = [DateTimeOffset]::Now.ToUnixTimeMilliseconds(); exitCode = 0 } | ConvertTo-Json | Set-Content -LiteralPath "$receipt.tmp" -Encoding UTF8
    Move-Item -LiteralPath "$receipt.tmp" -Destination $receipt -Force
    if ($phase -eq 'morning') { exit 0 }
}
if (!$env:DEEPSEEK_API_KEY) { $env:DEEPSEEK_API_KEY = [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY', 'User') }
if ($AnalyzeMorning) {
    $receipt = Join-Path $data "cls-collected-$date-morning.json"
    while (!(Test-Path -LiteralPath $receipt)) {
        if ((Get-Date -Format 'HH:mm') -ge '09:00') { throw '盘前采集未按时完成，未补造主样本' }
        Start-Sleep -Seconds 5
    }
}
Push-Location -LiteralPath $server
try { & $node $runner --news $phase; exit $LASTEXITCODE } finally { Pop-Location }
