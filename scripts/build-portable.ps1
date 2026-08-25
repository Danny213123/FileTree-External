param(
  [switch]$SkipInstall,
  [switch]$NoLaunch,
  # Full `cargo clean` (purges the entire target/ cache and recompiles ALL
  # dependencies — slow but maximally fresh). Regardless of this switch the build
  # ALWAYS runs `cargo clean -p filetree` so our own crate and the embedded
  # frontend assets can never be stale.
  [switch]$Clean
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$frontendDir = Join-Path $repoRoot "frontend"
$electronDir = Join-Path $repoRoot "electron"
$frontendDist = Join-Path $frontendDir "dist"
$electronDist = Join-Path $electronDir "dist"
$electronRuntimeDir = Join-Path $electronDir "node_modules\electron\dist"
$serverExe = Join-Path $repoRoot "target\release\filetree.exe"
$portableRoot = Join-Path $repoRoot "dist-portable"
$portableDir = Join-Path $portableRoot "FileTree"
$resourcesDir = Join-Path $portableDir "resources"
$appDir = Join-Path $resourcesDir "app"

function Invoke-Checked {
  param(
    [string]$Label,
    [string]$Command,
    [string[]]$Arguments,
    [string]$WorkingDirectory
  )

  Write-Host ""
  Write-Host "==> $Label"
  Push-Location $WorkingDirectory
  try {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "$Label failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
}

function Remove-PathSafe {
  param(
    [string]$Path,
    [string]$Label
  )

  if (Test-Path -LiteralPath $Path) {
    Write-Host "==> Removing stale $Label"
    Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
  }
}

function Ensure-NodeDependencies {
  param(
    [string]$Directory,
    [string]$Label
  )

  if ($SkipInstall) {
    return
  }

  $nodeModulesDir = Join-Path $Directory "node_modules"
  $installedLock = Join-Path $nodeModulesDir ".package-lock.json"
  $packageLock = Join-Path $Directory "package-lock.json"
  $packageJson = Join-Path $Directory "package.json"

  $needsInstall = !(Test-Path $nodeModulesDir) -or !(Test-Path $installedLock)
  if (!$needsInstall -and (Test-Path $packageLock)) {
    $needsInstall = (Get-Item $packageLock).LastWriteTimeUtc -gt (Get-Item $installedLock).LastWriteTimeUtc
  }
  if (!$needsInstall -and (Test-Path $packageJson)) {
    $needsInstall = (Get-Item $packageJson).LastWriteTimeUtc -gt (Get-Item $installedLock).LastWriteTimeUtc
  }

  if ($needsInstall) {
    Invoke-Checked $Label "npm.cmd" @("ci") $Directory
  }
}

if (!(Test-Path $frontendDir)) {
  throw "Missing frontend directory: $frontendDir"
}
if (!(Test-Path $electronDir)) {
  throw "Missing electron directory: $electronDir"
}

# Purge stale build artifacts so a rebuild can never ship an old binary/assets.
# A full `cargo clean` (opt-in via -Clean) recompiles every dependency; the
# targeted `cargo clean -p filetree` always runs so our crate — which embeds the
# freshly built frontend assets — is rebuilt from current source.
if ($Clean) {
  Invoke-Checked "Clean entire cargo target (full rebuild; recompiles ALL dependencies)" "cargo" @("clean") $repoRoot
}
Invoke-Checked "Clean filetree crate (refresh embedded assets)" "cargo" @("clean", "-p", "filetree") $repoRoot

# Remove compiled frontend/electron output before rebuilding so no stale asset
# survives into the package.
Remove-PathSafe $frontendDist "frontend/dist"
Remove-PathSafe $electronDist "electron/dist"
# Remove the whole portable output root (not just the FileTree subfolder) so no
# leftover packaged exe/resources remain.
Remove-PathSafe $portableRoot "dist-portable"

Ensure-NodeDependencies $frontendDir "Install frontend dependencies"
Ensure-NodeDependencies $electronDir "Install Electron dependencies"

Invoke-Checked "Build frontend assets" "npm.cmd" @("run", "build") $frontendDir
Invoke-Checked "Build Rust server" "cargo" @("build", "--release") $repoRoot
Invoke-Checked "Build Electron main/preload" "npm.cmd" @("run", "build") $electronDir

if (!(Test-Path $electronRuntimeDir)) {
  throw "Electron runtime not found. Run npm install in electron/ or rerun without -SkipInstall."
}
if (!(Test-Path $serverExe)) {
  throw "Rust server binary not found after build: $serverExe"
}

# The portable root was already purged above; (re)create the FileTree subfolder.
New-Item -ItemType Directory -Force -Path $portableDir | Out-Null
Copy-Item -Path (Join-Path $electronRuntimeDir "*") -Destination $portableDir -Recurse -Force

$defaultElectronExe = Join-Path $portableDir "electron.exe"
$portableExe = Join-Path $portableDir "FileTree.exe"
if (!(Test-Path $defaultElectronExe)) {
  throw "Electron executable was not copied: $defaultElectronExe"
}
if (Test-Path $portableExe) {
  Remove-Item -LiteralPath $portableExe -Force
}
Rename-Item -LiteralPath $defaultElectronExe -NewName "FileTree.exe"

$defaultAppAsar = Join-Path $resourcesDir "default_app.asar"
if (Test-Path $defaultAppAsar) {
  Remove-Item -LiteralPath $defaultAppAsar -Force
}

New-Item -ItemType Directory -Force -Path $appDir | Out-Null
Copy-Item -LiteralPath (Join-Path $electronDir "package.json") -Destination $appDir -Force
Copy-Item -LiteralPath (Join-Path $electronDir "dist") -Destination $appDir -Recurse -Force

$packagedServerExe = Join-Path $resourcesDir "filetree.exe"
$legacyServerExe = Join-Path $resourcesDir "filetree-server.exe"
Copy-Item -LiteralPath $serverExe -Destination $packagedServerExe -Force
Copy-Item -LiteralPath $serverExe -Destination $legacyServerExe -Force
Copy-Item -LiteralPath (Join-Path $repoRoot "assets") -Destination $resourcesDir -Recurse -Force

foreach ($fileName in @("README.md", "LICENSE", "NOTICE", "VERSION")) {
  $source = Join-Path $repoRoot $fileName
  if (Test-Path $source) {
    Copy-Item -LiteralPath $source -Destination $portableDir -Force
  }
}

$readmePath = Join-Path $portableDir "PORTABLE-README.txt"
@"
FileTree Portable

Run FileTree.exe from this folder.

This folder is self-contained for normal use. From the source repo root,
rebuild it after source changes by running:

  build-portable.bat

or:

  powershell -ExecutionPolicy Bypass -File scripts\build-portable.ps1

Every build purges stale artifacts before rebuilding: it removes frontend/dist,
electron/dist, and the dist-portable output, and always runs
"cargo clean -p filetree" so the server binary and its embedded UI are rebuilt
from current source.

Switches:
  -Clean        Full "cargo clean" first (recompiles ALL dependencies; slowest,
                maximally fresh). Use if you suspect a stale dependency build.
  -NoLaunch     Build without starting FileTree afterward.
  -SkipInstall  Skip "npm ci" dependency installs (use existing node_modules).
"@ | Set-Content -LiteralPath $readmePath -Encoding UTF8

Write-Host ""
Write-Host "Portable Electron app created:"
Write-Host "  $portableExe"

if (!$NoLaunch) {
  Write-Host ""
  Write-Host "Starting FileTree..."
  Start-Process -FilePath $portableExe -WorkingDirectory $portableDir
}
