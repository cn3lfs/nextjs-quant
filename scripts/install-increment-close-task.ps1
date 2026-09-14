param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$existing = Get-ScheduledTask -TaskName 'TDX_DailyDownload' -ErrorAction Stop
$newName = 'Quant_RPS_CloseIncrement'
$wrapper = Join-Path $PSScriptRoot 'increment-close-task.ps1'
$closeTriggers = @($existing.Triggers | Where-Object { ([datetime]$_.StartBoundary).ToString('HH:mm') -eq '15:30' })
$remainingTriggers = @($existing.Triggers | Where-Object { ([datetime]$_.StartBoundary).ToString('HH:mm') -ne '15:30' })
if ($closeTriggers.Count -ne 1 -or $remainingTriggers.Count -lt 1) {
    throw '原下载任务不是预期的单个15:30触发器加其他时段，未修改；请先核对触发器'
}
$plan = [ordered]@{
    task = $newName
    firstAttempt = '15:30'
    retryMinutes = 15
    maximumRetries = 1
    retainedDownloadTimes = @($remainingTriggers | ForEach-Object { ([datetime]$_.StartBoundary).ToString('HH:mm') })
    unchanged = @('Quant_RPS_Late', 'CLS_News_Collector', 'QuantWorkbench-CLS-Morning')
    apply = [bool]$Apply
}
$plan | ConvertTo-Json -Depth 4
if (!$Apply) { exit 0 }
# Validate before creating backups or changing any scheduled task.
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $wrapper -CheckOnly
if ($LASTEXITCODE -ne 0) { throw '收盘运行包预检查未通过，未修改计划任务' }
$previousClose = Get-ScheduledTask -TaskName $newName -ErrorAction SilentlyContinue
if ($previousClose) { throw '收盘增量任务已存在，未覆盖；请核对已有配置' }
if ($existing.State -eq 'Running') { throw '原下载任务正在运行，未切换' }
$backup = Join-Path ([Environment]::GetFolderPath('MyDocuments')) ('QuantWorkflowBackups\increment-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backup -ErrorAction Stop | Out-Null
$originalXml = Export-ScheduledTask -TaskName $existing.TaskName -ErrorAction Stop
$originalXml | Set-Content -LiteralPath (Join-Path $backup 'TDX_DailyDownload.xml') -Encoding Unicode
$plan | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $backup 'plan.json') -Encoding UTF8
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$wrapper`"" -WorkingDirectory $repo
$taskSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -RestartCount 1 -RestartInterval (New-TimeSpan -Minutes 15)
# Create disabled, remove only the old close trigger, then enable. This avoids
# an interval in which both close actions can start from the schedule.
$created = $false
$changed = $false
try {
    $definition = New-ScheduledTask -Action $action -Trigger $closeTriggers -Settings $taskSettings -Principal $existing.Principal
    $definition.Settings.Enabled = $false
    Register-ScheduledTask -TaskName $newName -InputObject $definition -ErrorAction Stop | Out-Null
    $created = $true
    Set-ScheduledTask -TaskName $existing.TaskName -Trigger $remainingTriggers -ErrorAction Stop | Out-Null
    $changed = $true
    Enable-ScheduledTask -TaskName $newName -ErrorAction Stop | Out-Null
} catch {
    $failure = $_
    if ($changed) { Set-ScheduledTask -TaskName $existing.TaskName -Trigger $existing.Triggers -ErrorAction Stop | Out-Null }
    if ($created) { Unregister-ScheduledTask -TaskName $newName -Confirm:$false -ErrorAction Stop }
    throw $failure
}
Write-Output "收盘任务已切换；备份：$backup"
