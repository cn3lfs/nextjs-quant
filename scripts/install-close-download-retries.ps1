param(
    [switch]$Apply,
    [ValidatePattern('^$|^[a-f0-9]{64}$')][string]$ExpectedTaskHash = '',
    [string]$BackupPath = 'D:/quant-data/rollback/nextjs-quant-lifecycle-20261116/TDX_DailyDownload.xml'
)
$ErrorActionPreference = 'Stop'
$taskName = 'TDX_DailyDownload'
$taskPath = '\'

function Get-XmlHash([string]$Text) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}
function Get-BeijingTime($Trigger) {
    $boundary = [string]$Trigger.StartBoundary
    if (!$boundary) { return '' }
    if ($boundary -notmatch '(Z|[+-]\d{2}:\d{2})$') {
        if ((Get-TimeZone).Id -ne 'China Standard Time') { throw '现有触发器未注明时区且系统不是北京时间；未修改任务' }
        $boundary += '+08:00'
    }
    return ([DateTimeOffset]::Parse($boundary, [Globalization.CultureInfo]::InvariantCulture)).ToOffset([TimeSpan]::FromHours(8)).ToString('HH:mm:ss')
}
function Assert-WeekdayTrigger($Trigger) {
    if ($Trigger.CimClass.CimClassName -ne 'MSFT_TaskWeeklyTrigger' -or
        $Trigger.DaysOfWeek -ne 62 -or $Trigger.WeeksInterval -ne 1 -or
        !$Trigger.Enabled -or $Trigger.EndBoundary -or $Trigger.Id -or
        ($Trigger.RandomDelay -and $Trigger.RandomDelay -ne 'PT0S') -or
        $Trigger.Repetition.Interval -or $Trigger.Repetition.Duration) {
        throw '下载触发器必须为启用的每周一至五、无截止/延迟/重复/自定义ID；未修改任务'
    }
}
function Read-TaskXml {
    return [string](Export-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction Stop)
}
function Get-PreservedXmlHash([string]$Text) {
    $document = [xml]$Text
    $triggers = $document.DocumentElement.SelectSingleNode("*[local-name()='Triggers']")
    if ($triggers) { [void]$document.DocumentElement.RemoveChild($triggers) }
    return Get-XmlHash $document.OuterXml
}
function Get-TriggerXmlHashes([string]$Text) {
    $document = [xml]$Text
    return @($document.DocumentElement.SelectNodes("*[local-name()='Triggers']/*") | ForEach-Object { Get-XmlHash $_.OuterXml })
}

