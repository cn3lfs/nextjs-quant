param(
    [string]$TdxRoot = 'E:/new_tdx64',
    [string]$Replay = ''
)
$ErrorActionPreference = 'Stop'
$previousDataDir = $env:QUANT_DATA_DIR
$previousTdxRoot = $env:TDX_ROOT
Push-Location (Split-Path $PSScriptRoot -Parent)
try {
    $env:QUANT_DATA_DIR = Join-Path (Get-Location) ('.data/csi800-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    $env:TDX_ROOT = $TdxRoot
    & pnpm performance:build
    if ($LASTEXITCODE -ne 0) { throw '绩效模块构建失败' }
    if ($Replay) { & pnpm exec tsx scripts/backtest-csi800.ts $Replay }
    else { & pnpm exec tsx scripts/backtest-csi800.ts }
    if ($LASTEXITCODE -ne 0) { throw '研究运行失败' }
}
finally {
    $env:QUANT_DATA_DIR = $previousDataDir
    $env:TDX_ROOT = $previousTdxRoot
    Pop-Location
}
