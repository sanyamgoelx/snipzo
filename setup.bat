@echo off
title Setting up Snipzo
cd /d "%~dp0"
echo Installing dependencies (first time only)...
call npm install > setup.log 2>&1
if errorlevel 1 (echo failed > setup-status.txt & echo Setup failed, see setup.log & pause & exit /b 1)
echo ok > setup-status.txt
echo Done. Start Snipzo with run.vbs
exit /b 0