if ($Apply -and !$ExpectedTaskHash) { throw 'Apply必须提供预演输出的ExpectedTaskHash；未修改任务' }
if (![IO.Path]::IsPathRooted($BackupPath)) { throw 'BackupPath必须为绝对路径' }
$BackupPath = [IO.Path]::GetFullPath($BackupPath)
$originalXml = Read-TaskXml
$originalHash = Get-XmlHash $originalXml
$tasks = @(Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction Stop)
if ($tasks.Count -ne 1 -or $tasks[0].TaskName -ne $taskName -or $tasks[0].TaskPath -ne $taskPath) { throw '未找到唯一的根目录TDX_DailyDownload；未修改任务' }
$task = $tasks[0]
if ((Get-XmlHash (Read-TaskXml)) -ne $originalHash) { throw '读取期间任务已改变，请重新预演；未修改任务' }
if ($ExpectedTaskHash -and $ExpectedTaskHash -ne $originalHash) { throw '任务与已审阅预演版本不同，请重新预演；未修改任务' }
$actions = @($task.Actions)
$wrapper = Join-Path (Split-Path $PSScriptRoot -Parent) 'scripts\workflow-task.ps1'
if ($actions.Count -ne 1 -or [IO.Path]::GetFileName($actions[0].Execute) -ine 'powershell.exe' -or
    $actions[0].Arguments -notmatch ('(?i)(?:^|\s)-File\s+(?:"' + [regex]::Escape($wrapper) + '"|' + [regex]::Escape($wrapper) + ')(?:\s|$)') -or
    $actions[0].Arguments -notmatch '(?i)(?:^|\s)-Phase\s+download(?:\s|$)') {
    throw '现有Action不是本仓库的workflow-task download流程；未修改任务（不输出Arguments）'
}
$triggers = @($task.Triggers)
$primary = @($triggers | Where-Object { (Get-BeijingTime $_) -eq '17:00:00' })
if ($primary.Count -ne 1) { throw '必须存在唯一的北京时间17:00原触发器；未修改任务' }
Assert-WeekdayTrigger $primary[0]
$added = @()
foreach ($time in @('17:40:00', '18:30:00')) {
    $existing = @($triggers | Where-Object { (Get-BeijingTime $_) -eq $time })
    if ($existing.Count -gt 1) { throw "北京时间${time}存在重复触发器；未修改任务" }
    if ($existing.Count -eq 1) { Assert-WeekdayTrigger $existing[0]; continue }
    # Copy the actual CIM trigger, retaining all original properties except its
    # start boundary. Set-ScheduledTask receives only Trigger, never a new Action.
    $copy = [Microsoft.Management.Infrastructure.CimInstance]::new($primary[0])
    $date = ([DateTimeOffset]::Parse($primary[0].StartBoundary, [Globalization.CultureInfo]::InvariantCulture)).ToOffset([TimeSpan]::FromHours(8)).ToString('yyyy-MM-dd')
    $copy.StartBoundary = $date + 'T' + $time + '+08:00'
    $added += $copy
}
Write-Output "任务：$taskPath$taskName；保留所有原trigger/Action/Principal/Settings"
Write-Output ('北京时间工作日重试：17:40、18:30；待追加数量：' + $added.Count)
Write-Output "ExpectedTaskHash：$originalHash"
Write-Output "唯一XML备份：$BackupPath"
if (!$Apply) { Write-Output '仅预演，无文件或计划任务写入；部署获授权后才可用-Apply及上述ExpectedTaskHash'; return }
if (!$added.Count) { Write-Output '两个重试均已存在，无写入'; return }
if (Test-Path -LiteralPath $BackupPath) { throw '唯一备份已存在，不覆盖；请先人工核对备份与任务' }
if ((Get-XmlHash (Read-TaskXml)) -ne $originalHash) { throw '应用前任务版本已改变，请重新预演；未修改任务' }
$backupDirectory = Split-Path $BackupPath -Parent
if (!(Test-Path -LiteralPath $backupDirectory)) { New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null }
$stream = [IO.File]::Open($BackupPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
$writer = [IO.StreamWriter]::new($stream, [Text.Encoding]::Unicode)
try { $writer.Write($originalXml) } finally { $writer.Dispose() }
if ((Get-XmlHash ([IO.File]::ReadAllText($BackupPath))) -ne $originalHash) { throw '备份校验失败；未修改任务' }
if ((Get-XmlHash (Read-TaskXml)) -ne $originalHash) { throw '备份后任务版本已改变，保留备份但未修改任务' }
Set-ScheduledTask -TaskName $taskName -TaskPath $taskPath -Trigger @($triggers + $added) -ErrorAction Stop | Out-Null
$appliedXml = Read-TaskXml
$remaining = [Collections.Generic.List[string]]::new()
foreach ($hash in (Get-TriggerXmlHashes $appliedXml)) { $remaining.Add($hash) }
foreach ($hash in (Get-TriggerXmlHashes $originalXml)) {
    if (!$remaining.Remove($hash)) { throw '应用后原trigger校验失败；保留XML备份，请人工复核，未自动覆盖其他任务' }
}
if ((Get-PreservedXmlHash $appliedXml) -ne (Get-PreservedXmlHash $originalXml) -or $remaining.Count -ne $added.Count) {
    throw '应用后非trigger配置或新增数量校验失败；保留XML备份，请人工复核，未自动覆盖其他任务'
}
Write-Output '仅追加收盘重试触发器，原任务配置及原trigger校验通过；未启动任务'
