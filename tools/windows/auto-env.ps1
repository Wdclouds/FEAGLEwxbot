[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Feagle([string]$Message, [ConsoleColor]$Color = [ConsoleColor]::Cyan) {
    Write-Host "[FEAGLE] $Message" -ForegroundColor $Color
}

function Test-UrlLatencyMs([string]$Url, [int]$TimeoutMs = 1500) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $req = [System.Net.WebRequest]::Create($Url)
        $req.Method = "HEAD"
        $req.Timeout = $TimeoutMs
        $res = $req.GetResponse()
        $res.Close()
        $sw.Stop()
        return [int]$sw.ElapsedMilliseconds
    } catch {
        return 99999
    }
}

function Get-NetworkProfile {
    Write-Feagle "Detecting network latency (1-second check)..." -Color Cyan

    $npmOfficial = Test-UrlLatencyMs "https://registry.npmjs.org" 1500
    $npmMirror   = Test-UrlLatencyMs "https://registry.npmmirror.com" 1500
    $github      = Test-UrlLatencyMs "https://github.com" 1500
    $ghfast      = Test-UrlLatencyMs "https://ghfast.top" 1500

    $isChina = ($github -gt 1500 -or $ghfast -lt $github -or $npmOfficial -gt 1500)

    if ($isChina) {
        Write-Feagle "China direct connection detected. Auto-activating mirror speedup." -Color Green
        return @{
            IsChinaNetwork = $true
            NpmRegistry    = "https://registry.npmmirror.com"
            NodeDistUrl    = "https://npmmirror.com/mirrors/node"
            GhProxy        = "https://ghfast.top/"
        }
    } else {
        Write-Feagle "Direct global internet connection detected. Using official registries." -Color Green
        return @{
            IsChinaNetwork = $false
            NpmRegistry    = "https://registry.npmjs.org"
            NodeDistUrl    = "https://nodejs.org/dist"
            GhProxy        = ""
        }
    }
}

function Resolve-NodeRuntime {
    param(
        [Parameter(Mandatory = $true)]
        [hashtable]$NetworkProfile,
        [Parameter(Mandatory = $true)]
        [string]$ProjectRoot
    )

    $systemNode = Get-Command 'node' -ErrorAction SilentlyContinue
    if ($null -ne $systemNode) {
        try {
            $verOutput = (& $systemNode.Source -v) -replace '^v',''
            $major = [int]($verOutput.Split('.')[0])
            if ($major -ge 18) {
                Write-Feagle "Found system Node.js (v$verOutput). Reusing existing environment!" -Color Green
                return $systemNode.Source
            } else {
                Write-Feagle "System Node.js (v$verOutput) is too old. Node 18+ required." -Color Yellow
            }
        } catch {
            Write-Feagle "Error checking system Node.js version." -Color Yellow
        }
    }

    $portableNode = Join-Path $ProjectRoot '.tools\node\node.exe'
    if (Test-Path -LiteralPath $portableNode) {
        Write-Feagle "Using project portable Node.js runtime: $portableNode" -Color Green
        return $portableNode
    }

    Write-Host ""
    Write-Feagle "No suitable Node.js runtime found." -Color Yellow
    Write-Host "Please choose an installation method:"
    Write-Host "  [1] Global install via winget: winget install OpenJS.NodeJS.LTS"
    Write-Host "  [2] Download portable Node.js into project .tools/node (isolated, clean)"
    Write-Host "  [3] Exit"
    Write-Host ""

    $choice = Read-Host "Select [1/2/3] (Default: 1)"
    if ($choice -eq '2') {
        $nodeVersion = "v20.18.0"
        $zipName = "node-$nodeVersion-win-x64.zip"
        $downloadUrl = "$($NetworkProfile.NodeDistUrl)/$nodeVersion/$zipName"
        $toolsDir = Join-Path $ProjectRoot '.tools'
        $destZip = Join-Path $toolsDir $zipName
        $extractDir = Join-Path $toolsDir "node-$nodeVersion-win-x64"

        New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
        Write-Feagle "Downloading portable Node.js from mirror ($downloadUrl)..." -Color Cyan

        Invoke-WebRequest -Uri $downloadUrl -OutFile $destZip -UseBasicParsing
        Write-Feagle "Extracting to .tools/node..." -Color Cyan
        Expand-Archive -LiteralPath $destZip -DestinationPath $toolsDir -Force
        Remove-Item -LiteralPath $destZip -Force -ErrorAction SilentlyContinue

        $finalNodeDir = Join-Path $toolsDir 'node'
        if (Test-Path $finalNodeDir) { Remove-Item -Recurse -Force $finalNodeDir }
        Rename-Item -Path $extractDir -NewName 'node'

        Write-Feagle "Portable Node.js ready!" -Color Green
        return $portableNode
    } elseif ($choice -eq '3') {
        Write-Feagle "Cancelled. Please install Node.js 18+ and try again." -Color Yellow
        exit 1
    } else {
        Write-Feagle "Please run: winget install OpenJS.NodeJS.LTS" -Color Cyan
        Write-Feagle "Rerun this script after installation." -Color Yellow
        exit 0
    }
}
