@echo off
title Building Snipzo
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo Installing dependencies...
  echo.
  call npm install
  if errorlevel 1 goto failed
)

echo.
echo Building the app...
echo.
call npm run build
if errorlevel 1 goto failed

echo.
echo ============================================
echo  Done.
echo.
echo  dist\Snipzo-Portable-*.exe  single file, no install
echo ============================================
echo.
start "" "%~dp0dist"
pause
exit /b 0

:failed
echo.
echo ============================================
echo  Build failed. Screenshot this window.
echo ============================================
echo.
pause
exit /b 1
