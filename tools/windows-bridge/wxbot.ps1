[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string] $Component,

  [Parameter(Position = 1)]
  [string] $Action
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$appRoot = Join-Path $env:LOCALAPPDATA 'FEAGLEwxbot'
$configPath = Join-Path $appRoot 'config.json'
$statePath = Join-Path $appRoot 'ssh-tunnel.json'
$stdoutPath = Join-Path $appRoot 'ssh-tunnel.stdout.log'
$stderrPath = Join-Path $appRoot 'ssh-tunnel.stderr.log'

function Write-Info([string] $Message) {
  Write-Host "[wxbot] $Message" -ForegroundColor Cyan
}

function Write-Good([string] $Message) {
  Write-Host "[wxbot] $Message" -ForegroundColor Green
}

function Write-Warn([string] $Message) {
  Write-Host "[wxbot] $Message" -ForegroundColor Yellow
}

function Write-Fail([string] $Message) {
  Write-Host "[wxbot] $Message" -ForegroundColor Red
}

function Show-Usage {
  Write-Host (@(
    'FEAGLE WxBot Windows tunnel helper'
    ''
    'Usage / 用法:'
    '  wxbot bridge start    Start the SSH tunnel in background / 后台启动 SSH 隧道'
    '  wxbot bridge status   Check the managed tunnel / 检查隧道状态'
    '  wxbot bridge exit     Stop the managed tunnel / 退出隧道'
  ) -join [Environment]::NewLine)
}

function Read-JsonFile([string] $Path) {
  if (-not (Test-Path -LiteralPath $Path)) {
    return $null
  }
  try {
    return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    Write-Warn "状态文件无法读取，将按失效状态处理 / State file is invalid."
    return $null
  }
}

function Test-LocalPort([int] $Port, [int] $TimeoutMs = 600) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $task = $client.ConnectAsync('127.0.0.1', $Port)
    if (-not $task.Wait($TimeoutMs)) {
      return $false
    }
    return $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Get-ManagedProcess($State, $Config) {
  if ($null -eq $State -or $null -eq $State.pid) {
    return $null
  }
  try {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($State.pid)"
  } catch {
    return $null
  }
  if ($null -eq $process -or $process.Name -notin @('ssh.exe', 'ssh')) {
    return $null
  }
  $commandLine = [string] $process.CommandLine
  $expectedTarget = [regex]::Escape([string] $Config.sshTarget)
  $expectedDashboard = [regex]::Escape(
    "$($Config.dashboardPort):127.0.0.1:$($Config.dashboardPort)"
  )
  $expectedAstrBot = [regex]::Escape(
    "$($Config.astrbotPort):127.0.0.1:$($Config.astrbotPort)"
  )
  if (
    $commandLine -notmatch $expectedTarget -or
    $commandLine -notmatch $expectedDashboard -or
    $commandLine -notmatch $expectedAstrBot
  ) {
    return $null
  }
  return $process
}

function Remove-StateFile {
  if (Test-Path -LiteralPath $statePath) {
    Remove-Item -LiteralPath $statePath -Force
  }
}

function Get-PortOwner([int] $Port) {
  try {
    return Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop |
      Select-Object -First 1 -ExpandProperty OwningProcess
  } catch {
    return $null
  }
}

function Show-Status($Config, [switch] $Quiet) {
  $state = Read-JsonFile $statePath
  $process = Get-ManagedProcess $state $Config
  $dashboardOpen = Test-LocalPort ([int] $Config.dashboardPort
  )
  $astrbotOpen = Test-LocalPort ([int] $Config.astrbotPort)

  if ($null -eq $process) {
    if (-not $Quiet) {
      Write-Warn "未发现由 wxbot 管理的 SSH 隧道 / Managed tunnel is not running."
      if ($dashboardOpen -or $astrbotOpen) {
        Write-Warn "端口已被其他进程占用，wxbot 不会操作它 / Ports are owned by another process."
      }
    }
    return $false
  }

  if (-not $Quiet) {
    Write-Info "SSH PID: $($process.ProcessId)"
    Write-Host "  Dashboard  http://127.0.0.1:$($Config.dashboardPort)  $(
      if ($dashboardOpen) { 'OPEN' } else { 'CLOSED' }
    )"
    Write-Host "  AstrBot    http://127.0.0.1:$($Config.astrbotPort)  $(
      if ($astrbotOpen) { 'OPEN' } else { 'CLOSED' }
    )"
  }
  return ($dashboardOpen -and $astrbotOpen)
}

if ($Component -in @('-h', '--help', 'help') -or [string]::IsNullOrWhiteSpace($Component)) {
  Show-Usage
  exit 0
}

if ($Component -ne 'bridge' -or [string]::IsNullOrWhiteSpace($Action)) {
  Show-Usage
  exit 2
}

if (-not (Test-Path -LiteralPath $configPath)) {
  Write-Fail "缺少配置文件：$configPath"
  Write-Host "请重新运行 Windows 安装脚本 / Re-run the Windows installer."
  exit 2
}

