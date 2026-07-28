[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string] $SshTarget,

  [ValidateRange(1, 65535)]
  [int] $DashboardPort = 6190,

  [ValidateRange(1, 65535)]
  [int] $AstrBotPort = 6185
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$sourceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$appRoot = Join-Path $env:LOCALAPPDATA 'FEAGLEwxbot'
$binRoot = Join-Path $appRoot 'bin'
$configPath = Join-Path $appRoot 'config.json'
$windowsApps = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps'

New-Item -ItemType Directory -Path $binRoot -Force | Out-Null
$commandScript = Get-Content -LiteralPath (Join-Path $sourceRoot 'wxbot.ps1') -Raw -Encoding UTF8
$utf8WithBom = New-Object System.Text.UTF8Encoding($true)
[System.IO.File]::WriteAllText(
  (Join-Path $binRoot 'wxbot.ps1'),
  $commandScript,
  $utf8WithBom
)
Copy-Item -LiteralPath (Join-Path $sourceRoot 'wxbot.cmd') -Destination $binRoot -Force

# WindowsApps is already present in the default per-user PATH. This tiny shim
# makes the command available without requiring an Explorer restart.
if (Test-Path -LiteralPath $windowsApps) {
  $shim = @(
    '@echo off'
    "call `"$binRoot\wxbot.cmd`" %*"
    'exit /b %errorlevel%'
    ''
  ) -join "`r`n"
  [System.IO.File]::WriteAllText(
    (Join-Path $windowsApps 'wxbot.cmd'),
    $shim,
    [System.Text.Encoding]::ASCII
  )
}

[pscustomobject] @{
  version = 1
  sshTarget = $SshTarget
  dashboardPort = $DashboardPort
  astrbotPort = $AstrBotPort
} | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$pathEntries = @(
  [string] $userPath -split ';' |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ }
)
if ($pathEntries -notcontains $binRoot) {
  $newPath = (@($pathEntries) + $binRoot) -join ';'
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
}

Write-Host "FEAGLE WxBot Windows command installed." -ForegroundColor Green
Write-Host "安装目录 / Install path: $binRoot"
Write-Host ''
Write-Host 'Open a new PowerShell or CMD window, then run:'
Write-Host '  wxbot bridge start'
Write-Host '  wxbot bridge status'
Write-Host '  wxbot bridge exit'
