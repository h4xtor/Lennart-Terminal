@echo off
rem ============================================================
rem  Lennart Terminal - one-click launcher (no install needed)
rem  Uses the bundled Electron binary directly.
rem ============================================================
setlocal
set "ROOT=%~dp0"

if not exist "%ROOT%node_modules\electron\dist\electron.exe" (
  echo [Lennart Terminal] Dependencies missing. Run once:
  echo    tools\node-v24.19.0-win-x64\npm.cmd install
  echo and then start again.
  pause
  exit /b 1
)

start "" "%ROOT%node_modules\electron\dist\electron.exe" "%ROOT%."
endlocal
