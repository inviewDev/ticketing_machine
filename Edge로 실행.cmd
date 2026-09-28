@echo off
setlocal
set "TICKET_ASSISTANT_BROWSER=edge"
title Ticketing Assistant - Edge
cd /d "%~dp0ticket-assistant"

powershell.exe -NoProfile -NonInteractive -Command "try { $r = Invoke-RestMethod -Uri 'http://127.0.0.1:4318/api/health' -TimeoutSec 2; if ($r.ok -and $r.app -eq 'ticket-assistant' -and $r.revision -eq 'melon-opening-10') { exit 0 }; if ($r.ok -and $r.app -eq 'ticket-assistant') { exit 2 }; exit 1 } catch { exit 1 }" >nul 2>&1
if errorlevel 2 goto outdated
if errorlevel 1 goto launch

:running
echo Ticketing Assistant is already running. Close it before changing browsers.
pause
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
echo Starting Ticketing Assistant with Microsoft Edge at http://127.0.0.1:5174/
call npm.cmd run dev -- --open
if errorlevel 1 goto failed
exit /b 0

:failed
echo Ticketing Assistant could not be started. Review the message above.
pause
exit /b 1
