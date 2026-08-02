[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet(
        "menu",
        "bootstrap-tools",
        "build-agent",
        "install-agent",
        "agent-status",
        "pair-agent",
        "doctor",
        "verify-apk",
        "install-wechat",
        "verify-wechat",
        "source-status",
        "validate-manifest",
        "validate-toolchain",
        "validate-android-source"
    )]
    [string]$Command = "menu",

    [string]$AdbPath,

    [string]$ApkPath,

    [string]$AndroidSdkPath,

    [string]$JavaHome,

    [string]$AgentApkPath,

    [string]$ServerHost,

    [string]$SshUser = "root",

    [string]$ContainerName = "Feagle-wxbot",

    [string]$BridgeEndpoint,

    [switch]$ConfirmInstall,

    [switch]$ConfirmAgentInstall,

    [switch]$AcceptAndroidSdkLicense,

    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$ManifestPath = Join-Path $ProjectRoot "tools\windows-android\checks\wechat-8.0.70.json"
$ToolchainManifestPath = Join-Path $ProjectRoot "tools\windows-android\checks\windows-toolchain.json"
$ToolsRoot = Join-Path $ProjectRoot ".tools"
$AgentPackageName = "io.github.wdclouds.feaglewxbot.agent"
$AgentVersionName = "0.6.0"
$AgentVersionCode = 14
$AgentBuildReceiptPath = Join-Path $ToolsRoot "agent-build.json"
$script:AdbExecutable = $null
$script:ApkSignerExecutable = $null
$script:Aapt2Executable = $null
$script:ResolvedJavaHome = $null

function Write-Title {
    param([string]$Text)
    Write-Host ""
    Write-Host "=== $Text ===" -ForegroundColor Cyan
}

function Write-Pass {
    param([string]$Text)
    Write-Host "[通过] $Text" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Text)
    Write-Host "[注意] $Text" -ForegroundColor Yellow
}

function Write-Fail {
    param([string]$Text)
    Write-Host "[失败] $Text" -ForegroundColor Red
}

function Get-WechatManifest {
    if (-not (Test-Path -LiteralPath $ManifestPath)) {
        throw "找不到微信校验清单：$ManifestPath"
    }

    return Get-Content -Raw -Encoding UTF8 -LiteralPath $ManifestPath |
        ConvertFrom-Json
}

function Get-ToolchainManifest {
    if (-not (Test-Path -LiteralPath $ToolchainManifestPath)) {
        throw "找不到 Windows 工具链清单：$ToolchainManifestPath"
    }

    return Get-Content -Raw -Encoding UTF8 -LiteralPath $ToolchainManifestPath |
        ConvertFrom-Json
}

function Test-ToolchainManifest {
    param([switch]$Quiet)

    $manifest = Get-ToolchainManifest
    $errors = [System.Collections.Generic.List[string]]::new()

    if ($manifest.schemaVersion -ne 1) {
        $errors.Add("工具链 schemaVersion 必须为 1")
    }
    if ($manifest.platform -ne "windows-x64") {
        $errors.Add("当前只支持 windows-x64 工具链")
    }

    foreach ($artifact in @(
        $manifest.java,
        $manifest.androidCommandLineTools
    )) {
        if ([string]$artifact.downloadUrl -notmatch "^https://") {
            $errors.Add("$($artifact.fileName) 必须使用 HTTPS 下载")
        }
        if ([string]$artifact.sha256 -notmatch "^[a-fA-F0-9]{64}$") {
            $errors.Add("$($artifact.fileName) 缺少有效 SHA-256")
        }
        if ([string]::IsNullOrWhiteSpace([string]$artifact.fileName)) {
            $errors.Add("工具链文件名不能为空")
        }
    }

    $javaHost = ([uri]$manifest.java.downloadUrl).Host
    if ($javaHost -notin @("aka.ms", "download.visualstudio.microsoft.com")) {
        $errors.Add("JDK 下载地址必须属于微软官方域名")
    }
    if (
        ([uri]$manifest.androidCommandLineTools.downloadUrl).Host -ne
        "dl.google.com"
    ) {
        $errors.Add("Android 命令行工具必须从 dl.google.com 下载")
    }

    $packages = @($manifest.androidSdk.packages)
    if ("platform-tools" -notin $packages) {
        $errors.Add("工具链必须包含 platform-tools")
    }
    if ("build-tools;34.0.0" -notin $packages) {
        $errors.Add("工具链必须固定 Android Build Tools 34.0.0")
    }
    if ("platforms;android-34" -notin $packages) {
        $errors.Add("工具链必须包含 Android SDK Platform 34")
    }

    if ($errors.Count -gt 0) {
        if (-not $Quiet) {
            foreach ($item in $errors) {
                Write-Fail $item
            }
        }
        return $false
    }

    if (-not $Quiet) {
        Write-Pass "Windows 工具链清单结构有效"
    }
    return $true
}

function Test-Manifest {
    param([switch]$Quiet)

    $manifest = Get-WechatManifest
    $errors = [System.Collections.Generic.List[string]]::new()

    if ($manifest.schemaVersion -ne 1) {
        $errors.Add("schemaVersion 必须为 1")
    }
    if ($manifest.packageName -ne "com.tencent.mm") {
        $errors.Add("packageName 必须为 com.tencent.mm")
    }
    if ($manifest.versionName -ne "8.0.70") {
        $errors.Add("versionName 必须为 8.0.70")
    }
    if ($manifest.status -notin @(
        "metadata-pending",
        "reference-verified",
        "source-verified"
    )) {
        $errors.Add(
            "status 只能是 metadata-pending、reference-verified 或 source-verified"
        )
    }

    $fingerprintFields = @(
        "fileSha256",
        "signingCertificateSha256",
        "verifiedAt"
    )

    if ($manifest.status -in @("reference-verified", "source-verified")) {
        foreach ($field in $fingerprintFields) {
            if ([string]::IsNullOrWhiteSpace([string]$manifest.$field)) {
                $errors.Add("$($manifest.status) 状态缺少 $field")
            }
        }
        if ([string]$manifest.fileSha256 -notmatch "^[a-fA-F0-9]{64}$") {
            $errors.Add("fileSha256 必须是 64 位十六进制")
        }
        if ([string]$manifest.signingCertificateSha256 -notmatch "^[a-fA-F0-9]{64}$") {
            $errors.Add("signingCertificateSha256 必须是 64 位十六进制")
        }
    }

    if ($manifest.status -eq "source-verified") {
        if ([string]::IsNullOrWhiteSpace([string]$manifest.downloadUrl)) {
            $errors.Add("source-verified 状态缺少 downloadUrl")
        }
        if ([string]$manifest.downloadUrl -notmatch "^https://") {
            $errors.Add("source-verified 下载地址必须使用 https://")
        }
    }

    if ($manifest.status -eq "reference-verified") {
        if (-not [string]::IsNullOrWhiteSpace([string]$manifest.downloadUrl)) {
            $errors.Add("reference-verified 状态不得提前发布 downloadUrl")
        }
    }

    if ($manifest.status -eq "metadata-pending") {
        foreach ($field in @("downloadUrl", "fileSha256", "signingCertificateSha256")) {
            if (-not [string]::IsNullOrWhiteSpace([string]$manifest.$field)) {
                $errors.Add("metadata-pending 状态不得提前发布 $field")
            }
        }
    }

    foreach ($candidate in @($manifest.candidateSources)) {
        if ([string]$candidate.pageUrl -notmatch "^https://") {
            $errors.Add("候选来源页面必须使用 https://")
        }
        if ($candidate.metadataMatchesReference -eq $true) {
            if ([string]$candidate.reportedFileSha256 -ne [string]$manifest.fileSha256) {
                $errors.Add("候选来源报告的文件 SHA-256 与参考值不一致")
            }
            if (
                [string]$candidate.reportedSigningCertificateSha256 -ne
                [string]$manifest.signingCertificateSha256
            ) {
                $errors.Add("候选来源报告的签名证书 SHA-256 与参考值不一致")
            }
            if (
                [long]$candidate.reportedArtifactSizeBytes -ne
                [long]$manifest.artifactSizeBytes
            ) {
                $errors.Add("候选来源报告的文件大小与参考值不一致")
            }
        }
    }

    if ($errors.Count -gt 0) {
        if (-not $Quiet) {
            foreach ($item in $errors) {
                Write-Fail $item
            }
        }
        return $false
    }

    if (-not $Quiet) {
        Write-Pass "微信校验清单结构有效"
    }
    return $true
}