$config = Read-JsonFile $configPath
if (
  $null -eq $config -or
  [string]::IsNullOrWhiteSpace([string] $config.sshTarget)
) {
  Write-Fail "SSH 配置无效 / Invalid SSH configuration."
  exit 2
}

$sshCommand = Get-Command ssh.exe -ErrorAction SilentlyContinue
if ($null -eq $sshCommand) {
  Write-Fail "未找到 Windows OpenSSH 客户端 / ssh.exe was not found."
  exit 2
}

switch ($Action.ToLowerInvariant()) {
  'start' {
    $existingState = Read-JsonFile $statePath
    $existingProcess = Get-ManagedProcess $existingState $config
    if ($null -ne $existingProcess) {
      if (Show-Status $config -Quiet) {
        Write-Good "SSH 隧道已经在后台运行 / Tunnel is already running."
        Show-Status $config | Out-Null
        exit 0
      }
      Write-Warn "发现失效的旧隧道，正在清理 / Cleaning up an unhealthy tunnel."
      Stop-Process -Id $existingProcess.ProcessId -Force
      Remove-StateFile
    } else {
      Remove-StateFile
    }

    foreach ($port in @([int] $config.dashboardPort, [int] $config.astrbotPort)) {
      if (Test-LocalPort $port) {
        $owner = Get-PortOwner $port
        Write-Fail "本地端口 $port 已被其他进程占用（PID $owner）。"
        Write-Host "Local port $port is already occupied; nothing was changed."
        exit 1
      }
    }

    New-Item -ItemType Directory -Path $appRoot -Force | Out-Null
    Set-Content -LiteralPath $stdoutPath -Value '' -Encoding UTF8
    Set-Content -LiteralPath $stderrPath -Value '' -Encoding UTF8

    $sshArgs = @(
      '-N',
      '-T',
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      '-L', "$($config.dashboardPort):127.0.0.1:$($config.dashboardPort)",
      '-L', "$($config.astrbotPort):127.0.0.1:$($config.astrbotPort)",
      [string] $config.sshTarget
    )

    Write-Info "正在后台建立 SSH 隧道 / Starting tunnel..."
    $process = Start-Process `
      -FilePath $sshCommand.Source `
      -ArgumentList $sshArgs `
      -WindowStyle Hidden `
      -RedirectStandardOutput $stdoutPath `
      -RedirectStandardError $stderrPath `
      -PassThru

    [pscustomobject] @{
      version = 1
      pid = $process.Id
      startedAt = (Get-Date).ToUniversalTime().ToString('o')
      sshTarget = [string] $config.sshTarget
      dashboardPort = [int] $config.dashboardPort
      astrbotPort = [int] $config.astrbotPort
    } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8

    $deadline = (Get-Date).AddSeconds(15)
    do {
      Start-Sleep -Milliseconds 350
      $process.Refresh()
      if ($process.HasExited) {
        $errorText = if (Test-Path -LiteralPath $stderrPath) {
          (Get-Content -LiteralPath $stderrPath -Tail 8 -ErrorAction SilentlyContinue) -join "`n"
        } else {
          ''
        }
        Remove-StateFile
        Write-Fail "SSH 隧道启动失败 / Tunnel failed to start."
        if ($errorText) {
          Write-Host $errorText
        }
        exit 1
      }
      $ready = (Test-LocalPort ([int] $config.dashboardPort)) -and
        (Test-LocalPort ([int] $config.astrbotPort))
    } while (-not $ready -and (Get-Date) -lt $deadline)

    if (-not $ready) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      Remove-StateFile
      Write-Fail "15 秒内未能打开本地端口，隧道已安全退出 / Port check timed out."
      exit 1
    }

    Write-Good "SSH 隧道已在后台运行 / Tunnel is running in background."
    Show-Status $config | Out-Null
    exit 0
  }

  'status' {
    if (Show-Status $config) {
      Write-Good "隧道状态正常 / Tunnel is healthy."
      exit 0
    }
    exit 1
  }

  { $_ -in @('exit', 'stop') } {
    $state = Read-JsonFile $statePath
    $process = Get-ManagedProcess $state $config
    if ($null -eq $process) {
      Remove-StateFile
      Write-Warn "没有可退出的 wxbot 隧道 / No managed tunnel to stop."
      if (
        (Test-LocalPort ([int] $config.dashboardPort)) -or
        (Test-LocalPort ([int] $config.astrbotPort))
      ) {
        Write-Warn "检测到其他程序占用端口，未执行终止操作 / Foreign port owner was left untouched."
      }
      exit 0
    }

    Show-Status $config | Out-Null
    Write-Info "正在退出后台 SSH 隧道 / Stopping tunnel..."
    Stop-Process -Id $process.ProcessId -Force
    try {
      Wait-Process -Id $process.ProcessId -Timeout 5 -ErrorAction SilentlyContinue
    } catch {
      # The process has already exited.
    }
    Remove-StateFile
    Write-Good "SSH 隧道已退出 / Tunnel stopped."
    exit 0
  }

  default {
    Show-Usage
    exit 2
  }
}
