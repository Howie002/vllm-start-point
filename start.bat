@echo off
:: ============================================================
::  start.bat — AI Distributed Inference Cluster (Windows wrapper)
::
::  Drives node.sh through WSL. On first run does setup
::  (interactive role/IP prompts in the WSL window); subsequent
::  runs just start services.
::
::  Prerequisites (first run only):
::    - WSL2 installed and an Ubuntu distro available
::    - Python 3.10+ inside the WSL distro
::    - Internet access for the first dependency pull
::
::  Usage:
::    start.bat              first run = setup, subsequent runs = start
::    start.bat setup        force re-run interactive setup
::    start.bat start        start services without re-running setup
::    start.bat stop         stop services
::    start.bat status       show what's running
:: ============================================================

:: --- WSL distro name (leave blank for default distro) ----------------------
set WSL_DISTRO=

:: ---------------------------------------------------------------------------

title AI Distributed Inference Cluster - Starting

if "%WSL_DISTRO%"=="" (
    set WSL_CMD=wsl
) else (
    set WSL_CMD=wsl -d %WSL_DISTRO%
)

:: Resolve the WSL path of this repo
for /f "delims=" %%i in ('%WSL_CMD% wslpath -u "%~dp0"') do set WSL_DIR=%%i

set CMD=%~1
if "%CMD%"=="" set CMD=auto

if /I "%CMD%"=="auto" (
    :: First run = no node_config.json yet, run setup. Otherwise just start.
    %WSL_CMD% bash -c "cd '%WSL_DIR%' && if [ -f node_config.json ]; then bash ./node.sh start; else bash ./node.sh setup; fi"
) else if /I "%CMD%"=="setup" (
    %WSL_CMD% bash -c "cd '%WSL_DIR%' && bash ./node.sh setup"
) else if /I "%CMD%"=="start" (
    %WSL_CMD% bash -c "cd '%WSL_DIR%' && bash ./node.sh start"
) else if /I "%CMD%"=="stop" (
    %WSL_CMD% bash -c "cd '%WSL_DIR%' && bash ./node.sh stop"
) else if /I "%CMD%"=="status" (
    %WSL_CMD% bash -c "cd '%WSL_DIR%' && bash ./node.sh status"
) else (
    echo Usage: %~nx0 [^| setup ^| start ^| stop ^| status]
    echo   no arg   first run = setup, subsequent runs = start
    echo   setup    force re-run interactive setup
    echo   start    start services without re-running setup
    echo   stop     stop services
    echo   status   show what's running
    exit /b 1
)

if %ERRORLEVEL% neq 0 (
    echo.
    echo  =====================================================
    echo   ERROR: node.sh exited %ERRORLEVEL%
    echo   Check logs\node.log inside the repo for details.
    echo  =====================================================
    echo.
    pause
    exit /b %ERRORLEVEL%
)

title AI Distributed Inference Cluster
echo.
pause
