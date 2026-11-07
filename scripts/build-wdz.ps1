$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
& (Join-Path $taskRoot 'packages/tstdx/native/build.ps1') -OutputDirectory (Join-Path $taskRoot 'runtime/tdx-import') -OnlyWdz
