$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$nativeOutput = Join-Path $taskRoot 'runtime\tdx-import'
New-Item -ItemType Directory -Path $nativeOutput -Force | Out-Null
& clang -O2 -fno-builtin -fno-stack-protector -fuse-ld=lld -shared -nostdlib (Join-Path $taskRoot 'native\tdx-import\merge.c') '-Wl,/noentry' '-Wl,/nodefaultlib' -o (Join-Path $nativeOutput 'merge.dll')
if ($LASTEXITCODE -ne 0) { throw 'C importer build failed' }
& clang -O2 -fno-builtin -fno-stack-protector -fuse-ld=lld -shared -nostdlib (Join-Path $taskRoot 'native\tdx-import\probe.c') '-Wl,/noentry' '-Wl,/nodefaultlib' -o (Join-Path $nativeOutput 'probe.dll')
if ($LASTEXITCODE -ne 0) { throw 'C range probe build failed' }
& clang -O2 -fno-builtin -fno-stack-protector -fuse-ld=lld -shared -nostdlib (Join-Path $taskRoot 'native\tdx-import\audit.c') '-Wl,/noentry' '-Wl,/nodefaultlib' -o (Join-Path $nativeOutput 'audit.dll')
if ($LASTEXITCODE -ne 0) { throw 'C history audit build failed' }
& (Join-Path $PSScriptRoot 'build-wdz.ps1')