function Get-VerifiedToolArchive {
    param(
        [Parameter(Mandatory)]
        [object]$Artifact
    )

    $downloadDirectory = Join-Path $ToolsRoot "downloads"
    if (-not (Test-Path -LiteralPath $downloadDirectory)) {
        New-Item -ItemType Directory -Path $downloadDirectory | Out-Null
    }

    $archivePath = Join-Path $downloadDirectory ([string]$Artifact.fileName)
    if (Test-Path -LiteralPath $archivePath -PathType Leaf) {
        $existingHash = (
            Get-FileHash -LiteralPath $archivePath -Algorithm SHA256
        ).Hash.ToLowerInvariant()
        if ($existingHash -ne ([string]$Artifact.sha256).ToLowerInvariant()) {
            throw (
                "缓存文件校验失败：$archivePath。为避免覆盖未知文件，" +
                "请手动删除后重试。"
            )
        }
        Write-Pass "复用已校验下载：$($Artifact.fileName)"
        return $archivePath
    }

    $partialPath = Join-Path $downloadDirectory (
        ".$($Artifact.fileName)." + [guid]::NewGuid().ToString("N") + ".tmp"
    )
    $previousProgress = $ProgressPreference
    try {
        $ProgressPreference = "SilentlyContinue"
        [Net.ServicePointManager]::SecurityProtocol = (
            [Net.ServicePointManager]::SecurityProtocol -bor
            [Net.SecurityProtocolType]::Tls12
        )
        Write-Host "  正在从官方地址下载 $($Artifact.fileName)..."
        Invoke-WebRequest -UseBasicParsing `
            -Uri ([string]$Artifact.downloadUrl) `
            -OutFile $partialPath

        $actualHash = (
            Get-FileHash -LiteralPath $partialPath -Algorithm SHA256
        ).Hash.ToLowerInvariant()
        if ($actualHash -ne ([string]$Artifact.sha256).ToLowerInvariant()) {
            throw "下载文件 SHA-256 校验失败：$($Artifact.fileName)"
        }

        Move-Item -LiteralPath $partialPath -Destination $archivePath
        Write-Pass "下载及 SHA-256 校验通过：$($Artifact.fileName)"
        return $archivePath
    }
    finally {
        $ProgressPreference = $previousProgress
        if (Test-Path -LiteralPath $partialPath -PathType Leaf) {
            Remove-Item -LiteralPath $partialPath -Force
        }
    }
}

function Remove-ToolStagingDirectory {
    param(
        [Parameter(Mandatory)]
        [string]$Path
    )

    $stagingRoot = [System.IO.Path]::GetFullPath(
        (Join-Path $ToolsRoot ".staging")
    ).TrimEnd("\") + "\"
    $resolvedTarget = [System.IO.Path]::GetFullPath($Path).TrimEnd("\") + "\"
    if (-not $resolvedTarget.StartsWith(
        $stagingRoot,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw "拒绝清理工具目录之外的路径：$Path"
    }

    if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Recurse -Force
    }
}

function New-AndroidCliStagingDirectory {
    $temporaryRoot = [System.IO.Path]::GetFullPath(
        [System.IO.Path]::GetTempPath()
    ).TrimEnd("\")

    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        $name = "fgc-" + [guid]::NewGuid().ToString("N").Substring(0, 8)
        $candidate = Join-Path $temporaryRoot $name
        if (-not (Test-Path -LiteralPath $candidate)) {
            New-Item -ItemType Directory -Path $candidate | Out-Null
            return $candidate
        }
    }

    throw "无法在系统临时目录创建 Android CLI 解压目录"
}

function Remove-AndroidCliStagingDirectory {
    param(
        [Parameter(Mandatory)]
        [string]$Path
    )

    $temporaryRoot = [System.IO.Path]::GetFullPath(
        [System.IO.Path]::GetTempPath()
    ).TrimEnd("\")
    $resolvedTarget = [System.IO.Path]::GetFullPath($Path).TrimEnd("\")
    $targetParent = Split-Path $resolvedTarget -Parent
    $targetName = Split-Path $resolvedTarget -Leaf

    if (
        -not $targetParent.Equals(
            $temporaryRoot,
            [System.StringComparison]::OrdinalIgnoreCase
        ) -or
        $targetName -notmatch "^fgc-[a-f0-9]{8}$"
    ) {
        throw "拒绝清理非 FEAGLE Android CLI 临时目录：$Path"
    }

    if (Test-Path -LiteralPath $resolvedTarget) {
        Remove-Item -LiteralPath $resolvedTarget -Recurse -Force
    }
}

function Install-LocalJdk {
    param(
        [Parameter(Mandatory)]
        [string]$ArchivePath
    )

    $target = Join-Path $ToolsRoot "jdk"
    $java = Join-Path $target "bin\java.exe"
    if (Test-Path -LiteralPath $java -PathType Leaf) {
        Write-Pass "仓库本地 JDK 已就绪"
        return $target
    }
    if (Test-Path -LiteralPath $target) {
        throw "发现不完整的本地 JDK：$target。请检查或手动移走该目录。"
    }

    $stagingParent = Join-Path $ToolsRoot ".staging"
    if (-not (Test-Path -LiteralPath $stagingParent)) {
        New-Item -ItemType Directory -Path $stagingParent | Out-Null
    }
    $staging = Join-Path $stagingParent (
        "jdk-" + [guid]::NewGuid().ToString("N")
    )

    try {
        Expand-Archive -LiteralPath $ArchivePath -DestinationPath $staging
        $javaCandidate = Get-ChildItem -LiteralPath $staging `
            -Filter "java.exe" -File -Recurse |
            Where-Object {
                $_.Directory.Name -eq "bin"
            } |
            Select-Object -First 1
        if (-not $javaCandidate) {
            throw "JDK 压缩包中没有找到 bin\java.exe"
        }

        $jdkRoot = Split-Path $javaCandidate.Directory.FullName -Parent
        Move-Item -LiteralPath $jdkRoot -Destination $target
        Write-Pass "JDK 已解压到仓库本地：$target"
        return $target
    }
    finally {
        Remove-ToolStagingDirectory -Path $staging
    }
}

function Install-AndroidCommandLineTools {
    param(
        [Parameter(Mandatory)]
        [string]$ArchivePath
    )

    $sdkRoot = Join-Path $ToolsRoot "android-sdk"
    $target = Join-Path $sdkRoot "cmdline-tools\latest"
    $sdkManager = Join-Path $target "bin\sdkmanager.bat"
    if (Test-Path -LiteralPath $sdkManager -PathType Leaf) {
        Write-Pass "Android 命令行工具已就绪"
        return $sdkManager
    }
    if (Test-Path -LiteralPath $target) {
        throw "发现不完整的 Android 命令行工具：$target。请检查或手动移走该目录。"
    }

    # Android CLI contains deeply nested dependency paths. Extracting below the
    # repository can exceed the Windows PowerShell 5.1 MAX_PATH limit when the
    # repository itself is located under a long user directory.
    $staging = New-AndroidCliStagingDirectory

    try {
        Expand-Archive -LiteralPath $ArchivePath -DestinationPath $staging
        $managerCandidate = Get-ChildItem -LiteralPath $staging `
            -Filter "sdkmanager.bat" -File -Recurse |
            Select-Object -First 1
        if (-not $managerCandidate) {
            throw "Android 命令行工具中没有找到 sdkmanager.bat"
        }

        $binDirectory = $managerCandidate.Directory.FullName
        $commandLineRoot = Split-Path $binDirectory -Parent
        $targetParent = Split-Path $target -Parent
        if (-not (Test-Path -LiteralPath $targetParent)) {
            New-Item -ItemType Directory -Path $targetParent -Force |
                Out-Null
        }
        Move-Item -LiteralPath $commandLineRoot -Destination $target
        Write-Pass "Android 命令行工具已解压到：$target"
        return $sdkManager
    }
    finally {
        Remove-AndroidCliStagingDirectory -Path $staging
    }
}

function Invoke-SdkManagerText {
    param(
        [Parameter(Mandatory)]
        [string]$SdkManager,

        [Parameter(Mandatory)]
        [string[]]$Arguments,

        [switch]$ProvideLicenseConsent
    )

    $previousErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        if ($ProvideLicenseConsent) {
            $answers = 1..50 | ForEach-Object { "y" }
            $output = $answers | & $SdkManager @Arguments 2>&1
        }
        else {
            $output = & $SdkManager @Arguments 2>&1
        }
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorAction
    }

    return [pscustomobject]@{
        ExitCode = $exitCode
        Text = (($output | Out-String).Trim())
    }
}

function Invoke-ToolBootstrap {
    param(
        [switch]$LicenseAccepted,
        [switch]$PlanOnly
    )

    Write-Title "准备 Windows 本地工具链"

    if (-not (Test-ToolchainManifest -Quiet)) {
        Write-Fail "Windows 工具链清单无效"
        return $false
    }
    if ($env:OS -ne "Windows_NT") {
        Write-Fail "当前自动准备流程只支持 Windows"
        return $false
    }
    if (
        $env:PROCESSOR_ARCHITECTURE -notmatch "AMD64" -and
        $env:PROCESSOR_ARCHITEW6432 -notmatch "AMD64"
    ) {
        Write-Fail "当前自动准备流程只支持 Windows x64"
        return $false
    }

    $manifest = Get-ToolchainManifest
    Write-Host "  JDK：$($manifest.java.distribution) $($manifest.java.version)"
    Write-Host (
        "  Android CLI：revision " +
        "$($manifest.androidCommandLineTools.revision)"
    )
    Write-Host "  SDK 包：$(@($manifest.androidSdk.packages) -join ', ')"
    Write-Host "  安装位置：$ToolsRoot"
    Write-Host "  不修改系统 PATH、JAVA_HOME 或注册表"

    if ($PlanOnly) {
        Write-Pass "计划检查通过；DryRun 未下载、解压或接受许可"
        return $true
    }

    if (-not $LicenseAccepted) {
        Write-Warn "继续前必须由用户明确接受 Android SDK License"
        Write-Host "  许可页面：$($manifest.androidSdk.licenseUrl)"
        Write-Host (
            "  阅读后重新运行，并添加 -AcceptAndroidSdkLicense。"
        )
        return $false
    }

    try {
        if (-not (Test-Path -LiteralPath $ToolsRoot)) {
            New-Item -ItemType Directory -Path $ToolsRoot | Out-Null
        }

        $jdkArchive = Get-VerifiedToolArchive -Artifact $manifest.java
        $androidArchive = Get-VerifiedToolArchive `
            -Artifact $manifest.androidCommandLineTools
        $localJavaHome = Install-LocalJdk -ArchivePath $jdkArchive
        $sdkManager = Install-AndroidCommandLineTools `
            -ArchivePath $androidArchive
        $sdkRoot = Join-Path $ToolsRoot "android-sdk"
        $env:JAVA_HOME = $localJavaHome

        Write-Host "  正在记录 Android SDK 许可确认..."
        $licenses = Invoke-SdkManagerText -SdkManager $sdkManager `
            -Arguments @("--sdk_root=$sdkRoot", "--licenses") `
            -ProvideLicenseConsent
        if ($licenses.ExitCode -ne 0) {
            throw "Android SDK 许可处理失败：$($licenses.Text)"
        }

        Write-Host "  正在安装 ADB 与 Android Build Tools..."
        $packages = Invoke-SdkManagerText -SdkManager $sdkManager `
            -Arguments (
                @("--sdk_root=$sdkRoot") +
                @($manifest.androidSdk.packages)
            ) `
            -ProvideLicenseConsent
        if ($packages.ExitCode -ne 0) {
            throw "Android SDK 组件安装失败：$($packages.Text)"
        }

        $expected = @(
            (Join-Path $sdkRoot "platform-tools\adb.exe"),
            (Join-Path $sdkRoot "build-tools\34.0.0\apksigner.bat"),
            (Join-Path $sdkRoot "build-tools\34.0.0\aapt2.exe"),
            (Join-Path $sdkRoot "platforms\android-34\android.jar"),
            (Join-Path $localJavaHome "bin\java.exe")
        )
        foreach ($file in $expected) {
            if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
                throw "工具安装结束，但缺少预期文件：$file"
            }
        }

        $script:AdbExecutable = $expected[0]
        $script:ResolvedJavaHome = $localJavaHome
        $script:ApkSignerExecutable = $expected[1]
        $script:Aapt2Executable = $expected[2]
        Write-Pass "Windows 工具链已全部准备完成"
        return $true
    }
    catch {
        Write-Fail $_.Exception.Message
        return $false
    }
}

function Resolve-AdbExecutable {
    if ($script:AdbExecutable) {
        return $script:AdbExecutable
    }

    $candidates = [System.Collections.Generic.List[string]]::new()
    if (-not [string]::IsNullOrWhiteSpace($AdbPath)) {
        $candidates.Add($AdbPath)
    }
    if (-not [string]::IsNullOrWhiteSpace($env:FEAGLE_ADB_PATH)) {
        $candidates.Add($env:FEAGLE_ADB_PATH)
    }
    $candidates.Add((
        Join-Path $ProjectRoot ".tools\android-sdk\platform-tools\adb.exe"
    ))
    $candidates.Add((Join-Path $ProjectRoot ".tools\platform-tools\adb.exe"))

    $pathAdb = Get-Command adb -ErrorAction SilentlyContinue
    if ($pathAdb) {
        $candidates.Add($pathAdb.Source)
    }

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) {
            $script:AdbExecutable = (Resolve-Path -LiteralPath $candidate).Path
            return $script:AdbExecutable
        }
    }

    throw "未找到 adb.exe。请安装 Android Platform Tools，或使用 -AdbPath 指定路径。"
}

