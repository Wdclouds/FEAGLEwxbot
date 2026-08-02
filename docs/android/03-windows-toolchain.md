# Windows 工具链一键准备

[返回 README](../README.md) ·
[设备与 Root 前置条件](./01-device-requirements.md)

## 1. 它会准备什么

在仓库目录运行：

```powershell
.\tools\windows-android\feagle-android.ps1 bootstrap-tools `
  -AcceptAndroidSdkLicense
```

助手会把以下组件放进仓库本地的 `.tools` 目录：

| 组件 | 用途 | 安装方式 |
| --- | --- | --- |
| Microsoft Build of OpenJDK 17 | 运行 APK 签名检查工具 | 官方 ZIP，固定版本和 SHA-256 |
| Android Command-line Tools | 提供 `sdkmanager` | Google 官方 ZIP，固定版本和 SHA-256 |
| Android Platform Tools | 提供 `adb.exe` | 由官方 `sdkmanager` 安装 |
| Android Build Tools 34.0.0 | 提供 `apksigner`、`aapt2` | 由官方 `sdkmanager` 安装 |
| Android SDK Platform 34 | 编译 Android 14 Agent | 由官方 `sdkmanager` 安装 |

这个过程不需要管理员权限，不写注册表，也不永久修改系统 `PATH` 或
`JAVA_HOME`。下载缓存和安装结果都位于 `.tools`，并已被 Git 忽略。

## 2. 为什么需要许可确认

Android SDK 受 Android SDK License 约束。助手不会静默替用户接受许可。

请先阅读：

- [Android SDK License](https://developer.android.com/studio/terms)

只有在用户主动添加 `-AcceptAndroidSdkLicense` 后，助手才会下载 Android
命令行工具、执行 `sdkmanager --licenses` 并安装 SDK 组件。

如果只想查看执行计划，不下载、不解压、也不接受许可：

```powershell
.\tools\windows-android\feagle-android.ps1 bootstrap-tools -DryRun
```

## 3. 下载安全策略

- JDK 与 Android Command-line Tools 均只使用清单中的官方 HTTPS 地址。
- ZIP 下载完成后必须通过固定的 SHA-256，才允许解压。
- 校验失败的缓存不会被静默覆盖，避免把未知文件当作可信工具。
- SDK 组件只通过 Google 官方 `sdkmanager` 获取。
- Build Tools 固定为 `34.0.0`，避免不同电脑使用不一致的 APK 检查工具。

锁定值记录在
[`tools/windows-android/checks/windows-toolchain.json`](../../tools/windows-android/checks/windows-toolchain.json)。

## 4. 断线与重试

下载中断时，临时文件会被删除；重新运行同一条命令即可。

已经完整下载并通过 SHA-256 的压缩包会被复用。已经安装好的 JDK、Android
命令行工具、ADB 与 Build Tools 也会被复用，因此该命令可以重复执行。

Android 命令行工具包含很深的依赖目录。安装助手会先在系统临时目录的短路径中解压，
再移动到仓库的 `.tools/android-sdk`，因此仓库位于较长的 Windows 用户目录时也不会触发
Windows PowerShell 5.1 的传统路径长度限制。

如果提示发现“不完整目录”，助手会停止，不会擅自覆盖。请先检查提示的
`.tools` 子目录；确认里面没有需要保留的文件后，再手动移走该子目录并重试。

## 5. 完成后的下一步

连接 Android 设备并在屏幕上允许 USB 调试，然后运行：

```powershell
.\tools\windows-android\feagle-android.ps1 doctor
```

后续命令会自动优先使用仓库本地工具，不要求用户再填写 ADB、JDK 或 Android
SDK 路径。
