[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string] $Component = 'help',

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
    & (Join-Path $projectRoot 'tools\windows-android\feagle-android.ps1') `
      @RemainingArguments
    exit $LASTEXITCODE
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
