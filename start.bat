@echo off
:: ============================================================
::  start.bat — Install deps, launch the vLLM inference stack,
::              and open a live GPU monitor window
:: ============================================================
::
::  Prerequisites (first run):
::    - WSL2 installed and configured
::    - Python 3.10+ available inside WSL
::    - Internet access for pip downloads on first run
::
::  Subsequent runs: pip skips already-installed packages (fast).
::
::  Usage: double-click OR run from any cmd / PowerShell prompt
:: ============================================================

:: --- Optional: name of your conda env (leave blank if using system Python) --
set CONDA_ENV=

:: --- WSL distro name (leave blank for default distro) ----------------------
set WSL_DISTRO=

:: ---------------------------------------------------------------------------

title vLLM Inference Stack — Initializing...

echo.
echo  =====================================================
echo   vLLM Inference Stack
echo  =====================================================
echo.

:: Build WSL command
if "%WSL_DISTRO%"=="" (
    set WSL_CMD=wsl
) else (
    set WSL_CMD=wsl -d %WSL_DISTRO%
)

:: Build conda activation prefix (empty if no env set)
if "%CONDA_ENV%"=="" (
    set ACTIVATE_PREFIX=
) else (
    set ACTIVATE_PREFIX=conda activate %CONDA_ENV% ^&^&
)

:: Resolve the WSL path of this script's directory
for /f "delims=" %%i in ('%WSL_CMD% wslpath -u "%~dp0"') do set WSL_DIR=%%i

:: ── Open GPU monitor in a separate window ──────────────────────────────────
echo  Opening GPU monitor window...
start "GPU Monitor — nvidia-smi" cmd /k "nvidia-smi -l 2"

:: ── Run setup + stack (all output streams into THIS window) ────────────────
echo  Running setup and launching stack...
echo  (First run will download and install packages — this may take a few minutes)
echo.

%WSL_CMD% bash -c "%ACTIVATE_PREFIX% cd '%WSL_DIR%' && bash start_inference_stack.sh"

if %ERRORLEVEL% neq 0 (
    echo.
    echo  =====================================================
    echo   ERROR: Stack failed to start (exit code %ERRORLEVEL%)
    echo   Check the logs\ folder for details.
    echo  =====================================================
    echo.
    pause
    exit /b %ERRORLEVEL%
)

title vLLM Inference Stack — Running
echo.
echo  =====================================================
echo   Stack is running.
echo   This window can be closed — the stack keeps running.
echo   Run stop.bat to shut everything down cleanly.
echo  =====================================================
echo.
pause
