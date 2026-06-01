param(
  [switch]$SkipInstall,
  [switch]$NoLaunch
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$frontendDir = Join-Path $repoRoot "frontend"
$electronDir = Join-Path $repoRoot "electron"
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

if (Test-Path $portableDir) {
  Remove-Item -LiteralPath $portableDir -Recurse -Force
}

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

foreach ($fileName in @("README.md", "NOTICE", "VERSION")) {
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

Use -NoLaunch to build without starting FileTree afterward.
"@ | Set-Content -LiteralPath $readmePath -Encoding UTF8

Write-Host ""
Write-Host "Portable Electron app created:"
Write-Host "  $portableExe"

if (!$NoLaunch) {
  Write-Host ""
  Write-Host "Starting FileTree..."
  Start-Process -FilePath $portableExe -WorkingDirectory $portableDir
}
