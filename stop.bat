@echo off
:: ============================================================
::  stop.bat — Shut down the cluster node via WSL
::
::  Thin wrapper around `node.sh stop`. Stops the control agent,
::  the LiteLLM proxy (master/both), and the dashboard. Does NOT
::  kill running vLLM instances on this node — those keep serving
::  so in-flight inference doesn't drop. To stop vLLM workers too,
::  use the dashboard's Service List.
:: ============================================================

set WSL_DISTRO=

title AI Distributed Inference Cluster - Stopping

if "%WSL_DISTRO%"=="" (
    set WSL_CMD=wsl
) else (
    set WSL_CMD=wsl -d %WSL_DISTRO%
)

for /f "delims=" %%i in ('%WSL_CMD% wslpath -u "%~dp0"') do set WSL_DIR=%%i

%WSL_CMD% bash -c "cd '%WSL_DIR%' && bash ./node.sh stop"

if %ERRORLEVEL% neq 0 (
    echo.
    echo  ERROR: node.sh stop exited %ERRORLEVEL%
    pause
    exit /b %ERRORLEVEL%
)

title AI Distributed Inference Cluster - Stopped
echo.
echo  Done.
echo.
pause
