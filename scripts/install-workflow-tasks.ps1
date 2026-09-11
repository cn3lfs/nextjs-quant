param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$runner = Join-Path $repo 'release\win-unpacked\resources\server\runtime\workflow-runner.cjs'
$task = Get-ScheduledTask -TaskName 'TDX_DailyDownload'
$downloader = 'E:\new_tdx64\auto_download\tdx_download.ps1'
$original = Get-Content -LiteralPath $downloader -Raw -Encoding UTF8
if (!$Apply) {
    Write-Output 'TDX_DailyDownload: 工作日12:00、15:30、20:00；Quant_RPS_Late: 工作日14:40。前两批只下载行情，20:00保留财务更新。'
    Write-Output '使用 -Apply 备份后应用；仅在新桌面包验证完成后执行。'
    exit 0
}
if (!(Test-Path -LiteralPath $runner)) { throw '新桌面包缺少后台工作流，未修改任务' }
$backup = Join-Path ([Environment]::GetFolderPath('MyDocuments')) ('QuantWorkflowBackups\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backup -Force | Out-Null
Export-ScheduledTask -TaskName $task.TaskName | Set-Content -LiteralPath (Join-Path $backup 'TDX_DailyDownload.xml') -Encoding Unicode
Copy-Item -LiteralPath $downloader -Destination (Join-Path $backup 'tdx_download.ps1')
$late = Get-ScheduledTask -TaskName 'Quant_RPS_Late' -ErrorAction SilentlyContinue
if ($late) { Export-ScheduledTask -TaskName $late.TaskName | Set-Content -LiteralPath (Join-Path $backup 'Quant_RPS_Late.xml') -Encoding Unicode }
$collector = Get-ScheduledTask -TaskName 'CLS_News_Collector'
$analysis = Get-ScheduledTask -TaskName 'ClaudeCLS-DailyNewsAnalysis'
Export-ScheduledTask -TaskName $collector.TaskName | Set-Content -LiteralPath (Join-Path $backup 'CLS_News_Collector.xml') -Encoding Unicode
Export-ScheduledTask -TaskName $analysis.TaskName | Set-Content -LiteralPath (Join-Path $backup 'ClaudeCLS-DailyNewsAnalysis.xml') -Encoding Unicode
$collectorPath = 'E:\pythonPrj\cls_news_collector\collector.py'
Copy-Item -LiteralPath $collectorPath -Destination (Join-Path $backup 'collector.py')
$collectorCode = Get-Content -LiteralPath $collectorPath -Raw -Encoding UTF8
if (!$collectorCode.Contains('CLS first-page fetch returned no data') -and !$collectorCode.Contains('            items = fetch_news(last_time=last_time)')) { throw '采集脚本结构变化，未修改任务' }
if ($original -notmatch '\[switch\]\$MarketOnly') {
    $updated = "param([switch]`$MarketOnly)`r`n" + $original
    $updated = $updated.Replace('$MaxRetries = 8', '$MaxRetries = if ($MarketOnly) { 2 } else { 8 }').Replace('$TimeoutSec = 600', '$TimeoutSec = if ($MarketOnly) { 180 } else { 600 }')
    $anchor = '$LogDir = Join-Path'
    if (!$updated.Contains($anchor)) { throw '下载脚本结构变化，未修改' }
    $updated = $updated.Replace($anchor, "if (`$MarketOnly) { `$Tasks = @(`$Tasks[0]) }`r`n`r`n" + $anchor)
    Set-Content -LiteralPath $downloader -Value $updated -Encoding UTF8
}
$days = @('Monday','Tuesday','Wednesday','Thursday','Friday')
$triggers = @('12:00','15:30','20:00') | ForEach-Object { New-ScheduledTaskTrigger -Weekly -DaysOfWeek $days -At $_ }
$wrapper = Join-Path $PSScriptRoot 'workflow-task.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$wrapper`" -Phase download" -WorkingDirectory $repo
Set-ScheduledTask -TaskName $task.TaskName -Action $action -Trigger $triggers -ErrorAction Stop | Out-Null
$lateAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$wrapper`" -Phase late" -WorkingDirectory $repo
$lateTrigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $days -At '14:40'
$lateSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
Register-ScheduledTask -TaskName 'Quant_RPS_Late' -Action $lateAction -Trigger $lateTrigger -Settings $lateSettings -Principal $task.Principal -Force -ErrorAction Stop | Out-Null
Write-Output "任务已更新；备份：$backup"
# A failed first-page fetch used to return [] and exit 0; do not mark that as a completed collection.
if (!$collectorCode.Contains('CLS first-page fetch returned no data')) {
$collectorCode = $collectorCode.Replace('            items = fetch_news(last_time=last_time)', "            items = fetch_news(last_time=last_time)`r`n            if not items and page == 0:`r`n                raise RuntimeError('CLS first-page fetch returned no data; completion not confirmed')")
Set-Content -LiteralPath $collectorPath -Value $collectorCode -Encoding UTF8
}
$newsWrapper = Join-Path $PSScriptRoot 'cls-workflow-task.ps1'
$collectAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$newsWrapper`"" -WorkingDirectory $repo
$analyzeAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$newsWrapper`" -AnalyzeMorning" -WorkingDirectory $repo
Set-ScheduledTask -TaskName $collector.TaskName -Action $collectAction -ErrorAction Stop | Out-Null
Set-ScheduledTask -TaskName $analysis.TaskName -Action $analyzeAction -Principal $collector.Principal -ErrorAction Stop | Out-Null
Write-Output '财联社保留08/12/20采集触发；08:30消费盘前回执，午间与晚间在采集完成后分析。'
