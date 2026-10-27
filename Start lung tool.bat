@echo off
rem Double-click on Windows: installs what is missing (skipped when already done), then starts the tool. Research use only.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0lung.ps1" setup
if errorlevel 1 (
  echo.
  echo Something went wrong. Read the message above, then press a key to close.
  if not defined CI pause
  exit /b 1
)
