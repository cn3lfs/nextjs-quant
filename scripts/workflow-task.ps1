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
    # The daily package is only refreshed after the close, so download once at
    # 16:00. The noon batch observes only and must not touch the source files.
    $time = Get-Date -Format 'HH:mm'
    # The external UTF-8 script may have no BOM. Windows PowerShell 5 -File
    # then decodes Chinese text as ANSI and fails before creating its log.
    $previousDownloader = $env:QUANT_TDX_DOWNLOADER
    $previousMarketOnly = $env:QUANT_TDX_MARKET_ONLY
    $env:QUANT_TDX_DOWNLOADER = $DownloaderPath
    $env:QUANT_TDX_MARKET_ONLY = if ($time -lt '20:00') { '1' } else { '0' }
    $loader = '$script = [ScriptBlock]::Create([IO.File]::ReadAllText($env:QUANT_TDX_DOWNLOADER, [Text.Encoding]::UTF8)); if ($env:QUANT_TDX_MARKET_ONLY -eq "1") { & $script -MarketOnly } else { & $script }'
    try {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($loader)))
        $downloadExit = $LASTEXITCODE
    } finally {
        $env:QUANT_TDX_DOWNLOADER = $previousDownloader
        $env:QUANT_TDX_MARKET_ONLY = $previousMarketOnly
    }
    if ($downloadExit -ne 0) { throw "通达信下载未成功（$downloadExit），保留上一批排名" }
    New-Item -ItemType Directory -Path $DataDirectory -Force | Out-Null
    $receipt = Join-Path $DataDirectory "download-$date-$slot.json"
    $temporary = "$receipt.tmp"
    @{ date = $date; phase = $slot; exitCode = 0; completedAt = [DateTimeOffset]::Now.ToUnixTimeMilliseconds() } | ConvertTo-Json | Set-Content -LiteralPath $temporary -Encoding UTF8
    Move-Item -LiteralPath $temporary -Destination $receipt -Force
}
Push-Location -LiteralPath $ServerDirectory
try {
    & $node $runner --phase $slot
    exit $LASTEXITCODE
} finally { Pop-Location }
