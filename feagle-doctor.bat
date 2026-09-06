@echo off
chcp 65001 >nul
title FEAGLE WxBot 系统体检器 (Doctor)
cd /d "%~dp0"
node "tools\windows\doctor.js"
echo.
pause
