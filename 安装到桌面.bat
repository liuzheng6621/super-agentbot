@echo off
chcp 65001 >nul
title AGENTFORGE Setup
cd /d "%~dp0"

echo.
echo   AGENTFORGE  -  Multi-Agent Dev Console
echo   -------------------------------------
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [ERROR] Node.js not found. Please install Node.js 20+ first.
  echo           https://nodejs.org/
  echo.
  pause
  exit /b 1
)

set "NOTEPAD=1"
node "desktop\install.mjs"
if errorlevel 1 (
  echo.
  echo   [ERROR] Setup failed. See the message above.
  echo.
  pause
  exit /b 1
)

echo.
echo   Shortcut "AGENTFORGE" is now on your Desktop.
echo.
pause
