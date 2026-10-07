@echo off
rem ============================================================
rem  Lennart Terminal - one-click launcher (no install needed)
rem  Uses the bundled Electron binary directly.
rem ============================================================
setlocal
set "ROOT=%~dp0"

if not exist "%ROOT%node_modules\electron\dist\electron.exe" (
  echo [Lennart Terminal] Dependencies missing. Run once:
  echo    npm install
  echo and then start again.
  pause
  exit /b 1
)

rem Portable mode: a Data folder next to the app keeps settings, history and
rem the embedded local AI on this drive (e.g. a USB stick).
if not exist "%ROOT%Data\" mkdir "%ROOT%Data"
set "LENNART_DATA_DIR=%ROOT%Data"

start "" "%ROOT%node_modules\electron\dist\electron.exe" "%ROOT%."
endlocal
