@echo off
chcp 65001 >nul
title FEAGLE WxBot - Windows 本地启动管理

echo =======================================================
echo          FEAGLE WxBot Windows 纯本地绿色启动器
echo =======================================================
echo 架构: 0 Docker / 0 PostgreSQL / Node 22 原生 SQLite 记忆桩
echo.

:: 1. 检查 Node.js 环境
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js (推荐 v20 或 v22 以上版本)。
    pause
    exit /b 1
)

:: 2. 定位到 apps/bridge 目录
cd /d "%~dp0\apps\bridge"

:: 3. 检查并自动创建本地数据目录
if not exist "data" mkdir "data"
if not exist "data\wechat" mkdir "data\wechat"
if not exist "data\android" mkdir "data\android"
if not exist "data\feishu" mkdir "data\feishu"

:: 4. 检查 node_modules
if not exist "node_modules" (
    echo [提示] 正在安装 bridge 必要依赖...
    call npm install --no-audit --prefer-offline
    if %errorlevel% neq 0 (
        echo [错误] 依赖安装失败，请检查网络后重试。
        pause
        exit /b 1
    )
)

:: 5. 设置环境变量 (本地运行模式)
set DATA_DIR=.\data
set BOT_DASHBOARD_PORT=6190
set ANDROID_BRIDGE_PORT=6191
set MNEMOSYNE_PORT=18010
set MNEMOSYNE_LOCAL=true

echo [状态] 启动核心 Bridge 与 18010 本地记忆桩...
echo [状态] Web控制台即将就绪: http://127.0.0.1:6190
echo -------------------------------------------------------

:: 6. 延迟 2 秒自动打开默认浏览器
start "" powershell -NoProfile -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:6190'"

:: 7. 启动 Node.js 主服务
node src/index.js

pause
