param(
    [string]$PriceInput = '',
    [string]$TdxRoot = 'E:/new_tdx64',
    [string]$Replay = ''
)
$ErrorActionPreference = 'Stop'
$previousDataDir = $env:QUANT_DATA_DIR
Push-Location (Split-Path $PSScriptRoot -Parent)
try {
    $env:QUANT_DATA_DIR = Join-Path (Get-Location) ('.data/csi800-factors-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    & pnpm tstdx:build
    if ($LASTEXITCODE -ne 0) { throw 'tstdx构建失败' }
    & pnpm trading-strategy-core:build
    if ($LASTEXITCODE -ne 0) { throw '共享计算构建失败' }
    & pnpm performance:build
    if ($LASTEXITCODE -ne 0) { throw '绩效模块构建失败' }
    if ($Replay) {
        & pnpm exec tsx scripts/run-prepared-csi800-factors.ts $Replay
    }
    else {
        if (!$PriceInput) {
            $source = Get-ChildItem -LiteralPath '.data' -Directory |
                Where-Object { $_.Name -match '^csi800-\d{8}-\d{6}$' -and (Test-Path -LiteralPath (Join-Path $_.FullName 'csi800-study/input.json')) } |
                Sort-Object Name -Descending | Select-Object -First 1
            if (!$source) { throw '未找到价格冻结输入，请先运行run-csi800-study.ps1，或用-PriceInput指定已有input.json' }
            $PriceInput = Join-Path $source.FullName 'csi800-study/input.json'
        }
        & pnpm exec tsx scripts/research-csi800-factors.ts --input $PriceInput --root $TdxRoot
    }
    if ($LASTEXITCODE -ne 0) { throw '研究未完成，请检查该次隔离目录的进度和失败记录' }
}
finally {
    $env:QUANT_DATA_DIR = $previousDataDir
    Pop-Location
}
