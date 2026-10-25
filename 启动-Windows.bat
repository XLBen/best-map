@echo off
rem Double-click this file to open the map (Windows).
rem Keep this file ASCII only: cmd reads .bat files in the system code page (GBK on Chinese Windows),
rem and non-ASCII text breaks the following lines.
cd /d "%~dp0"
where node >/dev/null 2>nul
if errorlevel 1 (
  echo.
  echo Node.js not found. Install the LTS version from https://nodejs.org, then double-click this file again.
  echo.
  start "" https://nodejs.org/zh-cn/download
  pause
  exit /b 1
)
node "%~dp0tools\launch.mjs"
if errorlevel 1 pause
