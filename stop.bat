@echo off
:: ============================================================
::  stop.bat — Shut down the vLLM inference stack via WSL
:: ============================================================

set CONDA_ENV=
set WSL_DISTRO=

title vLLM Inference Stack — Stopping...

echo.
echo  =====================================================
echo   Stopping vLLM Inference Stack
echo  =====================================================
echo.

if "%WSL_DISTRO%"=="" (
    set WSL_CMD=wsl
) else (
    set WSL_CMD=wsl -d %WSL_DISTRO%
)

if "%CONDA_ENV%"=="" (
    set ACTIVATE_PREFIX=
) else (
    set ACTIVATE_PREFIX=conda activate %CONDA_ENV% ^&^&
)

for /f "delims=" %%i in ('%WSL_CMD% wslpath -u "%~dp0"') do set WSL_DIR=%%i

%WSL_CMD% bash -c "%ACTIVATE_PREFIX% cd '%WSL_DIR%' && bash stop_inference_stack.sh"

if %ERRORLEVEL% neq 0 (
    echo.
    echo  WARNING: stop script exited with code %ERRORLEVEL%
    echo  Some processes may need to be killed manually.
    pause
    exit /b %ERRORLEVEL%
)

title vLLM Inference Stack — Stopped
echo.
echo  Done. All processes stopped.
echo.
pause
