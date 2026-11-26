param([switch]$AnalyzeMorning)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$server = Join-Path $repo 'release\win-unpacked\resources\server'
$node = Join-Path $server 'node-runtime\node.exe'
$runner = Join-Path $server 'runtime\workflow-runner.cjs'
if (!(Test-Path -LiteralPath $runner)) { throw '桌面包尚未包含新闻工作流' }
$data = Join-Path $env:LOCALAPPDATA 'QuantWorkbench'
$env:QUANT_DATA_DIR = $data
# Receipts and phases follow Beijing time even when Windows uses another timezone.
$beijingNow = [DateTimeOffset]::UtcNow.ToOffset([TimeSpan]::FromHours(8))
$date = $beijingNow.ToString('yyyy-MM-dd')
$hour = $beijingNow.Hour
$phase = if ($AnalyzeMorning -or $hour -lt 12) { 'morning' } elseif ($hour -lt 20) { 'noon' } else { 'evening' }
if (!$AnalyzeMorning) {
    $py = 'C:\Python312\python.exe'
    $collector = 'E:\pythonPrj\cls_news_collector\collector.py'
    $logDir = Join-Path $data 'logs'
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    $collectLog = Join-Path $logDir "cls-collector-$date.log"
    $env:PYTHONIOENCODING = 'utf-8'
    $collectExit = 1
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        Add-Content -LiteralPath $collectLog -Encoding utf8 -Value "===== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') 第 $attempt 次采集 ====="
        & cmd /c "`"$py`" `"$collector`" >> `"$collectLog`" 2>&1"
        $collectExit = $LASTEXITCODE
        if ($collectExit -eq 0) { break }
        Add-Content -LiteralPath $collectLog -Encoding utf8 -Value "采集失败 exit=$collectExit"
        if ($attempt -lt 3) { Start-Sleep -Seconds 60 }
    }
    if ($collectExit -ne 0) { throw "财联社采集失败(exit=$collectExit，已重试3次)，不发布完成回执" }
    New-Item -ItemType Directory -Path $data -Force | Out-Null
    $receipt = Join-Path $data "cls-collected-$date-$phase.json"
    @{ date = $date; phase = $phase; completedAt = [DateTimeOffset]::Now.ToUnixTimeMilliseconds(); exitCode = 0 } | ConvertTo-Json | Set-Content -LiteralPath "$receipt.tmp" -Encoding UTF8
    Move-Item -LiteralPath "$receipt.tmp" -Destination $receipt -Force
    if ($phase -eq 'morning') { exit 0 }
}
if (!$env:DEEPSEEK_API_KEY) { $env:DEEPSEEK_API_KEY = [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY', 'User') }
if (!$env:OPENROUTER_API_KEY) { $env:OPENROUTER_API_KEY = [Environment]::GetEnvironmentVariable('OPENROUTER_API_KEY', 'User') }
foreach ($n in 'LLM_FALLBACK_URL','LLM_FALLBACK_KEY') { if (!(Test-Path "env:$n")) { Set-Item "env:$n" ([Environment]::GetEnvironmentVariable($n, 'User')) } }
if ($AnalyzeMorning) {
    $receipt = Join-Path $data "cls-collected-$date-morning.json"
    while (!(Test-Path -LiteralPath $receipt)) {
        if ([DateTimeOffset]::UtcNow.ToOffset([TimeSpan]::FromHours(8)).ToString('HH:mm') -ge '09:00') { throw '盘前采集未按时完成，未补造主样本' }
        Start-Sleep -Seconds 5
    }
}
Push-Location -LiteralPath $server
try { & $node $runner --news $phase; exit $LASTEXITCODE } finally { Pop-Location }
