$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$nativeOutput = Join-Path $taskRoot 'runtime\tdx-import'
New-Item -ItemType Directory -Path $nativeOutput -Force | Out-Null
& clang -O2 -ffp-contract=off -fno-builtin -fno-stack-protector -fuse-ld=lld -shared -nostdlib (Join-Path $taskRoot 'native\tdx-import\wdz.c') '-Wl,/noentry' '-Wl,/nodefaultlib' -o (Join-Path $nativeOutput 'wdz-decode.dll')
if ($LASTEXITCODE -ne 0) { throw 'C WDZ decoder build failed' }
