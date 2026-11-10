@echo off
chcp 65001 >nul
title WorkBuddy TPS - floating window
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [x] Node.js not found in PATH. Install Node.js 22+ first.
  pause
  exit /b 1
)

start "" /b powershell -ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File "%~dp0WbTps.ps1"
exit /b 0