function Get-AndroidSdkCandidates {
    $candidates = [System.Collections.Generic.List[string]]::new()

    foreach ($candidate in @(
        $AndroidSdkPath,
        $env:FEAGLE_ANDROID_SDK,
        (Join-Path $ProjectRoot ".tools\android-sdk"),
        $env:ANDROID_SDK_ROOT,
        $env:ANDROID_HOME
    )) {
        if (-not [string]::IsNullOrWhiteSpace([string]$candidate)) {
            $candidates.Add([string]$candidate)
        }
    }

    return $candidates
}

function Resolve-BuildTool {
    param(
        [Parameter(Mandatory)]
        [string]$FileName
    )

    foreach ($sdkRoot in Get-AndroidSdkCandidates) {
        if (-not (Test-Path -LiteralPath $sdkRoot)) {
            continue
        }

        $buildTools = Join-Path $sdkRoot "build-tools"
        if (-not (Test-Path -LiteralPath $buildTools)) {
            continue
        }

        $match = Get-ChildItem -LiteralPath $buildTools -Directory |
            Sort-Object Name -Descending |
            ForEach-Object {
                Join-Path $_.FullName $FileName
            } |
            Where-Object {
                Test-Path -LiteralPath $_
            } |
            Select-Object -First 1

        if ($match) {
            return (Resolve-Path -LiteralPath $match).Path
        }
    }

    throw (
        "未找到 Android SDK Build Tools 中的 $FileName。请安装 Build Tools，" +
        "或使用 -AndroidSdkPath 指定 Android SDK 目录。"
    )
}

function Resolve-ApkSignerExecutable {
    if (-not $script:ApkSignerExecutable) {
        $script:ApkSignerExecutable = Resolve-BuildTool "apksigner.bat"
    }
    return $script:ApkSignerExecutable
}

function Resolve-Aapt2Executable {
    if (-not $script:Aapt2Executable) {
        $script:Aapt2Executable = Resolve-BuildTool "aapt2.exe"
    }
    return $script:Aapt2Executable
}

function Resolve-JavaHome {
    if ($script:ResolvedJavaHome) {
        return $script:ResolvedJavaHome
    }

    $candidates = [System.Collections.Generic.List[string]]::new()
    foreach ($candidate in @(
        $JavaHome,
        $env:FEAGLE_JAVA_HOME,
        (Join-Path $ProjectRoot ".tools\jdk"),
        $env:JAVA_HOME
    )) {
        if (-not [string]::IsNullOrWhiteSpace([string]$candidate)) {
            $candidates.Add([string]$candidate)
        }
    }

    $pathJava = Get-Command java -ErrorAction SilentlyContinue
    if ($pathJava) {
        $candidates.Add((Split-Path (Split-Path $pathJava.Source -Parent) -Parent))
    }

    foreach ($candidate in $candidates) {
        $javaExecutable = Join-Path $candidate "bin\java.exe"
        if (Test-Path -LiteralPath $javaExecutable) {
            $script:ResolvedJavaHome = (Resolve-Path -LiteralPath $candidate).Path
            return $script:ResolvedJavaHome
        }
    }

    throw (
        "未找到 Java。APK 签名校验需要 JDK 17；请使用 -JavaHome 指定 JDK 目录。"
    )
}

function Invoke-ExternalText {
    param(
        [Parameter(Mandatory)]
        [string]$FilePath,

        [Parameter(Mandatory)]
        [string[]]$Arguments,

        [switch]$AllowFailure
    )

    $previousErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $output = & $FilePath @Arguments 2>&1
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorAction
    }
    $text = ($output | Out-String).Trim()

    if ($exitCode -ne 0 -and -not $AllowFailure) {
        throw "外部工具执行失败：$text"
    }

    return [pscustomobject]@{
        ExitCode = $exitCode
        Text = $text
    }
}

function Invoke-AdbText {
    param(
        [Parameter(Mandatory)]
        [string[]]$Arguments,

        [switch]$AllowFailure
    )

    $adb = Resolve-AdbExecutable
    $previousErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $output = & $adb @Arguments 2>&1
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorAction
    }
    $text = ($output | Out-String).Trim()

    if ($exitCode -ne 0 -and -not $AllowFailure) {
        throw "ADB 命令失败：$text"
    }

    return [pscustomobject]@{
        ExitCode = $exitCode
        Text = $text
    }
}

