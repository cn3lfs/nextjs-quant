param([string]$OutputDirectory = (Join-Path $PSScriptRoot 'bin'), [switch]$OnlyWdz)
$ErrorActionPreference = 'Stop'
$nativeOutput = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $nativeOutput -Force | Out-Null
if (-not $OnlyWdz) {
  foreach ($name in @('merge','probe','audit')) {
    & clang -O2 -fno-builtin -fno-stack-protector -fuse-ld=lld -shared -nostdlib (Join-Path $PSScriptRoot "$name.c") '-Wl,/noentry' '-Wl,/nodefaultlib' -o (Join-Path $nativeOutput "$name.dll")
    if ($LASTEXITCODE -ne 0) { throw "C $name build failed" }
  }
}
& clang -O2 -ffp-contract=off -fno-builtin -fno-stack-protector -fuse-ld=lld -shared -nostdlib (Join-Path $PSScriptRoot 'wdz.c') '-Wl,/noentry' '-Wl,/nodefaultlib' -o (Join-Path $nativeOutput 'wdz-decode.dll')
if ($LASTEXITCODE -ne 0) { throw 'C WDZ decoder build failed' }
