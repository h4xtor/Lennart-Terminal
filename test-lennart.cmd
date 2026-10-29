@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [FEJL] Node.js mangler. Installer Node.js 22 fra https://nodejs.org/
  pause
  exit /b 1
)

node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"
if errorlevel 1 (
  echo [FEJL] Node.js 22 eller nyere kraves. Din version:
  node -v
  pause
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo [FEJL] Afhaengigheder mangler. Kor forst:
  echo    npm ci
  pause
  exit /b 1
)

echo.
echo ============================================
echo  1/3  Syntaks
echo ============================================
call npm run check
if errorlevel 1 goto :fail

echo.
echo ============================================
echo  2/3  Automatiske tests
echo ============================================
call npm test
if errorlevel 1 goto :fail

echo.
echo ============================================
echo  3/3  UI-smoketest (Windows)
echo ============================================
call node scripts\smoke-test.js
if errorlevel 1 goto :fail

echo.
echo ============================================
echo  ALT OK - rettelserne virker
echo ============================================
pause
exit /b 0

:fail
echo.
echo ============================================
echo  TEST FEJLEDE - se output ovenfor
echo ============================================
pause
exit /b 1