function Get-ConnectedDevice {
    $null = Invoke-AdbText -Arguments @("start-server") -AllowFailure
    $result = Invoke-AdbText -Arguments @("devices") -AllowFailure
    if ($result.ExitCode -ne 0) {
        Start-Sleep -Milliseconds 500
        $result = Invoke-AdbText -Arguments @("devices") -AllowFailure
    }
    if ($result.ExitCode -ne 0) {
        throw "ADB 设备列表读取失败：$($result.Text)"
    }

    $devices = [System.Collections.Generic.List[object]]::new()

    foreach ($line in ($result.Text -split "`r?`n")) {
        if ($line -match "^([^\s]+)\s+(device|unauthorized|offline)$") {
            $devices.Add([pscustomobject]@{
                Serial = $Matches[1]
                State = $Matches[2]
            })
        }
    }

    if ($devices.Count -eq 0) {
        throw "没有发现 Android 设备。请检查 USB 数据线和 USB 调试。"
    }
    if ($devices.Count -gt 1) {
        throw "发现多台设备。首期向导要求一次只连接一台 Android 设备。"
    }
    if ($devices[0].State -eq "unauthorized") {
        throw "设备尚未授权。请解锁屏幕并确认这台电脑的 USB 调试指纹。"
    }
    if ($devices[0].State -ne "device") {
        throw "设备状态异常：$($devices[0].State)"
    }

    return $devices[0]
}

function Get-DeviceProperty {
    param([string]$Name)
    return (Invoke-AdbText -Arguments @("shell", "getprop", $Name)).Text.Trim()
}

function Get-WechatPackageInfo {
    $result = Invoke-AdbText -Arguments @(
        "shell",
        "dumpsys",
        "package",
        "com.tencent.mm"
    ) -AllowFailure

    if ($result.ExitCode -ne 0 -or $result.Text -notmatch "Package \[com\.tencent\.mm\]") {
        return $null
    }

    $versionName = $null
    $versionCode = $null
    if ($result.Text -match "versionName=([^\s]+)") {
        $versionName = $Matches[1]
    }
    if ($result.Text -match "versionCode=(\d+)") {
        $versionCode = $Matches[1]
    }

    return [pscustomobject]@{
        PackageName = "com.tencent.mm"
        VersionName = $versionName
        VersionCode = $versionCode
    }
}

function Normalize-Fingerprint {
    param([string]$Value)
    return ([string]$Value -replace "[^a-fA-F0-9]", "").ToLowerInvariant()
}

function Get-ApkInspection {
    param(
        [Parameter(Mandatory)]
        [string]$Path
    )

    $manifest = Get-WechatManifest
    $errors = [System.Collections.Generic.List[string]]::new()
    $resolvedPath = $null
    $actualSize = 0
    $actualFileSha256 = $null
    $certificateSha256 = $null
    $certificateSubject = $null
    $packageName = $null
    $versionName = $null
    $versionCode = $null
    $nativeAbis = @()

    try {
        if (-not (Test-Manifest -Quiet)) {
            throw "微信校验清单无效"
        }
        if ($manifest.status -eq "metadata-pending") {
            throw "参考文件哈希与签名证书尚未发布，不能验证 APK"
        }
        if ([string]::IsNullOrWhiteSpace($Path)) {
            throw "缺少 APK 路径。请使用 -ApkPath 指定下载文件。"
        }
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
            throw "找不到 APK 文件：$Path"
        }

        $resolvedPath = (Resolve-Path -LiteralPath $Path).Path
        if ([System.IO.Path]::GetExtension($resolvedPath) -ne ".apk") {
            throw "只接受扩展名为 .apk 的单文件安装包"
        }

        $file = Get-Item -LiteralPath $resolvedPath
        $actualSize = [long]$file.Length
        if ($actualSize -ne [long]$manifest.artifactSizeBytes) {
            throw (
                "文件大小不匹配：实际 $actualSize bytes，" +
                "参考 $($manifest.artifactSizeBytes) bytes"
            )
        }

        $actualFileSha256 = (
            Get-FileHash -LiteralPath $resolvedPath -Algorithm SHA256
        ).Hash.ToLowerInvariant()
        if (
            $actualFileSha256 -ne
            ([string]$manifest.fileSha256).ToLowerInvariant()
        ) {
            throw "文件 SHA-256 与参考安装包不一致，已停止后续解析"
        }

        # Only parse the APK after its full-file hash matches the validated reference.
        $env:JAVA_HOME = Resolve-JavaHome
        $apksigner = Resolve-ApkSignerExecutable
        $signature = Invoke-ExternalText -FilePath $apksigner -Arguments @(
            "verify",
            "--verbose",
            "--print-certs",
            $resolvedPath
        ) -AllowFailure

        if (
            $signature.ExitCode -ne 0 -or
            $signature.Text -notmatch "(?m)^Verifies\s*$"
        ) {
            throw "APK 签名结构验证失败"
        }
        if (
            $signature.Text -notmatch
            "(?m)^Signer #1 certificate SHA-256 digest:\s*([a-fA-F0-9:]+)\s*$"
        ) {
            throw "无法读取 APK 签名证书 SHA-256"
        }
        $certificateSha256 = Normalize-Fingerprint $Matches[1]
        if (
            $certificateSha256 -ne
            (Normalize-Fingerprint $manifest.signingCertificateSha256)
        ) {
            throw "APK 签名证书与参考值不一致"
        }
        if (
            $signature.Text -match
            "(?m)^Signer #1 certificate DN:\s*(.+?)\s*$"
        ) {
            $certificateSubject = $Matches[1].Trim()
        }

        $aapt2 = Resolve-Aapt2Executable
        $badging = Invoke-ExternalText -FilePath $aapt2 -Arguments @(
            "dump",
            "badging",
            $resolvedPath
        ) -AllowFailure
        if ($badging.ExitCode -ne 0) {
            throw "无法读取 APK 包信息"
        }
        if (
            $badging.Text -notmatch
            "(?m)^package:\s+name='([^']+)'\s+versionCode='([^']+)'\s+versionName='([^']+)'"
        ) {
            throw "APK 包名或版本信息缺失"
        }

        $packageName = $Matches[1]
        $versionCode = $Matches[2]
        $versionName = $Matches[3]

        if ($packageName -ne [string]$manifest.packageName) {
            throw "APK 包名不匹配：$packageName"
        }
        if ($versionName -ne [string]$manifest.versionName) {
            throw "APK 版本不匹配：$versionName"
        }
        if ([long]$versionCode -ne [long]$manifest.versionCode) {
            throw "APK versionCode 不匹配：$versionCode"
        }

        if ($badging.Text -match "(?m)^native-code:\s*(.+?)\s*$") {
            $nativeAbis = @(
                [regex]::Matches($Matches[1], "'([^']+)'") |
                    ForEach-Object {
                        $_.Groups[1].Value
                    }
            )
        }

        $supported = @($manifest.supportedAbis)
        if (
            $nativeAbis.Count -eq 0 -or
            -not @($nativeAbis | Where-Object { $_ -in $supported }).Count
        ) {
            throw (
                "APK CPU 架构不匹配：$($nativeAbis -join ', ')；" +
                "要求 $($supported -join ', ')"
            )
        }
    }
    catch {
        $errors.Add($_.Exception.Message)
    }

    return [pscustomobject]@{
        Valid = ($errors.Count -eq 0)
        Path = $resolvedPath
        SizeBytes = $actualSize
        FileSha256 = $actualFileSha256
        SigningCertificateSha256 = $certificateSha256
        SigningCertificateSubject = $certificateSubject
        PackageName = $packageName
        VersionName = $versionName
        VersionCode = $versionCode
        NativeAbis = $nativeAbis
        Errors = @($errors)
    }
}

function Write-ApkInspection {
    param(
        [Parameter(Mandatory)]
        [object]$Inspection
    )

    if (-not $Inspection.Valid) {
        foreach ($item in $Inspection.Errors) {
            Write-Fail $item
        }
        return
    }

    Write-Pass "文件大小与参考值一致：$($Inspection.SizeBytes) bytes"
    Write-Pass "文件 SHA-256 与参考值一致"
    Write-Pass "APK 签名结构验证通过"
    Write-Pass "腾讯签名证书 SHA-256 与参考值一致"
    Write-Pass (
        "包名与版本：$($Inspection.PackageName) " +
        "$($Inspection.VersionName) ($($Inspection.VersionCode))"
    )
    Write-Pass "CPU 架构：$($Inspection.NativeAbis -join ', ')"
}

