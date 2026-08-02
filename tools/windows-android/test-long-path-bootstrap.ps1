$ErrorActionPreference = "Stop"

$entryScript = Join-Path $PSScriptRoot "feagle-android.ps1"
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) (
    "feagle-long-path-test-" + [guid]::NewGuid().ToString("N")
)
$deepRepository = Join-Path $testRoot (
    "repository-" + ("x" * 20)
)
$archivePath = Join-Path $testRoot "commandlinetools-test.zip"

try {
    New-Item -ItemType Directory -Path $deepRepository -Force | Out-Null
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::Open(
        $archivePath,
        [System.IO.Compression.ZipArchiveMode]::Create
    )
    try {
        foreach ($fixture in @(
            [pscustomobject]@{
                Name = "cmdline-tools/bin/sdkmanager.bat"
                Content = "@echo off"
            },
            [pscustomobject]@{
                Name = (
                    "cmdline-tools/lib/dependency-" +
                    ("x" * 40) +
                    "/artifact.jar"
                )
                Content = "test"
            }
        )) {
            $entry = $archive.CreateEntry($fixture.Name)
            $writer = [System.IO.StreamWriter]::new($entry.Open())
            try {
                $writer.Write($fixture.Content)
            }
            finally {
                $writer.Dispose()
            }
        }
    }
    finally {
        $archive.Dispose()
    }

    . $entryScript validate-toolchain
    $script:ToolsRoot = Join-Path $deepRepository ".tools"
    $cleanupGuardRejected = $false
    try {
        Remove-AndroidCliStagingDirectory -Path $deepRepository
    }
    catch {
        $cleanupGuardRejected = $true
    }
    if (-not $cleanupGuardRejected) {
        throw "The temporary-directory cleanup guard accepted an unsafe path"
    }

    $legacyDeepestPath = Join-Path $script:ToolsRoot (
        ".staging\android-cli-00000000000000000000000000000000\" +
        "cmdline-tools\lib\dependency-" +
        ("x" * 40) +
        "\artifact.jar"
    )
    if ($legacyDeepestPath.Length -le 260) {
        throw "The legacy extraction fixture must exceed 260 characters"
    }

    $installedDeepestPath = Join-Path $script:ToolsRoot (
        "android-sdk\cmdline-tools\latest\lib\dependency-" +
        ("x" * 40) +
        "\artifact.jar"
    )
    if ($installedDeepestPath.Length -ge 260) {
        throw "The installed fixture path must remain below 260 characters"
    }

    $sdkManager = Install-AndroidCommandLineTools -ArchivePath $archivePath

    if (-not (Test-Path -LiteralPath $sdkManager -PathType Leaf)) {
        throw "The long-path regression test did not install sdkmanager.bat"
    }
    Write-Pass "Windows PowerShell long-path extraction regression test passed"
}
finally {
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
