@echo off
chcp 65001 >nul
rem 双击这个文件开启地图（Windows）
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo 没有找到 Node.js。请到 https://nodejs.org 下载安装 LTS 版，再双击这个文件。
  echo.
  pause
  exit /b 1
)
node tools\launch.mjs
if errorlevel 1 pause
