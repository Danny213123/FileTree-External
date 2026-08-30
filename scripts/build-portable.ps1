param(
  [switch]$SkipInstall,
  [switch]$NoLaunch,
  [switch]$Clean
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$frontendDir = Join-Path $repoRoot "frontend"
$portableRoot = Join-Path $repoRoot "dist-portable"
$portableDir = Join-Path $portableRoot "FileTree"
$desktopExe = Join-Path $repoRoot "target\release\FileTree.exe"
$cliExe = Join-Path $repoRoot "target\release\filetree-cli.exe"

function Invoke-Checked {
  param([string]$Label, [string]$Command, [string[]]$Arguments, [string]$WorkingDirectory)
  Write-Host ""
  Write-Host "==> $Label"
  Push-Location $WorkingDirectory
  try {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
}

function Remove-PathSafe {
  param([string]$Path, [string]$Label)
  if (!(Test-Path -LiteralPath $Path)) { return }
  $resolved = (Resolve-Path -LiteralPath $Path).Path
  if (!$resolved.StartsWith($repoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove $Label outside the v2 worktree: $resolved"
  }
  Write-Host "==> Removing stale $Label"
  Remove-Item -LiteralPath $resolved -Recurse -Force
}

function Ensure-Dependencies {
  param([string]$Directory, [string]$Label)
  if ($SkipInstall) { return }
  $nodeModules = Join-Path $Directory "node_modules"
  $installedLock = Join-Path $nodeModules ".package-lock.json"
  $packageLock = Join-Path $Directory "package-lock.json"
  $needsInstall = !(Test-Path $nodeModules) -or !(Test-Path $installedLock)
  if (!$needsInstall -and (Test-Path $packageLock)) {
    $needsInstall = (Get-Item $packageLock).LastWriteTimeUtc -gt (Get-Item $installedLock).LastWriteTimeUtc
  }
  if ($needsInstall) { Invoke-Checked $Label "npm.cmd" @("ci") $Directory }
}

if ($Clean) {
  Invoke-Checked "Clean Cargo workspace" "cargo" @("clean") $repoRoot
} else {
  foreach ($package in @("filetree-core", "filetree-cli", "filetree-desktop")) {
    Invoke-Checked "Refresh $package" "cargo" @("clean", "-p", $package) $repoRoot
  }
}

Remove-PathSafe (Join-Path $frontendDir "dist") "frontend/dist"
Remove-PathSafe $portableRoot "dist-portable"
Ensure-Dependencies $repoRoot "Install Tauri build dependencies"
Ensure-Dependencies $frontendDir "Install frontend dependencies"

Invoke-Checked "Build FileTree Tauri desktop and installer" "npm.cmd" @("run", "build") $repoRoot
Invoke-Checked "Build FileTree CLI" "cargo" @("build", "--release", "-p", "filetree-cli") $repoRoot

if (!(Test-Path -LiteralPath $desktopExe)) { throw "Tauri desktop executable not found: $desktopExe" }
if (!(Test-Path -LiteralPath $cliExe)) { throw "CLI executable not found: $cliExe" }

New-Item -ItemType Directory -Force -Path $portableDir | Out-Null
Copy-Item -LiteralPath $desktopExe -Destination (Join-Path $portableDir "FileTree.exe") -Force
Copy-Item -LiteralPath $cliExe -Destination (Join-Path $portableDir "filetree-cli.exe") -Force

foreach ($fileName in @("README.md", "LICENSE", "NOTICE", "VERSION")) {
  $source = Join-Path $repoRoot $fileName
  if (Test-Path -LiteralPath $source) {
    Copy-Item -LiteralPath $source -Destination $portableDir -Force
  }
}

@"
FileTree v2 Portable

Run FileTree.exe. FileTree v2 uses the Windows WebView2 runtime included with
current Windows 10/11 systems; it no longer bundles Electron or starts a local
desktop HTTP server.

filetree-cli.exe contains the headless scan and opt-in `serve` workflows.
"@ | Set-Content -LiteralPath (Join-Path $portableDir "PORTABLE-README.txt") -Encoding UTF8

$portableExe = Join-Path $portableDir "FileTree.exe"
Write-Host ""
Write-Host "Portable Tauri app created:"
Write-Host "  $portableExe"

if (!$NoLaunch) {
  Write-Host "Starting FileTree..."
  Start-Process -FilePath $portableExe -WorkingDirectory $portableDir
}
