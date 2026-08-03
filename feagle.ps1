[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string] $Component = 'help',

  # 子脚本的开关参数在这里显式声明，避免 PowerShell 参数绑定阶段
  # 把 "-Switch" 当成未知命名参数直接拒绝（ValueFromRemainingArguments
  # 只收集位置参数，收集不到开关）。
  [switch] $ConfirmInstall,
  [switch] $ConfirmAgentInstall,
  [switch] $AcceptAndroidSdkLicense,
  [switch] $DryRun,

  [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
  [string[]] $RemainingArguments
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot

function Show-Usage {
  Write-Host @'
FEAGLE WxBot Monorepo

Usage / 用法:
  .\feagle.cmd bridge start
  .\feagle.cmd bridge status
  .\feagle.cmd bridge exit
  .\feagle.cmd android doctor
  .\feagle.cmd android build-agent
  .\feagle.cmd android agent-status
  .\feagle.cmd protocol check
'@
}

switch ($Component.ToLowerInvariant()) {
  'bridge' {
    & (Join-Path $projectRoot 'tools\windows-bridge\wxbot.ps1') `
      'bridge' @RemainingArguments
    exit $LASTEXITCODE
  }
  'android' {
    # 子脚本的具名/开关参数必须保持语义透传。
    #
    # PowerShell 5.1 有两个坑：
    # 1) @RemainingArguments 是 string[]，直接数组 splat 会把 "-Switch"
    #    也当位置参数传给子脚本（"找不到接受实际参数"）。
    # 2) 无 BOM 的 UTF-8 文件 + 中文注释时，注释可能吞掉换行与后续代码
    #    （本文件必须保持 UTF-8 with BOM）。
    #
    # 修复：把 "-Switch" 显式映射为 hashtable splat（hashtable 能保留
    # switch 语义），其余参数按位置数组 splat 转发。
    $positional = @()
    $splat = @{}
    foreach ($arg in $RemainingArguments) {
      if ($arg -match '^-([A-Za-z]+)$') {
        $name = $Matches[1]
        switch ($name) {
          'ConfirmInstall'          { $splat['ConfirmInstall'] = $true }
          'ConfirmAgentInstall'     { $splat['ConfirmAgentInstall'] = $true }
          'AcceptAndroidSdkLicense' { $splat['AcceptAndroidSdkLicense'] = $true }
          'DryRun'                  { $splat['DryRun'] = $true }
          default                   { $positional += $arg }
        }
      } else {
        $positional += $arg
      }
    }
    # 显式声明的开关参数也要转发给子脚本
    if ($ConfirmInstall) { $splat['ConfirmInstall'] = $true }
    if ($ConfirmAgentInstall) { $splat['ConfirmAgentInstall'] = $true }
    if ($AcceptAndroidSdkLicense) { $splat['AcceptAndroidSdkLicense'] = $true }
    if ($DryRun) { $splat['DryRun'] = $true }
    & (Join-Path $projectRoot 'tools\windows-android\feagle-android.ps1') `
      @positional @splat
    # 子脚本是 .ps1，不会设置 $LASTEXITCODE（StrictMode 下访问未定义变量会报错）。
    # 用 $? 反映调用是否成功。
    if (-not $?) { exit 1 }
    exit 0
  }
  'protocol' {
    if ($RemainingArguments.Count -gt 0 -and $RemainingArguments[0] -ne 'check') {
      Show-Usage
      exit 2
    }
    & node (Join-Path $projectRoot 'packages\protocol\check.mjs')
    exit $LASTEXITCODE
  }
  { $_ -in @('help', '-h', '--help') } {
    Show-Usage
    exit 0
  }
  default {
    Show-Usage
    exit 2
  }
}