function Invoke-ApkVerification {
    param(
        [Parameter(Mandatory)]
        [string]$Path
    )

    Write-Title "微信 APK 安全验证"
    $inspection = Get-ApkInspection -Path $Path
    Write-ApkInspection $inspection

    if ($inspection.Valid) {
        Write-Pass "全部验证通过：该文件与已验证参考安装包完全一致"
        Write-Host "  下一步可使用 install-wechat 并显式确认安装。"
    }
    else {
        Write-Warn "验证失败：不会安装，也不要使用该文件登录微信"
    }

    return $inspection
}

function Invoke-Doctor {
    Write-Title "FEAGLE Android 设备检查"

    try {
        $adb = Resolve-AdbExecutable
        Write-Pass "ADB：$adb"

        $device = Get-ConnectedDevice
        Write-Pass "设备已连接并授权：$($device.Serial)"

        $model = Get-DeviceProperty "ro.product.model"
        $android = Get-DeviceProperty "ro.build.version.release"
        $abi = Get-DeviceProperty "ro.product.cpu.abi"
        Write-Host "  型号：$model"
        Write-Host "  Android：$android"
        Write-Host "  ABI：$abi"

        if ($model -eq "SM-X200" -and $android -eq "14") {
            Write-Pass "设备属于当前已验证基线"
        }
        else {
            Write-Warn "设备不属于当前已验证基线，将按未经验证设备处理"
        }

        $root = Invoke-AdbText -Arguments @("shell", "su", "-c", "id") -AllowFailure
        if ($root.ExitCode -eq 0 -and $root.Text -match "uid=0") {
            Write-Pass "Root：su 可用"
        }
        else {
            Write-Fail "Root：su 不可用或未授权"
        }

        $wechat = Get-WechatPackageInfo
        if (-not $wechat) {
            Write-Warn "微信尚未安装"
        }
        elseif ($wechat.VersionName -eq "8.0.70") {
            Write-Pass "微信版本：8.0.70"
            Write-Warn "doctor 只检查版本；请运行 verify-wechat 完成安装指纹验证"
        }
        else {
            Write-Fail "微信版本不兼容：$($wechat.VersionName)"
        }

        Show-SourceStatus
        return $true
    }
    catch {
        Write-Fail $_.Exception.Message
        return $false
    }
}

function Test-AndroidSource {
    param([switch]$Quiet)

    $androidRoot = Join-Path $ProjectRoot "apps\android-agent"
    $errors = [System.Collections.Generic.List[string]]::new()
    $requiredFiles = @(
        "settings.gradle",
        "build.gradle",
        "gradlew",
        "gradlew.bat",
        "gradle\wrapper\gradle-wrapper.jar",
        "gradle\wrapper\gradle-wrapper.properties",
        "app\build.gradle",
        "app\src\main\AndroidManifest.xml",
        "app\src\main\assets\xposed_init",
        "app\src\main\java\io\github\wdclouds\feaglewxbot\agent\AgentProtocol.java",
        "app\src\main\java\io\github\wdclouds\feaglewxbot\agent\BridgeForegroundService.java",
        "app\src\main\java\io\github\wdclouds\feaglewxbot\agent\MainActivity.java",
        "app\src\main\java\io\github\wdclouds\feaglewxbot\agent\NotificationInboundAdapter.java",
        "app\src\main\java\io\github\wdclouds\feaglewxbot\agent\Wechat8070Adapter.java",
        "app\src\main\java\io\github\wdclouds\feaglewxbot\agent\WechatHook.java"
    )

    foreach ($relative in $requiredFiles) {
        if (-not (Test-Path -LiteralPath (
            Join-Path $androidRoot $relative
        ) -PathType Leaf)) {
            $errors.Add("Android 工程缺少文件：$relative")
        }
    }

    $wrapperPropertiesPath = Join-Path $androidRoot (
        "gradle\wrapper\gradle-wrapper.properties"
    )
    if (Test-Path -LiteralPath $wrapperPropertiesPath) {
        $wrapperProperties = Get-Content -Raw -Encoding UTF8 `
            -LiteralPath $wrapperPropertiesPath
        if (
            $wrapperProperties -notmatch
            "distributionUrl=https\\://mirrors\.cloud\.tencent\.com/gradle/gradle-8\.9-bin\.zip"
        ) {
            $errors.Add("Gradle Wrapper 必须使用已验证的腾讯云 Gradle 8.9 国内镜像")
        }
        if (
            $wrapperProperties -notmatch
            "distributionSha256Sum=d725d707bfabd4dfdc958c624003b3c80accc03f7037b5122c4b1d0ef15cecab"
        ) {
            $errors.Add("Gradle 8.9 distribution SHA-256 缺失或不匹配")
        }
        if ($wrapperProperties -notmatch "validateDistributionUrl=true") {
            $errors.Add("Gradle Wrapper 必须验证 distribution URL")
        }
    }

    $settingsPath = Join-Path $androidRoot "settings.gradle"
    if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
        $settings = Get-Content -Raw -Encoding UTF8 -LiteralPath $settingsPath
        foreach ($repository in @(
            "https://maven.aliyun.com/repository/google",
            "https://maven.aliyun.com/repository/central",
            "https://maven.aliyun.com/repository/gradle-plugin",
            "https://maven.aliyun.com/repository/public"
        )) {
            if (-not $settings.Contains($repository)) {
                $errors.Add("Android 依赖仓库缺少国内镜像：$repository")
            }
        }
    }

    $wrapperJarPath = Join-Path $androidRoot (
        "gradle\wrapper\gradle-wrapper.jar"
    )
    if (Test-Path -LiteralPath $wrapperJarPath -PathType Leaf) {
        $wrapperHash = (
            Get-FileHash -LiteralPath $wrapperJarPath -Algorithm SHA256
        ).Hash.ToLowerInvariant()
        if (
            $wrapperHash -ne
            "498495120a03b9a6ab5d155f5de3c8f0d986a449153702fb80fc80e134484f17"
        ) {
            $errors.Add("Gradle 8.9 Wrapper JAR SHA-256 不匹配")
        }
    }

    if (Test-Path -LiteralPath $androidRoot) {
        $sourceFiles = Get-ChildItem -LiteralPath $androidRoot -Recurse -File |
            Where-Object {
                $_.FullName -notmatch "[\\/](build|\.gradle)[\\/]"
            }
        foreach ($sourceFile in $sourceFiles) {
            if ($sourceFile.Extension -in @(".jar", ".png", ".apk")) {
                continue
            }
            $content = Get-Content -Raw -Encoding UTF8 `
                -LiteralPath $sourceFile.FullName
            if ($content -match "8\.0\.74") {
                $errors.Add(
                    "Android 源码仍包含已经废弃的微信 8.0.74：" +
                    $sourceFile.FullName
                )
            }
            if (
                $content -match "sk-[a-zA-Z0-9]{20,}" -or
                $content -match "wss?://(?:[0-9]{1,3}\.){3}[0-9]{1,3}" -or
                $content -match
                '(?i)(api[_-]?key|password|secret)\s*[:=]\s*[''"][^''"]{8,}[''"]'
            ) {
                $errors.Add("Android 源码疑似包含私密配置：$($sourceFile.FullName)")
            }
        }
    }

    $appBuildPath = Join-Path $androidRoot "app\build.gradle"
    if (Test-Path -LiteralPath $appBuildPath) {
        $appBuild = Get-Content -Raw -Encoding UTF8 -LiteralPath $appBuildPath
        if ($appBuild -notmatch 'applicationId "io\.github\.wdclouds\.feaglewxbot\.agent"') {
            $errors.Add("Android Agent applicationId 不匹配")
        }
        if ($appBuild -notmatch "compileSdk 34") {
            $errors.Add("Android Agent compileSdk 必须为 34")
        }
        if ($appBuild -notmatch "versionCode 14") {
            $errors.Add("Android Agent versionCode 必须为 14")
        }
        if ($appBuild -notmatch 'versionName "0\.6\.0"') {
            $errors.Add("Android Agent versionName 必须为 0.6.0")
        }
    }

    if ($errors.Count -gt 0) {
        if (-not $Quiet) {
            foreach ($item in $errors) {
                Write-Fail $item
            }
        }
        return $false
    }

    if (-not $Quiet) {
        Write-Pass "Android Agent 源码结构、版本门禁与 Wrapper 校验有效"
    }
    return $true
}

