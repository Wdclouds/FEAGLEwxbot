[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('build', 'check', 'run')]
  [string] $Action = 'check',

  [switch] $Release
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Resolve-Path (Join-Path $scriptDir '..\..')
$tauriDir = Join-Path $projectRoot 'apps\desktop\src-tauri'

if (-not (Test-Path $tauriDir)) {
  Write-Error "Tauri directory not found: $tauriDir"
  exit 1
}

$cargoCmd = Get-Command cargo -ErrorAction SilentlyContinue
if (-not $cargoCmd) {
  Write-Error "Rust toolchain (cargo) not found in PATH. Please install Rust from https://rustup.rs"
  exit 1
}

Push-Location $tauriDir
try {
  switch ($Action) {
    'check' {
      Write-Host "[FEAGLE Desktop] Running cargo check..." -ForegroundColor Cyan
      & cargo check
      if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    'build' {
      $args = @('build')
      if ($Release) { $args += '--release' }
      Write-Host "[FEAGLE Desktop] Building desktop binary ($($args -join ' '))..." -ForegroundColor Cyan
      & cargo @args
      if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    'run' {
      Write-Host "[FEAGLE Desktop] Launching desktop client..." -ForegroundColor Cyan
      & cargo run
      if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
  }
} finally {
  Pop-Location
}
