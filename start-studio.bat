@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem Studio launcher (single file):
rem   1. if backend 4610 / frontend 4710 are already listening -> kill them first
rem   2. start both, each in its own minimized window
rem   3. close this window and the services keep running; run this file again to restart
rem   stop-studio.bat stops them.

set "BACKEND_PORT=4610"
set "PORT=4610"
set "STUDIO_PORT=4710"
set "LOG_DIR=%~dp0studio\logs"
set "STUDIO_LOG=%~dp0studio\logs\studio.log"
set "BACKEND_LOG=%~dp0logs\studio-backend.log"
set "NEXT_DIST_DIR=.next-studio-dev"
set "HOST=0.0.0.0"
set "STUDIO_BACKEND=http://127.0.0.1:4610"

rem Long jobs (agent + multi-candidate render) peak above the 4GB default heap.
set "NODE_OPTIONS=--max-old-space-size=8192"

echo ============================================
echo   infinite-creation Studio
echo ============================================
echo.

where node >nul 2>&1
if errorlevel 1 goto :no_node

if not exist "node_modules\next\package.json" goto :install
if not exist "node_modules\vite\bin\vite.js" goto :install
goto :prepare

:install
where pnpm >nul 2>&1
if errorlevel 1 goto :no_pnpm
echo [setup] dependencies missing, running pnpm install ...
call pnpm install --config.confirmModulesPurge=false
if errorlevel 1 goto :install_fail

:prepare
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>&1
if not exist "%~dp0logs" mkdir "%~dp0logs" >nul 2>&1

rem ---------- 1: stop anything already listening ----------
echo [1/3] Stopping running services (if any) ...
for %%P in (%BACKEND_PORT% %STUDIO_PORT%) do (
  for /f "tokens=5" %%A in ('netstat -ano -p tcp ^| findstr ":%%P" ^| findstr "LISTENING"') do (
    echo    port %%P - killing PID %%A
    taskkill /PID %%A /T /F >nul 2>&1
  )
)

rem ---------- 2: backend ----------
echo.
echo [2/3] Starting backend %BACKEND_PORT% ...
start "ic-backend" /min cmd /c "node server.js >> ""%BACKEND_LOG%"" 2>&1"
powershell -NoProfile -Command "$d=(Get-Date).AddSeconds(120); while((Get-Date) -lt $d){ if (Get-NetTCPConnection -LocalPort %BACKEND_PORT% -State Listen -ErrorAction SilentlyContinue) { exit 0 }; Start-Sleep -Seconds 2 }; exit 1" >nul 2>&1
if errorlevel 1 goto :backend_timeout
echo    backend ready

rem ---------- 3: frontend ----------
echo.
echo [3/3] Starting frontend %STUDIO_PORT% ...
start "ic-frontend" /min cmd /c "cd /d ""%~dp0studio"" && node ..\node_modules\vite\bin\vite.js --port %STUDIO_PORT% --host 0.0.0.0 >> ""%STUDIO_LOG%"" 2>&1"
powershell -NoProfile -Command "$d=(Get-Date).AddSeconds(90); while((Get-Date) -lt $d){ if (Get-NetTCPConnection -LocalPort %STUDIO_PORT% -State Listen -ErrorAction SilentlyContinue) { exit 0 }; Start-Sleep -Seconds 2 }; exit 1" >nul 2>&1
if errorlevel 1 goto :studio_timeout
echo    frontend ready

:show
echo.
echo   Studio    http://127.0.0.1:%STUDIO_PORT%
echo   Backend   http://127.0.0.1:%BACKEND_PORT%
echo.
echo   Logs
echo   %BACKEND_LOG%
echo   %STUDIO_LOG%
echo.
echo   Two minimized windows are running: ic-backend / ic-frontend.
echo   Closing this window keeps them alive. Run this file again to restart.
echo   Run stop-studio.bat to stop them.
goto :done

:no_node
echo.
echo [ERROR] node not found. Install Node.js 22 or newer.
goto :fail

:no_pnpm
echo.
echo [ERROR] pnpm not found. Run: npm i -g pnpm
goto :fail

:install_fail
echo.
echo [ERROR] pnpm install failed.
goto :fail

:backend_timeout
echo.
echo [ERROR] backend not ready in 120s. See logs\studio-backend.log
goto :fail

:studio_timeout
echo.
echo [ERROR] frontend not ready in 90s. See studio\logs\studio.log
goto :fail

:fail
echo.
if not "%IC_NO_PAUSE%"=="1" pause
exit /b 1

:done
if not "%IC_NO_PAUSE%"=="1" pause
exit /b 0