function Resolve-AndroidSdkRootForBuild {
    foreach ($candidate in Get-AndroidSdkCandidates) {
        if ([string]::IsNullOrWhiteSpace([string]$candidate)) {
            continue
        }
        $platformJar = Join-Path $candidate (
            "platforms\android-34\android.jar"
        )
        if (Test-Path -LiteralPath $platformJar -PathType Leaf) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    throw (
        "未找到 Android SDK Platform 34。请先运行 bootstrap-tools " +
        "-AcceptAndroidSdkLicense。"
    )
}

function Get-AgentApkInspection {
    param(
        [Parameter(Mandatory)]
        [string]$Path
    )

    $errors = [System.Collections.Generic.List[string]]::new()
    $resolvedPath = $null
    $packageName = $null
    $versionName = $null
    $versionCode = $null
    $fileSha256 = $null

    try {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
            throw "找不到 Agent APK：$Path"
        }
        $resolvedPath = (Resolve-Path -LiteralPath $Path).Path
        if ([System.IO.Path]::GetExtension($resolvedPath) -ne ".apk") {
            throw "Agent 安装文件必须是 .apk"
        }
        $fileSha256 = (
            Get-FileHash -LiteralPath $resolvedPath -Algorithm SHA256
        ).Hash.ToLowerInvariant()

        $aapt2 = Resolve-Aapt2Executable
        $badging = Invoke-ExternalText -FilePath $aapt2 -Arguments @(
            "dump",
            "badging",
            $resolvedPath
        ) -AllowFailure
        if ($badging.ExitCode -ne 0) {
            throw "无法读取 Agent APK 包信息"
        }
        if (
            $badging.Text -notmatch
            "(?m)^package:\s+name='([^']+)'\s+versionCode='([^']+)'\s+versionName='([^']+)'"
        ) {
            throw "Agent APK 缺少包名或版本信息"
        }

        $packageName = $Matches[1]
        $versionCode = $Matches[2]
        $versionName = $Matches[3]
        if (
            $packageName -ne
            $AgentPackageName
        ) {
            throw "Agent APK 包名不匹配：$packageName"
        }
        if ($versionName -ne $AgentVersionName) {
            throw "Agent APK 版本不匹配：$versionName"
        }
        if ([long]$versionCode -ne [long]$AgentVersionCode) {
            throw "Agent APK versionCode 不匹配：$versionCode"
        }
    }
    catch {
        $errors.Add($_.Exception.Message)
    }

    return [pscustomobject]@{
        Valid = ($errors.Count -eq 0)
        Path = $resolvedPath
        PackageName = $packageName
        VersionName = $versionName
        VersionCode = $versionCode
        FileSha256 = $fileSha256
        Errors = @($errors)
    }
}

function Write-AgentApkInspection {
    param(
        [Parameter(Mandatory)]
        [object]$Inspection
    )

    if (-not $Inspection.Valid) {
        foreach ($item in $Inspection.Errors) {
            Write-Fail $item
        }
        return
    }

    Write-Pass "Agent APK 包名：$($Inspection.PackageName)"
    Write-Pass (
        "Agent APK 版本：$($Inspection.VersionName) " +
        "($($Inspection.VersionCode))"
    )
    Write-Host "  APK SHA-256：$($Inspection.FileSha256)"
}

function Save-AgentBuildReceipt {
    param(
        [Parameter(Mandatory)]
        [object]$Inspection
    )

    if (-not (Test-Path -LiteralPath $ToolsRoot)) {
        New-Item -ItemType Directory -Path $ToolsRoot | Out-Null
    }
    $temporaryReceipt = Join-Path $ToolsRoot (
        ".agent-build." + [guid]::NewGuid().ToString("N") + ".tmp"
    )
    try {
        [pscustomobject]@{
            schemaVersion = 1
            packageName = $Inspection.PackageName
            versionName = $Inspection.VersionName
            versionCode = [long]$Inspection.VersionCode
            fileSha256 = $Inspection.FileSha256
            builtAt = (Get-Date).ToUniversalTime().ToString("o")
        } |
            ConvertTo-Json -Depth 3 |
            Set-Content -LiteralPath $temporaryReceipt -Encoding UTF8
        Move-Item -LiteralPath $temporaryReceipt `
            -Destination $AgentBuildReceiptPath -Force
    }
    finally {
        if (Test-Path -LiteralPath $temporaryReceipt -PathType Leaf) {
            Remove-Item -LiteralPath $temporaryReceipt -Force
        }
    }
}

function Test-AgentBuildReceipt {
    param(
        [Parameter(Mandatory)]
        [object]$Inspection
    )

    if (-not (Test-Path -LiteralPath $AgentBuildReceiptPath -PathType Leaf)) {
        Write-Fail "缺少本机 Agent 构建收据，请先运行 build-agent"
        return $false
    }

    try {
        $receipt = Get-Content -Raw -Encoding UTF8 `
            -LiteralPath $AgentBuildReceiptPath |
            ConvertFrom-Json
        if ($receipt.schemaVersion -ne 1) {
            throw "构建收据版本无效"
        }
        if ([string]$receipt.packageName -ne $Inspection.PackageName) {
            throw "构建收据包名不匹配"
        }
        if ([string]$receipt.versionName -ne $Inspection.VersionName) {
            throw "构建收据版本不匹配"
        }
        if ([long]$receipt.versionCode -ne [long]$Inspection.VersionCode) {
            throw "构建收据 versionCode 不匹配"
        }
        if (
            [string]$receipt.fileSha256 -ne
            [string]$Inspection.FileSha256
        ) {
            throw "Agent APK 与最近一次本机安全构建的 SHA-256 不一致"
        }
        Write-Pass "Agent APK 与本机构建收据一致"
        return $true
    }
    catch {
        Write-Fail $_.Exception.Message
        return $false
    }
}

function Invoke-AgentBuild {
    Write-Title "构建 FEAGLEwxbot Android Agent"

    try {
        if (-not (Test-AndroidSource -Quiet)) {
            throw "Android Agent 源码安全检查失败"
        }

        $androidRoot = Join-Path $ProjectRoot "apps\android-agent"
        $gradle = Join-Path $androidRoot "gradlew.bat"
        $env:JAVA_HOME = Resolve-JavaHome
        $sdkRoot = Resolve-AndroidSdkRootForBuild
        $env:ANDROID_SDK_ROOT = $sdkRoot
        $env:ANDROID_HOME = $sdkRoot
        $env:GRADLE_USER_HOME = Join-Path $ToolsRoot "gradle-home"

        Write-Host "  Java：$env:JAVA_HOME"
        Write-Host "  Android SDK：$sdkRoot"
        Write-Host "  Gradle：腾讯云国内镜像（固定 SHA-256）"
        if ($env:FEAGLE_USE_OFFICIAL_REPOS -eq "1") {
            Write-Host "  Maven：仅使用官方仓库（环境变量已启用）"
        }
        else {
            Write-Host "  Maven：阿里云国内镜像优先"
        }
        Write-Host "  正在执行 Gradle Debug 构建..."

        Push-Location $androidRoot
        try {
            $build = Invoke-ExternalText -FilePath $gradle -Arguments @(
                "clean",
                ":app:assembleDebug",
                "--no-daemon",
                "--stacktrace"
            ) -AllowFailure
        }
        finally {
            Pop-Location
        }

        if ($build.ExitCode -ne 0) {
            throw "Android Agent 构建失败：$($build.Text)"
        }

        $apk = Join-Path $androidRoot (
            "app\build\outputs\apk\debug\app-debug.apk"
        )
        $inspection = Get-AgentApkInspection -Path $apk
        Write-AgentApkInspection $inspection
        if (-not $inspection.Valid) {
            throw "构建产物校验失败"
        }

        Save-AgentBuildReceipt -Inspection $inspection
        Write-Pass "本机构建收据已保存到 .tools\agent-build.json"
        Write-Pass "Agent 构建完成：$apk"
        return $inspection
    }
    catch {
        Write-Fail $_.Exception.Message
        return $null
    }
}

function Get-AgentPackageInfo {
    $result = Invoke-AdbText -Arguments @(
        "shell",
        "dumpsys",
        "package",
        $AgentPackageName
    ) -AllowFailure

    if (
        $result.ExitCode -ne 0 -or
        $result.Text -notmatch
        "Package \[io\.github\.wdclouds\.feaglewxbot\.agent\]"
    ) {
        return $null
    }

    $versionName = ""
    $versionCode = ""
    if ($result.Text -match "versionName=([^\s]+)") {
        $versionName = $Matches[1]
    }
    if ($result.Text -match "versionCode=(\d+)") {
        $versionCode = $Matches[1]
    }

    return [pscustomobject]@{
        PackageName = $AgentPackageName
        VersionName = $versionName
        VersionCode = $versionCode
    }
}

