@echo off
chcp 65001 >nul
title FEAGLE WxBot 交互式部署向导 (Setup Wizard)
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js (推荐 v20 或 v22 以上版本)。
    echo 官方下载地址: https://nodejs.org/zh-cn
    echo.
    pause
    exit /b 1
)

node tools\windows\setup-wizard.js
if %errorlevel% neq 0 (
    echo.
    echo [提示] 向导执行结束。
    pause
)
