param(
    [string]$ServerDirectory = (Join-Path (Split-Path $PSScriptRoot -Parent) 'release\win-unpacked\resources\server'),
    [string]$DataDirectory = (Join-Path $env:LOCALAPPDATA 'QuantWorkbench'),
    [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
$server = (Resolve-Path -LiteralPath $ServerDirectory).Path
$node = Join-Path $server 'node-runtime\node.exe'
$runner = Join-Path $server 'runtime\workflow-runner.cjs'
if (!(Test-Path -LiteralPath $node -PathType Leaf) -or !(Test-Path -LiteralPath $runner -PathType Leaf)) {
    throw '运行包不完整：缺少 bundled Node 或工作流入口，未启动收盘任务'
}
# Read-only compatibility check: do not launch an old runner which may open or
# migrate the shared database before rejecting an unknown argument.
if (!(Get-Content -LiteralPath $runner -Raw -Encoding UTF8).Contains('--close-rps-increment')) {
    throw '运行包尚不支持收盘增量，请更新并验证桌面包后再切换任务'
}
if ($CheckOnly) {
    @{ status = 'ready'; server = $server; data = $DataDirectory; command = '--close-rps-increment' } | ConvertTo-Json -Compress
    exit 0
}
$previousData = $env:QUANT_DATA_DIR
$env:QUANT_DATA_DIR = [IO.Path]::GetFullPath($DataDirectory)
Push-Location -LiteralPath $server
try {
    & $node $runner --close-rps-increment
    # 0 completed/reused, 2 not ready; never turn a pending publication into success.
    $resultCode = $LASTEXITCODE
} finally {
    Pop-Location
    $env:QUANT_DATA_DIR = $previousData
}
exit $resultCode
