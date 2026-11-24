$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$releaseRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'release'))
$stagingRoot = Join-Path $releaseRoot '_next'
$backupRoot = Join-Path $releaseRoot '_prev'

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

function Assert-NoEnvFiles([string] $Directory) {
    $envFile = Get-ChildItem -LiteralPath $Directory -Recurse -Force |
        Where-Object { $_.Name -match '^\.env(?:\.|$)' } | Select-Object -First 1
    if ($envFile) { throw "Environment file in desktop output: $($envFile.FullName). Existing releases preserved." }
}

function Move-ReleaseOutput([string] $Source, [string] $Destination) {
    Assert-ReleaseChild $Source
    Assert-ReleaseChild $Destination
    Retry-OutputOperation {
        if (Test-Path -LiteralPath $Destination) { throw "Release destination already exists: $Destination" }
        Move-Item -LiteralPath $Source -Destination $Destination
    }
}

function Assert-NoPendingReleaseRecovery {
    Assert-ReleaseChild $backupRoot
    if (Test-Path -LiteralPath $backupRoot) {
        throw "Recover the previous release from '$backupRoot' and move the backup out of release before packaging again."
    }
    if (Test-Path -LiteralPath $releaseRoot) {
        $quarantined = @(Get-ChildItem -LiteralPath $releaseRoot -Force -Filter '_rollback_stuck_*')
        if ($quarantined.Count) {
            throw "Review quarantined outputs and move them out of release before packaging again: $($quarantined.FullName -join ' | ')"
        }
    }
}

function Publish-StagedRelease {
    Assert-NoPendingReleaseRecovery
    $oldOutputs = @(Get-ChildItem -LiteralPath $releaseRoot -Force | Where-Object { $_.FullName -ne $stagingRoot })
    # Publish the executable directory only after the other entries are in place.
    $newOutputs = @(Get-ChildItem -LiteralPath $stagingRoot -Force |
        Sort-Object { if ($_.Name -eq 'win-unpacked') { 1 } else { 0 } }, Name)
    foreach ($entry in ($oldOutputs + $newOutputs)) {
        Assert-ReleaseChild $entry.FullName
        if ($entry.Name -in @('_next', '_prev') -or $entry.Name -like '_rollback_stuck_*') {
            throw "Reserved release output name: $($entry.Name)"
        }
    }
    New-Item -ItemType Directory -Path $backupRoot | Out-Null
    $saved = @()
    $published = @()
    try {
        foreach ($entry in $oldOutputs) {
            Move-ReleaseOutput $entry.FullName (Join-Path $backupRoot $entry.Name)
            $saved += $entry
        }
        foreach ($entry in $newOutputs) {
            Move-ReleaseOutput $entry.FullName (Join-Path $releaseRoot $entry.Name)
            $published += $entry
        }
    } catch {
        $publishError = $_
        $rollbackErrors = @()
        $quarantined = @()
        $locked = @()
        foreach ($entry in $published) {
            $publishedPath = Join-Path $releaseRoot $entry.Name
            try { Move-ReleaseOutput $publishedPath $entry.FullName }
            catch {
                $restageError = $_.Exception.Message
                $quarantineName = "_rollback_stuck_$([Guid]::NewGuid().ToString('N'))_$($entry.Name)"
                $quarantinePath = Join-Path $releaseRoot $quarantineName
                try {
                    Assert-ReleaseChild $publishedPath
                    Assert-ReleaseChild $quarantinePath
                    Retry-OutputOperation { Rename-Item -LiteralPath $publishedPath -NewName $quarantineName }
                    $quarantined += $quarantinePath
                } catch {
                    $locked += $entry.Name
                    $rollbackErrors += "Could not move '$publishedPath' back to staging or quarantine it: $restageError | $($_.Exception.Message)"
                }
            }
        }
        if ($locked.Count) {
            # Copy recoverable entries so _prev still holds the entire previous release.
            foreach ($entry in $saved) {
                if ($entry.Name -in $locked) { continue }
                $savedPath = Join-Path $backupRoot $entry.Name
                try {
                    Assert-ReleaseChild $savedPath
                    Assert-ReleaseChild $entry.FullName
                    Retry-OutputOperation {
                        if (Test-Path -LiteralPath $entry.FullName) { throw "Release destination already exists: $($entry.FullName)" }
                        Copy-Item -LiteralPath $savedPath -Destination $entry.FullName -Recurse -Force
                    }
                } catch { $rollbackErrors += $_.Exception.Message }
            }
            throw "Release swap failed: $publishError. Close processes locking $($locked -join ', '), then move the locked outputs out of release and restore the previous release from '$backupRoot'. Keep this recovery directory until the previous release is restored. $($rollbackErrors -join ' | ')"
        }
        foreach ($entry in $saved) {
            try { Move-ReleaseOutput (Join-Path $backupRoot $entry.Name) $entry.FullName }
            catch { $rollbackErrors += $_.Exception.Message }
        }
        if ($rollbackErrors.Count) {
            throw "Release swap failed: $publishError. Rollback incomplete. Recover preserved outputs from '$backupRoot': $($rollbackErrors -join ' | ')"
        }
        Remove-Item -LiteralPath $backupRoot -Force
        if ($quarantined.Count) {
            throw "Release swap failed: $publishError. Previous release restored. Review and move quarantined outputs out of release before packaging again: $($quarantined -join ' | ')"
        }
        throw $publishError
    }
    Retry-OutputOperation { Remove-Item -LiteralPath $backupRoot -Recurse -Force }
    Remove-Item -LiteralPath $stagingRoot -Force
}

