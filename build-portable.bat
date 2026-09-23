@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-portable.ps1" %*
set "code=%ERRORLEVEL%"
rem Keep the window open on failure so the error can be read.
if not "%code%"=="0" (
  echo.
  echo Build failed with exit code %code%.
  pause
)
exit /b %code%
