@echo off
rem ============================================================
rem  Lennart Terminal - one-click launcher
rem
rem  Works no matter how you got this folder:
rem   1. Source code with "npm install" done  -> runs from source
rem   2. Otherwise (e.g. GitHub "Download ZIP") -> uses the ready
rem      made EXE. If it is not here yet, it is downloaded ONCE
rem      from the latest GitHub release and started.
rem ============================================================
setlocal
set "ROOT=%~dp0"
set "EXE=%ROOT%LennartTerminal-portable.exe"
set "URL=https://github.com/h4xtor/Lennart-Terminal/releases/latest/download/LennartTerminal-portable.exe"

rem --- 1. developer setup: run straight from the source code ---------
if exist "%ROOT%node_modules\electron\dist\electron.exe" goto run_source

rem --- 2. the finished program --------------------------------------
if exist "%EXE%" goto run_exe

echo.
echo  Lennart Terminal
echo  ----------------
echo  Henter det faerdige program foerste gang (ca. 70 MB)...
echo  Det sker kun denne ene gang.
echo.

rem curl.exe is built into Windows 10/11; PowerShell is the fallback
where curl.exe >nul 2>nul
if errorlevel 1 goto download_ps
curl.exe -L --fail --progress-bar -o "%EXE%.part" "%URL%"
if errorlevel 1 goto download_ps
goto download_done

:download_ps
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri '%URL%' -OutFile '%EXE%.part'"
if errorlevel 1 goto download_failed

:download_done
rem a finished download is at least several MB - anything smaller is an error page
for %%F in ("%EXE%.part") do if %%~zF LSS 5000000 goto download_failed
move /y "%EXE%.part" "%EXE%" >nul
echo  Faerdig! Starter Lennart Terminal...
goto run_exe

:download_failed
if exist "%EXE%.part" del /q "%EXE%.part"
echo.
echo  [Lennart Terminal] Kunne ikke hente programmet.
echo  Tjek internetforbindelsen, eller hent det selv her:
echo    %URL%
echo  Laeg filen i denne mappe og start igen.
echo.
pause
exit /b 1

:run_exe
rem The EXE keeps settings, history and the offline AI in a Data
rem folder next to itself (works from a USB stick).
start "" "%EXE%"
exit /b 0

:run_source
if not exist "%ROOT%Data\" mkdir "%ROOT%Data"
set "LENNART_DATA_DIR=%ROOT%Data"
start "" "%ROOT%node_modules\electron\dist\electron.exe" "%ROOT%."
exit /b 0
