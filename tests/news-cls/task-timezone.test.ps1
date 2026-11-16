param(
    [string]$InstallerPath = (Join-Path $PSScriptRoot '..\..\scripts\install-workflow-tasks.ps1'),
    [string]$DownloaderPath = 'E:\new_tdx64\auto_download\tdx_download.ps1'
)
$ErrorActionPreference = 'Stop'

function Read-Ast([string]$Path) {
    $tokens = $null
    $errors = $null
    $source = [IO.File]::ReadAllText([IO.Path]::GetFullPath($Path), [Text.Encoding]::UTF8)
    $ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw ($errors | Out-String) }
    return $ast
}

# Evaluate only trigger construction. Never execute registration or task actions.
function New-ScheduledTaskTrigger {
    param([switch]$Weekly, $DaysOfWeek, [string]$At)
    [pscustomobject]@{ StartBoundary = ('2026-11-15T' + $At + ':00') }
}
$installer = Read-Ast $InstallerPath
$triggerStatements = $installer.EndBlock.Statements | Where-Object {
    $_ -is [Management.Automation.Language.AssignmentStatementAst] -and
    $_.Extent.Text -match '^\$(days\s*=|closeTriggers\s*=|lateTrigger\s*=|noonTrigger\s*=|lateTrigger\.StartBoundary\s*=|noonTrigger\.StartBoundary\s*=)'
}
foreach ($statement in $triggerStatements) { Invoke-Expression $statement.Extent.Text }
$boundaries = @($closeTriggers) + @($lateTrigger, $noonTrigger)
if ($boundaries.Count -ne 5) { throw 'Expected three close triggers plus noon and late' }
foreach ($trigger in $boundaries) {
    if ($trigger.StartBoundary -notmatch '\+08:00$') { throw "Unpinned trigger: $($trigger.StartBoundary)" }
}

$downloader = Read-Ast $DownloaderPath
function Get-Date { param([string]$Format) ([datetime]'2026-11-15T16:20:00').ToString($Format) }
$clockStatements = $downloader.EndBlock.Statements | Where-Object {
    $_ -is [Management.Automation.Language.AssignmentStatementAst] -and
    $_.Extent.Text -match '^\$(BeijingNow|Today)\s*='
}
foreach ($statement in $clockStatements) {
    $code = $statement.Extent.Text.Replace('[DateTimeOffset]::UtcNow', "[DateTimeOffset]::Parse('2026-11-16T00:20:00Z')")
    Invoke-Expression $code
}
if ($Today -ne '2026-11-16') { throw "Wrong download business date: $Today" }
'PASS: five task boundaries and downloader Beijing day; no tasks, download or model clients executed.'
