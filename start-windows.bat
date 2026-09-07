@echo off
chcp 65001 >nul
title FEAGLE WxBot - Windows 本地启动管理
cd /d "%~dp0"

echo =======================================================
echo          FEAGLE WxBot Windows 纯本地绿色启动器
echo =======================================================
echo 架构: 0 Docker / 0 PostgreSQL / Node 22 原生 SQLite 记忆桩
echo.

:: 1. 检查 Node.js 环境
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js (推荐 v20 或 v22 以上版本)。
    echo 官方下载: https://nodejs.org/zh-cn
    pause
    exit /b 1
)

:: 2. 启动 Windows 本地多服务编排器 (Bridge + 大脑 + Mnemosyne 伴随)
node tools\windows\start-local.js

if %errorlevel% neq 0 (
    echo.
    echo [提示] 服务已停止或发生异常。
    pause
)