# Keep the shared staging directory and backup owned by one packaging process.
$sha = [Security.Cryptography.SHA256]::Create()
try {
    $lockKey = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($releaseRoot.ToUpperInvariant())))
} finally {
    $sha.Dispose()
}
$packLock = New-Object Threading.Mutex($false, "Local\GuanlanQuant-Pack-$lockKey")
$lockHeld = $false
Push-Location $projectRoot
try {
    try { $lockHeld = $packLock.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $lockHeld = $true }
    if (-not $lockHeld) { throw 'Desktop packaging is already running for this checkout.' }
    if ((Test-Path -LiteralPath $releaseRoot) -and ((Get-Item -LiteralPath $releaseRoot -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Refusing to modify a linked release directory: $releaseRoot"
    }
    Assert-NoPendingReleaseRecovery
    Assert-AppClosed
    $modulesManifest = Join-Path $projectRoot 'node_modules\.modules.yaml'
    if (-not (Test-Path -LiteralPath $modulesManifest) -or
        (Get-Content -LiteralPath $modulesManifest -Raw) -notmatch '(?m)^nodeLinker: hoisted\s*$') {
        throw 'Desktop packaging requires hoisted dependencies. Run pnpm install --frozen-lockfile first. Existing releases preserved.'
    }
    Assert-ReleaseChild $stagingRoot
    if (Test-Path -LiteralPath $stagingRoot) { Remove-Item -LiteralPath $stagingRoot -Recurse -Force }
    & pnpm build
    if ($LASTEXITCODE -ne 0) { throw 'Production build failed; existing releases preserved.' }
    & pnpm desktop:prepare
    if ($LASTEXITCODE -ne 0) { throw 'Desktop preparation failed; existing releases preserved.' }
    Assert-NoEnvFiles (Join-Path $projectRoot '.next\standalone')
    & pnpm exec electron-builder --win --dir '--config.directories.output=release/_next'
    if ($LASTEXITCODE -ne 0) { throw 'Desktop packaging failed; existing releases preserved.' }
    if (-not (Test-Path -LiteralPath (Join-Path $stagingRoot 'win-unpacked\GuanlanQuant.exe'))) { throw 'Packaged executable missing.' }
    $packagedServer = Join-Path $stagingRoot 'win-unpacked\resources\server'
    foreach ($directory in @($stagingRoot, (Join-Path $stagingRoot 'win-unpacked'), (Split-Path $packagedServer), $packagedServer)) {
        Assert-ReleaseChild $directory
    }
    foreach ($dependency in @('next', 'react', 'react-dom')) {
        if (-not (Test-Path -LiteralPath (Join-Path $packagedServer "node_modules\$dependency\package.json"))) {
            throw "Packaged server dependency missing: $dependency. Existing releases preserved."
        }
    }
    $packagedLinks = @(Get-ChildItem -LiteralPath $packagedServer -Recurse -Force -Attributes ReparsePoint)
    if ($packagedLinks.Count) { throw 'Packaged server still contains links; existing releases preserved.' }
    Assert-NoEnvFiles $packagedServer
    Assert-AppClosed
    Publish-StagedRelease
    Write-Host 'Latest desktop: release\win-unpacked\GuanlanQuant.exe'
} finally {
    Pop-Location
    if ($lockHeld) { $packLock.ReleaseMutex() }
    $packLock.Dispose()
}
