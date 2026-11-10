@echo off
chcp 65001 >nul
title WorkBuddy TPS - HUD
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [x] Node.js not found in PATH. Install Node.js 22+ first.
  pause
  exit /b 1
)

node -e "require('http').get({host:'127.0.0.1',port:9222,path:'/json/version',timeout:1500},r=>{process.exit(0)}).on('error',()=>{process.exit(2)})"
if errorlevel 2 (
  echo.
  echo [!] WorkBuddy is not running with --remote-debugging-port=9222
  echo.
  echo     Start it like this:
  echo       "%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe" --remote-debugging-port=9222
  echo.
  echo     Or use the floating window instead: start-float.cmd
  echo.
  pause
  exit /b 1
)

echo Injecting speed HUD into WorkBuddy... press Ctrl+C to stop.
node tps.mjs hud
pause