function Invoke-AgentStatus {
    Write-Title "Android Agent 状态检查"

    try {
        $null = Get-ConnectedDevice
        $wechat = Get-WechatPackageInfo
        if (-not $wechat) {
            Write-Fail "微信尚未安装"
        }
        elseif ($wechat.VersionName -eq "8.0.70") {
            Write-Pass "微信版本门禁：8.0.70"
        }
        else {
            Write-Fail "微信版本不兼容：$($wechat.VersionName)"
        }

        $agent = Get-AgentPackageInfo
        if (-not $agent) {
            Write-Fail "FEAGLEwxbot Agent 尚未安装"
            return $false
        }
        Write-Pass (
            "Agent 已安装：$($agent.VersionName) ($($agent.VersionCode))"
        )

        $process = Invoke-AdbText -Arguments @(
            "shell",
            "pidof",
            "io.github.wdclouds.feaglewxbot.agent"
        ) -AllowFailure
        if ($process.ExitCode -eq 0 -and $process.Text -match "\d+") {
            Write-Pass "Agent 进程正在运行"
        }
        else {
            Write-Warn "Agent 进程尚未运行，请在平板打开 Agent"
        }

        $services = Invoke-AdbText -Arguments @(
            "shell",
            "dumpsys",
            "activity",
            "services",
            "io.github.wdclouds.feaglewxbot.agent"
        ) -AllowFailure
        if ($services.Text -match "BridgeForegroundService") {
            Write-Pass "Bridge 前台服务正在运行"
        }
        else {
            Write-Warn "Bridge 前台服务尚未启动"
        }

        $notificationAccess = Invoke-AdbText -Arguments @(
            "shell",
            "settings",
            "get",
            "secure",
            "enabled_notification_listeners"
        ) -AllowFailure
        if (
            $notificationAccess.Text -match
            "io\.github\.wdclouds\.feaglewxbot\.agent"
        ) {
            Write-Pass "通知读取兜底已由用户开启"
        }
        else {
            Write-Warn "通知读取兜底未开启（Hook 主链路不强制要求）"
        }

        $recentLogs = Invoke-AdbText -Arguments @(
            "logcat",
            "-d",
            "-v",
            "brief",
            "-s",
            "LSPosed-Bridge:I",
            "*:S"
        ) -AllowFailure
        if (
            $recentLogs.Text -match
            "FEAGLE-Hook: 8\.0\.70 inbound adapter installed"
        ) {
            Write-Pass "最近日志确认 8.0.70 Hook 适配器已加载"
        }
        elseif ($recentLogs.Text -match "FEAGLE-Hook: inactive") {
            Write-Fail "最近日志显示 Hook 因版本门禁未启用"
        }
        else {
            Write-Warn (
                "暂未在最近日志中确认 Hook；请在 LSPosed/Vector 启用模块，" +
                "作用域只选微信，然后重启微信"
            )
        }

        Write-Warn (
            "本检查不会读取 Agent 私有 Token；云端连接状态请在 Agent 页面确认"
        )
        return ($wechat -and $wechat.VersionName -eq "8.0.70")
    }
    catch {
        Write-Fail $_.Exception.Message
        return $false
    }
}

function Invoke-AgentPairing {
    param(
        [string]$HostName,
        [string]$UserName,
        [string]$Container,
        [string]$Endpoint
    )

    Write-Title "Android Agent 一次性配对"
    try {
        $null = Get-ConnectedDevice
        if ($HostName -notmatch '^[A-Za-z0-9.-]+$') {
            throw "服务器地址无效"
        }
        if ($UserName -notmatch '^[A-Za-z0-9_-]+$') {
            throw "SSH 用户名无效"
        }
        if ($Container -notmatch '^[A-Za-z0-9_.-]+$') {
            throw "容器名称无效"
        }
        if ($Endpoint -notmatch '^wss?://[A-Za-z0-9.:[\]-]+(?:/[A-Za-z0-9._~/-]*)?$') {
            throw "Bridge 地址无效；请使用不含查询参数的 ws:// 或 wss:// 地址"
        }

        $ssh = Get-Command ssh.exe -ErrorAction SilentlyContinue
        if (-not $ssh) {
            throw "未找到 Windows OpenSSH 客户端（ssh.exe）"
        }
        $remoteCommand = (
            "docker exec -e NODE_NO_WARNINGS=1 {0} " +
            "node /app/src/android-pairing-cli.js create --json"
        ) -f $Container
        $result = Invoke-ExternalText -FilePath $ssh.Source -Arguments @(
            "-o", "ConnectTimeout=15",
            "$UserName@$HostName",
            $remoteCommand
        ) -AllowFailure
        if ($result.ExitCode -ne 0) {
            throw "服务器未能生成配对码：$($result.Text)"
        }
        $jsonLine = @($result.Text -split "`r?`n" |
            Where-Object { $_ -match '^\{.*\}$' } |
            Select-Object -Last 1)
        if ($jsonLine.Count -ne 1) {
            throw "服务器返回的配对结果无法识别"
        }
        $pairing = $jsonLine[0] | ConvertFrom-Json
        $code = [string]$pairing.code
        if ($code -notmatch '^\d{8}$') {
            throw "服务器返回了无效配对码"
        }

        $activity = "$AgentPackageName/.MainActivity"
        $opened = Invoke-AdbText -Arguments @(
            "shell", "am", "start", "-S",
            "-n", $activity,
            "--es", "endpoint", $Endpoint,
            "--es", "pairing_code", $code
        ) -AllowFailure
        if ($opened.ExitCode -ne 0) {
            throw "无法在平板打开 Agent：$($opened.Text)"
        }
        Write-Pass "已在平板填入一次性配对码（5 分钟内有效）"
        Write-Host "  请在平板上确认地址，然后点击：配对并启动 / Pair & Start"
        return $true
    }
    catch {
        Write-Fail $_.Exception.Message
        return $false
    }
}

function Invoke-AgentInstall {
    param(
        [string]$Path,
        [switch]$Confirmed
    )

    Write-Title "安装 FEAGLEwxbot Android Agent"

    try {
        if ([string]::IsNullOrWhiteSpace($Path)) {
            $Path = Join-Path $ProjectRoot (
                "apps\android-agent\app\build\outputs\apk\debug\app-debug.apk"
            )
        }

        $inspection = Get-AgentApkInspection -Path $Path
        Write-AgentApkInspection $inspection
        if (-not $inspection.Valid) {
            return $false
        }
        if (-not (Test-AgentBuildReceipt -Inspection $inspection)) {
            Write-Warn "只允许安装本机 build-agent 生成且未被修改的 APK"
            return $false
        }

        if (-not $Confirmed) {
            Write-Warn "尚未获得 Agent 安装确认"
            Write-Host "  确认后重新运行并添加 -ConfirmAgentInstall"
            return $false
        }
        $null = Get-ConnectedDevice

        $install = Invoke-AdbText -Arguments @(
            "install",
            "--no-streaming",
            "-r",
            $inspection.Path
        ) -AllowFailure
        if (
            $install.ExitCode -ne 0 -or
            $install.Text -notmatch "(?m)^Success$"
        ) {
            throw "Agent ADB 安装失败：$($install.Text)"
        }

        Write-Pass "Agent 已安装或原地升级，应用数据未清除"
        Write-Warn "助手不会自动启用 LSPosed/Vector 作用域或敏感系统权限"
        return $true
    }
    catch {
        Write-Fail $_.Exception.Message
        return $false
    }
}

