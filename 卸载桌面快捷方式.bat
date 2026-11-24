@echo off
chcp 65001 >nul
title AGENTFORGE Uninstall Shortcut
cd /d "%~dp0"
node "desktop\install.mjs" --remove
echo.
pause
