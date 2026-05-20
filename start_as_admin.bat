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
    echo  Node.js is required but not found.
    echo  Download it from https://nodejs.org
    echo.
    pause
    exit /b 1
)

if not exist node_modules (
    echo Installing dependencies...
    call npm install
    echo.
)

echo.
echo  ==========================================
echo   Dune: Awakening Server Manager
echo   http://localhost:3000
echo  ==========================================
echo.

start http://localhost:3000
node server.js
pause
