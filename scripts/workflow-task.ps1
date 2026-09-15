param(
    [ValidateSet('noon', 'download', 'late')][string]$Phase = 'download',
    [string]$ServerDirectory = (Join-Path (Split-Path $PSScriptRoot -Parent) 'release\win-unpacked\resources\server'),
    [string]$DataDirectory = (Join-Path $env:LOCALAPPDATA 'QuantWorkbench'),
    [string]$DownloaderPath = 'E:\new_tdx64\auto_download\tdx_download.ps1'
)
$ErrorActionPreference = 'Stop'
$node = Join-Path $ServerDirectory 'node-runtime\node.exe'
$runner = Join-Path $ServerDirectory 'runtime\workflow-runner.cjs'
if (!(Test-Path -LiteralPath $node -PathType Leaf) -or !(Test-Path -LiteralPath $runner -PathType Leaf)) { throw '请先更新包含每日工作流的桌面包' }
$env:QUANT_DATA_DIR = [IO.Path]::GetFullPath($DataDirectory)
$date = Get-Date -Format 'yyyy-MM-dd'
$slot = if ($Phase -eq 'download') { 'close' } else { $Phase }
if ($Phase -eq 'download') {
    # The full daily package and the financial packages are both published after
    # the close, so download all of them once at 17:00 (the old
    # run_tdx_download.bat behaviour). The noon batch observes only and must not
    # touch the source files.
    New-Item -ItemType Directory -Path $DataDirectory -Force | Out-Null
    $receipt = Join-Path $DataDirectory "download-$date-$slot.json"
    if (Test-Path -LiteralPath $receipt -PathType Leaf) {
        # A retry after the runner failed must not pull the packages again.
        Write-Output "今日下载回执已存在，跳过下载：$receipt"
    } else {
        # The external UTF-8 script may have no BOM. Windows PowerShell 5 -File
        # then decodes Chinese text as ANSI and fails before creating its log.
        $previousDownloader = $env:QUANT_TDX_DOWNLOADER
        $env:QUANT_TDX_DOWNLOADER = $DownloaderPath
        $loader = '$script = [ScriptBlock]::Create([IO.File]::ReadAllText($env:QUANT_TDX_DOWNLOADER, [Text.Encoding]::UTF8)); & $script'
        try {
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($loader)))
            $downloadExit = $LASTEXITCODE
        } finally {
            $env:QUANT_TDX_DOWNLOADER = $previousDownloader
        }
        # 3 = the server still serves the previous session's package; the ranking
        # would be stale, so stop before the runner rejects it.
        if ($downloadExit -eq 3) { throw '通达信尚未发布本交易日数据，保留上一批排名' }
        if ($downloadExit -ne 0) { throw "通达信下载未成功（$downloadExit），保留上一批排名" }
        $temporary = "$receipt.tmp"
        @{ date = $date; phase = $slot; exitCode = 0; completedAt = [DateTimeOffset]::Now.ToUnixTimeMilliseconds() } | ConvertTo-Json | Set-Content -LiteralPath $temporary -Encoding UTF8
        Move-Item -LiteralPath $temporary -Destination $receipt -Force
    }
}
Push-Location -LiteralPath $ServerDirectory
try {
    & $node $runner --phase $slot
    exit $LASTEXITCODE
} finally { Pop-Location }
