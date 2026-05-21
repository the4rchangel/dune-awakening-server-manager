@echo off
title Dune: Awakening Server Manager

:: Check for admin privileges (required for Hyper-V)
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo Requesting administrator privileges...
    powershell -Command "Start-Process cmd -ArgumentList '/c cd /d \"%~dp0\" && \"%~f0\"' -Verb RunAs"
    exit /b
)

cd /d "%~dp0"

where node >nul 2>&1
if %errorLevel% neq 0 (
    echo.
    echo  ERROR: Node.js is required but not found.
    echo  Download it from https://nodejs.org
    echo.
    pause
    exit /b 1
)

if not exist node_modules (
    echo Installing dependencies...
    call npm install
    if %errorLevel% neq 0 (
        echo.
        echo  npm install failed. If you see a script execution policy error,
        echo  open PowerShell as Administrator and run:
        echo.
        echo    Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
        echo.
        echo  Then try again.
        echo.
        pause
        exit /b 1
    )
    echo.
)

:: Verify express is installed (catches partial installs)
if not exist "node_modules\express" (
    echo Dependencies missing or incomplete. Reinstalling...
    call npm install
    if %errorLevel% neq 0 (
        echo.
        echo  Failed to install dependencies. Check your internet connection
        echo  and try running "npm install" manually.
        echo.
        pause
        exit /b 1
    )
)

echo.
echo  ==========================================
echo   Dune: Awakening Server Manager
echo   http://localhost:3000
echo  ==========================================
echo.

start http://localhost:3000
node server.js
if %errorLevel% neq 0 (
    echo.
    echo  Server exited with an error. Check the output above.
    echo.
)
pause
