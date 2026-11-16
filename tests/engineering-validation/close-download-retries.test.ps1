param([string]$InstallerPath = (Join-Path $PSScriptRoot '..\..\scripts\install-close-download-retries.ps1'))
$ErrorActionPreference = 'Stop'
# Load generated cmdlets before masking them; PS5 module autoload can replace mocks.
Import-Module ScheduledTasks -ErrorAction Stop
$InstallerPath = [IO.Path]::GetFullPath($InstallerPath)
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($InstallerPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
$global:CloseRetryMock = @{ ReadCount = 0; Changed = $false; Task = $null; Writes = 0; Xml = '<Task><Actions/><Principals/><Settings/><Triggers/></Task>' }
function Get-ScheduledTask {
    param($TaskName, $TaskPath, $ErrorAction)
    if ($TaskName -cne 'TDX_DailyDownload' -or $TaskPath -cne '\') { throw 'Unexpected task target' }
    return $global:CloseRetryMock.Task
}
function Export-ScheduledTask {
    param($TaskName, $TaskPath, $ErrorAction)
    if ($TaskName -cne 'TDX_DailyDownload' -or $TaskPath -cne '\') { throw 'Unexpected export target' }
    $global:CloseRetryMock.ReadCount++
    if ($global:CloseRetryMock.Changed -and $global:CloseRetryMock.ReadCount -gt 1) { return $global:CloseRetryMock.Xml + '<!-- changed -->' }
    return $global:CloseRetryMock.Xml
}
function Set-ScheduledTask { $global:CloseRetryMock.Writes++; throw 'No task writes permitted in this test' }
function Register-ScheduledTask { $global:CloseRetryMock.Writes++; throw 'No registration permitted in this test' }
function Start-ScheduledTask { $global:CloseRetryMock.Writes++; throw 'No task execution permitted in this test' }
function New-Weekly([string]$Time) {
    $trigger = ScheduledTasks\New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At $Time
    $trigger.StartBoundary = '2020-09-15T' + $Time + ':00+08:00'
    return $trigger
}
function Reset-Task {
    $global:CloseRetryMock.ReadCount = 0
    $global:CloseRetryMock.Changed = $false
    $wrapper = Join-Path (Split-Path (Split-Path $InstallerPath -Parent) -Parent) 'scripts\workflow-task.ps1'
    $global:CloseRetryMock.Task = [pscustomobject]@{
        TaskName = 'TDX_DailyDownload'; TaskPath = '\'
        Actions = @([pscustomobject]@{ Execute = 'powershell.exe'; Arguments = "-NoProfile -File `"$wrapper`" -Phase download" })
        Triggers = @((New-Weekly '17:00'))
    }
}
function Expect-Preview([int]$Missing) {
    $before = $global:CloseRetryMock.Task.Triggers | Select-Object StartBoundary,Enabled,DaysOfWeek,WeeksInterval | ConvertTo-Json -Compress
    $beforeReads = $global:CloseRetryMock.ReadCount
    $output = (& $InstallerPath | Out-String)
    if (($global:CloseRetryMock.ReadCount - $beforeReads) -ne 2) { throw 'Preview bypassed mock task reads' }
    if ($output -notmatch ('待追加数量：' + $Missing) -or $output -notmatch '仅预演') { throw ('Unexpected preview result for missing=' + $Missing + ': ' + $output) }
    if (($global:CloseRetryMock.Task.Triggers | Select-Object StartBoundary,Enabled,DaysOfWeek,WeeksInterval | ConvertTo-Json -Compress) -cne $before) { throw 'Preview mutated original triggers' }
    if ($output -match '-NoProfile|-File|Arguments') { throw 'Preview leaked task arguments' }
}
function Expect-Rejection([string]$Pattern) {
    $rejected = $false
    try { & $InstallerPath | Out-Null } catch {
        if ($_.Exception.Message -notmatch $Pattern) { throw }
        $rejected = $true
    }
    if (!$rejected) { throw 'Expected task refusal' }
}

Reset-Task
Expect-Preview 2
$global:CloseRetryMock.Task.Triggers += ScheduledTasks\New-ScheduledTaskTrigger -AtStartup
Expect-Preview 2
$global:CloseRetryMock.Task.Triggers += New-Weekly '17:40'
Expect-Preview 1
$global:CloseRetryMock.Task.Triggers += New-Weekly '18:30'
Expect-Preview 0
Reset-Task
$global:CloseRetryMock.Task.Triggers[0].DaysOfWeek = 127
Expect-Rejection '每周一至五'
Reset-Task
$global:CloseRetryMock.Task.Triggers += New-Weekly '17:40'
$global:CloseRetryMock.Task.Triggers[-1].Enabled = $false
Expect-Rejection '每周一至五'
Reset-Task
$global:CloseRetryMock.Task.Triggers += New-Weekly '17:40'
$global:CloseRetryMock.Task.Triggers += New-Weekly '17:40'
Expect-Rejection '重复触发器'
Reset-Task
$global:CloseRetryMock.Task.Actions[0].Arguments = '-File CLS-task.ps1'
Expect-Rejection 'Action不是'
Reset-Task
$global:CloseRetryMock.Changed = $true
Expect-Rejection '任务已改变'
Reset-Task
$rejected = $false
try { & $InstallerPath -ExpectedTaskHash ('f' * 64) | Out-Null } catch {
    if ($_.Exception.Message -notmatch '预演版本不同') { throw }
    $rejected = $true
}
if (!$rejected) { throw 'Expected reviewed hash refusal' }

# Do not invoke -Apply, even with mocks. Verify its write barrier statically.
$commands = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.CommandAst] }, $true))
if (@($commands | Where-Object { $_.GetCommandName() -in @('Register-ScheduledTask', 'Start-ScheduledTask', 'Remove-Item') }).Count) { throw 'Unexpected registration/execution/deletion command' }
$write = @($commands | Where-Object { $_.GetCommandName() -eq 'Set-ScheduledTask' })
if ($write.Count -ne 1 -or $write[0].Extent.Text -notmatch '-Trigger @\(\$triggers \+ \$added\)' -or $write[0].Extent.Text -match '-Action|-Principal|-Settings') { throw 'Task mutation is not trigger-only append' }
$preview = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.IfStatementAst] -and $_.Extent.Text -match '^if \(!\$Apply\)' })
if ($preview.Count -ne 1 -or $preview[0].Extent.Text -notmatch '; return' -or $preview[0].Extent.EndOffset -ge $write[0].Extent.StartOffset) { throw 'Missing no-Apply return barrier' }
if ($ast.Extent.Text -notmatch '\[IO.FileMode\]::CreateNew' -or $ast.Extent.Text -notmatch '应用前任务版本已改变' -or $ast.Extent.Text -notmatch '备份后任务版本已改变') { throw 'Missing backup/version fences' }
if ($global:CloseRetryMock.Writes) { throw 'Mock observed a task write' }
Write-Output 'PASS: 10 preview/refusal cases; trigger-only append and Apply/version/CreateNew guards; no Apply, registration, execution or files written'
