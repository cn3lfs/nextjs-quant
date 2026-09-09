$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$releaseRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'release'))
$stagingRoot = Join-Path $releaseRoot '_next'

function Assert-ReleaseChild([string] $Path) {
    $resolved = [IO.Path]::GetFullPath($Path)
    if (-not $resolved.StartsWith($releaseRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to modify a path outside release: $resolved"
    }
    if ((Test-Path -LiteralPath $resolved) -and ((Get-Item -LiteralPath $resolved -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Refusing to modify a linked output directory: $resolved"
    }
}
function Assert-AppClosed {
    $running = Get-CimInstance Win32_Process -Filter "name = 'GuanlanQuant.exe'" | Where-Object {
        $_.ExecutablePath -and $_.ExecutablePath.StartsWith($releaseRoot + '\', [StringComparison]::OrdinalIgnoreCase)
    }
    if ($running) { throw 'Please exit GuanlanQuant before packaging. Existing releases have been preserved.' }
}
function Retry-OutputOperation([scriptblock] $Operation) {
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        try { & $Operation; return } catch {
            if ($attempt -eq 9) { throw }
            Start-Sleep -Seconds 2
        }
    }
}

Push-Location $projectRoot
try {
    Assert-AppClosed
    Assert-ReleaseChild $stagingRoot
    if (Test-Path -LiteralPath $stagingRoot) { Remove-Item -LiteralPath $stagingRoot -Recurse -Force }
    & pnpm build
    if ($LASTEXITCODE -ne 0) { throw 'Production build failed; existing releases preserved.' }
    & pnpm desktop:prepare
    if ($LASTEXITCODE -ne 0) { throw 'Desktop preparation failed; existing releases preserved.' }
    & pnpm exec electron-builder --win --dir '--config.directories.output=release/_next'
    if ($LASTEXITCODE -ne 0) { throw 'Desktop packaging failed; existing releases preserved.' }
    if (-not (Test-Path -LiteralPath (Join-Path $stagingRoot 'win-unpacked\GuanlanQuant.exe'))) { throw 'Packaged executable missing.' }
    Assert-AppClosed
    $oldOutputs = @(Get-ChildItem -LiteralPath $releaseRoot -Force | Where-Object { $_.FullName -ne $stagingRoot })
    foreach ($entry in $oldOutputs) { Assert-ReleaseChild $entry.FullName }
    foreach ($entry in $oldOutputs) { Retry-OutputOperation { Remove-Item -LiteralPath $entry.FullName -Recurse -Force } }
    foreach ($entry in Get-ChildItem -LiteralPath $stagingRoot -Force) {
        Assert-ReleaseChild $entry.FullName
        $destination = Join-Path $releaseRoot $entry.Name
        Assert-ReleaseChild $destination
        Retry-OutputOperation { Move-Item -LiteralPath $entry.FullName -Destination $destination }
    }
    Remove-Item -LiteralPath $stagingRoot -Force
    Write-Host 'Latest desktop: release\win-unpacked\GuanlanQuant.exe'
} finally {
    Pop-Location
}