function Invoke-WechatVerification {
    Write-Title "微信 8.0.70 检查"

    $temporaryDirectory = $null
    try {
        $null = Get-ConnectedDevice
        $manifest = Get-WechatManifest
        $wechat = Get-WechatPackageInfo

        if (-not $wechat) {
            Write-Fail "没有安装 com.tencent.mm"
            return $false
        }

        Write-Pass "包名：$($wechat.PackageName)"
        if ($wechat.VersionName -ne $manifest.versionName) {
            Write-Fail "版本不匹配：当前 $($wechat.VersionName)，要求 $($manifest.versionName)"
            return $false
        }
        Write-Pass "版本：$($wechat.VersionName)"

        $paths = @(
            (Invoke-AdbText -Arguments @(
                "shell",
                "pm",
                "path",
                "com.tencent.mm"
            )).Text -split "`r?`n" |
                Where-Object {
                    $_ -match "^package:"
                } |
                ForEach-Object {
                    ($_ -replace "^package:", "").Trim()
                }
        )

        if ($paths.Count -ne 1 -or (Split-Path $paths[0] -Leaf) -ne "base.apk") {
            Write-Fail "当前安装不是已验证的单 base.apk 结构"
            return $false
        }

        $temporaryDirectory = Join-Path (
            [System.IO.Path]::GetTempPath()
        ) ("feagle-wechat-verify-" + [guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
        $temporaryApk = Join-Path $temporaryDirectory "base.apk"

        Write-Host "  正在从设备临时读取已安装 APK 进行指纹比对..."
        $pull = Invoke-AdbText -Arguments @(
            "pull",
            $paths[0],
            $temporaryApk
        ) -AllowFailure
        if ($pull.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $temporaryApk)) {
            Write-Fail "无法从设备读取已安装 APK：$($pull.Text)"
            return $false
        }

        $inspection = Get-ApkInspection -Path $temporaryApk
        Write-ApkInspection $inspection
        if (-not $inspection.Valid) {
            Write-Warn "已安装微信未通过完整指纹检查，不要依据本工具结论登录"
            return $false
        }

        Write-Pass "已安装微信与验证参考包完全一致"
        return $true
    }
    catch {
        Write-Fail $_.Exception.Message
        return $false
    }
    finally {
        if (
            $temporaryDirectory -and
            (Test-Path -LiteralPath $temporaryDirectory)
        ) {
            Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
        }
    }
}

function Invoke-WechatInstall {
    param(
        [Parameter(Mandatory)]
        [string]$Path,

        [switch]$Confirmed
    )

    Write-Title "安装经过验证的微信 8.0.70"
    $inspection = Get-ApkInspection -Path $Path
    Write-ApkInspection $inspection
    if (-not $inspection.Valid) {
        Write-Warn "APK 验证失败，安装已阻止"
        return $false
    }

    try {
        $null = Get-ConnectedDevice
        $existing = Get-WechatPackageInfo
        if ($existing) {
            if (
                $existing.VersionName -eq $inspection.VersionName -and
                [long]$existing.VersionCode -eq [long]$inspection.VersionCode
            ) {
                Write-Warn "设备已安装目标版本，不重复覆盖"
                return Invoke-WechatVerification
            }

            Write-Fail (
                "设备已安装微信 $($existing.VersionName) " +
                "($($existing.VersionCode))"
            )
            Write-Warn "助手不会自动卸载、降级或清除微信数据"
            Write-Warn "请先备份并由设备所有者手动处理现有版本，再重新检查"
            return $false
        }

        if (-not $Confirmed) {
            Write-Warn "文件已经通过验证，但尚未获得安装确认"
            Write-Host (
                "  确认设备中没有需要保留的微信数据后，重新运行并添加 " +
                "-ConfirmInstall"
            )
            return $false
        }

        Write-Host "  正在通过 ADB 安装..."
        $install = Invoke-AdbText -Arguments @(
            "install",
            "--no-streaming",
            $inspection.Path
        ) -AllowFailure
        if ($install.ExitCode -ne 0 -or $install.Text -notmatch "(?m)^Success$") {
            Write-Fail "ADB 安装失败：$($install.Text)"
            return $false
        }

        Write-Pass "ADB 安装完成"
        return Invoke-WechatVerification
    }
    catch {
        Write-Fail $_.Exception.Message
        return $false
    }
}

function Show-SourceStatus {
    Write-Title "微信下载源状态"
    $manifest = Get-WechatManifest

    Write-Host "  包名：$($manifest.packageName)"
    Write-Host "  版本：$($manifest.versionName)"
    Write-Host "  状态：$($manifest.status)"

    if ($manifest.status -eq "source-verified") {
        Write-Pass "下载源、文件哈希和签名证书已经发布"
    }
    elseif ($manifest.status -eq "reference-verified") {
        Write-Pass "参考文件哈希和签名证书已经确认"
        Write-Warn "尚未发布与参考指纹完全匹配的下载链接"
        foreach ($candidate in @($manifest.candidateSources)) {
            Write-Host "  候选页面：$($candidate.name)"
            if ($candidate.metadataMatchesReference -eq $true) {
                Write-Pass "候选页面报告的元数据与参考指纹一致"
            }
            if ($candidate.downloadVerifiedLocally -ne $true) {
                Write-Warn "候选文件尚未由安装助手独立下载复验"
            }
        }
    }
    else {
        Write-Warn "尚未发布下载链接"
        Write-Warn "需要先从已验证设备确认文件哈希和签名证书"
    }
}

function Show-Menu {
    while ($true) {
        Write-Title "FEAGLE Android Setup"
        Write-Host "1) 一键准备 ADB、JDK 与 Android 工具"
        Write-Host "2) 检查电脑与 Android 设备"
        Write-Host "3) 验证本地微信 APK"
        Write-Host "4) 安装已经验证的微信 APK"
        Write-Host "5) 完整检查设备中已安装的微信"
        Write-Host "6) 构建 Android Agent"
        Write-Host "7) 安装 Android Agent"
        Write-Host "8) 检查 Agent 与 Hook 状态"
        Write-Host "9) 与 ECS Bridge 一次性配对"
        Write-Host "10) 查看微信下载源状态"
        Write-Host "11) 阅读设备前置条件"
        Write-Host "0) 退出"
        Write-Host ""

        $choice = Read-Host "请选择 [0-11]"
        switch ($choice) {
            "1" {
                Write-Host (
                    "Android SDK License：" +
                    "https://developer.android.com/studio/terms"
                )
                $confirmation = Read-Host (
                    "阅读后如同意，请输入 ACCEPT ANDROID SDK LICENSE"
                )
                $null = Invoke-ToolBootstrap `
                    -LicenseAccepted:(
                        $confirmation -eq "ACCEPT ANDROID SDK LICENSE"
                    )
            }
            "2" { $null = Invoke-Doctor }
            "3" {
                $localApk = Read-Host "请输入下载完成的 APK 文件路径"
                if (-not [string]::IsNullOrWhiteSpace($localApk)) {
                    $null = Invoke-ApkVerification -Path $localApk
                }
            }
            "4" {
                $localApk = Read-Host "请输入已经验证的 APK 文件路径"
                $confirmation = Read-Host (
                    "确认设备没有需要保留的旧微信数据后，输入 INSTALL 8.0.70"
                )
                if (-not [string]::IsNullOrWhiteSpace($localApk)) {
                    $null = Invoke-WechatInstall -Path $localApk `
                        -Confirmed:($confirmation -eq "INSTALL 8.0.70")
                }
            }
            "5" { $null = Invoke-WechatVerification }
            "6" { $null = Invoke-AgentBuild }
            "7" {
                $localApk = Read-Host (
                    "Agent APK 路径（直接回车使用默认构建产物）"
                )
                $confirmation = Read-Host (
                    "确认向当前设备安装 Agent，请输入 INSTALL AGENT"
                )
                $null = Invoke-AgentInstall -Path $localApk `
                    -Confirmed:($confirmation -eq "INSTALL AGENT")
            }
            "8" { $null = Invoke-AgentStatus }
            "9" {
                $hostName = Read-Host "ECS 地址（IP 或域名）"
                $endpoint = Read-Host "平板连接地址（ws:// 或 wss://，以 /android 结尾）"
                $null = Invoke-AgentPairing `
                    -HostName $hostName `
                    -UserName "root" `
                    -Container "Feagle-wxbot" `
                    -Endpoint $endpoint
            }
            "10" { Show-SourceStatus }
            "11" {
                Write-Host (Join-Path $ProjectRoot "docs\android\01-device-requirements.md")
            }
            "0" { return }
            default { Write-Warn "无效选项" }
        }
    }
}

switch ($Command) {
    "menu" {
        Show-Menu
    }
    "doctor" {
        if (-not (Invoke-Doctor)) {
            exit 1
        }
    }
    "bootstrap-tools" {
        if (-not (Invoke-ToolBootstrap `
            -LicenseAccepted:$AcceptAndroidSdkLicense `
            -PlanOnly:$DryRun
        )) {
            exit 1
        }
    }
    "build-agent" {
        if (-not (Invoke-AgentBuild)) {
            exit 1
        }
    }
    "install-agent" {
        if (-not (Invoke-AgentInstall `
            -Path $AgentApkPath `
            -Confirmed:$ConfirmAgentInstall
        )) {
            exit 1
        }
    }
    "agent-status" {
        if (-not (Invoke-AgentStatus)) {
            exit 1
        }
    }
    "pair-agent" {
        if (-not (Invoke-AgentPairing `
            -HostName $ServerHost `
            -UserName $SshUser `
            -Container $ContainerName `
            -Endpoint $BridgeEndpoint
        )) {
            exit 1
        }
    }
    "verify-apk" {
        if ([string]::IsNullOrWhiteSpace($ApkPath)) {
            Write-Fail "请使用 -ApkPath 指定 APK 文件"
            exit 2
        }
        $result = Invoke-ApkVerification -Path $ApkPath
        if (-not $result.Valid) {
            exit 1
        }
    }
    "install-wechat" {
        if ([string]::IsNullOrWhiteSpace($ApkPath)) {
            Write-Fail "请使用 -ApkPath 指定 APK 文件"
            exit 2
        }
        if (-not (Invoke-WechatInstall -Path $ApkPath -Confirmed:$ConfirmInstall)) {
            exit 1
        }
    }
    "verify-wechat" {
        if (-not (Invoke-WechatVerification)) {
            exit 1
        }
    }
    "source-status" {
        Show-SourceStatus
    }
    "validate-manifest" {
        if (-not (Test-Manifest)) {
            exit 1
        }
    }
    "validate-toolchain" {
        if (-not (Test-ToolchainManifest)) {
            exit 1
        }
    }
    "validate-android-source" {
        if (-not (Test-AndroidSource)) {
            exit 1
        }
    }
}
