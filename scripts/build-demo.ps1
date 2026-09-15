param(
  [switch]$NoLaunch
)

# Builds "FileTree Demo": the desktop app with every backend command answered
# from invented data (frontend/src/demo), its own app identity and WebView
# profile, and FileTree's data folders redirected to %TEMP%\FileTree-Demo.
# It never reads or changes your real scans, settings or compression queue.
#
# The demo compiles into its own target\demo folder so it never replaces (or
# is blocked by) the regular target\release\FileTree.exe.

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$outDir = Join-Path $repoRoot "dist-demo\FileTree Demo"
$env:CARGO_TARGET_DIR = Join-Path $repoRoot "target\demo"
$exe = Join-Path $env:CARGO_TARGET_DIR "release\FileTree.exe"

Push-Location $repoRoot
try {
  & npm.cmd run build -- --features demo --config src-tauri/tauri.demo.conf.json
  if ($LASTEXITCODE -ne 0) { throw "Demo build failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

if (!(Test-Path -LiteralPath $exe)) { throw "Demo executable not found: $exe" }
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$demoExe = Join-Path $outDir "FileTree Demo.exe"
Copy-Item -LiteralPath $exe -Destination $demoExe -Force

@"
FileTree Demo

Every drive, folder, file, compression run and download shown here is made up.
The demo never reads or changes anything on this PC. Use it for screenshots.
"@ | Set-Content -LiteralPath (Join-Path $outDir "README.txt") -Encoding UTF8

Write-Host ""
Write-Host "Demo app created:"
Write-Host "  $demoExe"
if (!$NoLaunch) { Start-Process -FilePath $demoExe -WorkingDirectory $outDir }
