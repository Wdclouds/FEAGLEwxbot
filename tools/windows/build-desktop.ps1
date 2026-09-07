[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('check', 'dev', 'install', 'build', 'build:portable', 'build:nsis')]
  [string] $Action = 'check',

  [switch] $Release
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$desktopDir = Join-Path $projectRoot 'apps\desktop-electron'

function Test-CommandAvailable([string] $command) {
  $null = Get-Command $command -ErrorAction SilentlyContinue
  return [bool] $?
}

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "     FEAGLE WxBot 桌面客户端构建工具 (Electron Decoupled)    " -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Cyan

# 1. 检查基础环境
if (-not (Test-CommandAvailable 'node')) {
  Write-Error "[错误] 未检测到 Node.js 运行环境，请先安装 Node.js 22+"
  exit 1
}

$nodeVersion = & node -v
Write-Host "[环境体检] Node.js: $nodeVersion" -ForegroundColor Gray

# 2. 检查 apps/desktop-electron 依赖
$desktopModules = Join-Path $desktopDir 'node_modules'
function Ensure-DesktopDependencies {
  if (-not (Test-Path $desktopModules)) {
    Write-Host "[依赖安装] 首次运行，正在为 apps/desktop-electron 安装打包依赖..." -ForegroundColor Yellow
    Push-Location $desktopDir
    try {
      & npm install --no-audit
      if ($LASTEXITCODE -ne 0) {
        Write-Error "[错误] 桌面端打包依赖安装失败。"
        exit 1
      }
      Write-Host "[依赖安装] 桌面端依赖安装就绪！" -ForegroundColor Green
    } finally {
      Pop-Location
    }
  }
}

# 3. 检查 apps/bridge 依赖
$bridgeModules = Join-Path $projectRoot 'apps\bridge\node_modules'
if (-not (Test-Path $bridgeModules)) {
  Write-Host "[依赖准备] 正在确保 apps/bridge 运行时依赖就绪..." -ForegroundColor Yellow
  Push-Location (Join-Path $projectRoot 'apps\bridge')
  try {
    & npm install --no-audit
  } finally {
    Pop-Location
  }
}

switch ($Action.ToLowerInvariant()) {
  'check' {
    Write-Host "[状态自检]" -ForegroundColor White
    Write-Host "  - 桌面端目录: $desktopDir"
    $hasModules = Test-Path $desktopModules
    Write-Host "  - Electron 依赖: $(if ($hasModules) { '已就绪' } else { '待安装 (运行 .\feagle.cmd desktop install)' })"
    Write-Host "  - 解耦外置 Bridge: $(Join-Path $projectRoot 'apps\bridge')"
    Write-Host "  - 解耦外置 记忆库: $(Join-Path $projectRoot 'deploy\mnemosyne\windows-shim')"
    Write-Host ""
    Write-Host "可用命令:" -ForegroundColor Cyan
    Write-Host "  .\feagle.cmd desktop dev             # 启动本地 Electron 调试窗口"
    Write-Host "  .\feagle.cmd desktop install         # 安装桌面端打包依赖"
    Write-Host "  .\feagle.cmd desktop build           # 打包生成便携版与安装包 (dist/desktop)"
    Write-Host "  .\feagle.cmd desktop build:portable  # 仅打包便携版 (.exe)"
    Write-Host "  .\feagle.cmd desktop build:nsis      # 仅打包 Windows 安装引导器 (.exe)"
    exit 0
  }

  'install' {
    Ensure-DesktopDependencies
    exit 0
  }

  'dev' {
    Ensure-DesktopDependencies
    Write-Host "[桌面调试] 正在启动 Electron 宿主窗口..." -ForegroundColor Cyan
    Push-Location $desktopDir
    try {
      & npx electron .
      exit $LASTEXITCODE
    } finally {
      Pop-Location
    }
  }

  'build' {
    Ensure-DesktopDependencies
    Write-Host "[打包构建] 正在生成完整 Windows 发布包 (便携版 + 安装包)..." -ForegroundColor Cyan
    Push-Location $desktopDir
    try {
      & npx electron-builder --win --config electron-builder.yml
      exit $LASTEXITCODE
    } finally {
      Pop-Location
    }
  }

  'build:portable' {
    Ensure-DesktopDependencies
    Write-Host "[打包构建] 正在生成 Windows 便携免安装版..." -ForegroundColor Cyan
    Push-Location $desktopDir
    try {
      & npx electron-builder --win portable --config electron-builder.yml
      exit $LASTEXITCODE
    } finally {
      Pop-Location
    }
  }

  'build:nsis' {
    Ensure-DesktopDependencies
    Write-Host "[打包构建] 正在生成 Windows 标准安装程序..." -ForegroundColor Cyan
    Push-Location $desktopDir
    try {
      & npx electron-builder --win nsis --config electron-builder.yml
      exit $LASTEXITCODE
    } finally {
      Pop-Location
    }
  }

  default {
    Write-Host "未知指令: $Action" -ForegroundColor Red
    exit 2
  }
}
