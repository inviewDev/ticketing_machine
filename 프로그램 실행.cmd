@echo off
setlocal
title Ticketing Assistant
cd /d "%~dp0ticket-assistant"

rem Exit 0: current version, 2: older Ticketing Assistant, 1: not running.
powershell.exe -NoProfile -NonInteractive -Command "try { $r = Invoke-RestMethod -Uri 'http://127.0.0.1:4318/api/health' -TimeoutSec 2; if ($r.ok -and $r.app -eq 'ticket-assistant' -and $r.revision -eq 'melon-opening-10') { exit 0 }; if ($r.ok -and $r.app -eq 'ticket-assistant') { exit 2 }; exit 1 } catch { exit 1 }" >nul 2>&1
if errorlevel 2 goto outdated
if errorlevel 1 goto launch

:running
echo Ticketing Assistant is already running. Opening the existing window.
start "" "http://127.0.0.1:5174/"
exit /b 0

:outdated
echo An older Ticketing Assistant server is still running.
echo Close the original black console window, then run this file again.
pause
exit /b 2

:launch
if exist "node_modules\vite\package.json" goto start
echo Installing dependencies...
call npm.cmd install
if errorlevel 1 goto failed

:start
echo Starting Ticketing Assistant at http://127.0.0.1:5174/
call npm.cmd run dev -- --open
if errorlevel 1 goto failed
exit /b 0

:failed
echo Ticketing Assistant could not be started. Review the message above.
pause
exit /b 1
