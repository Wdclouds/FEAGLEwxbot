# Android 接入文档

[返回项目首页](../../README.md) · [从零操作手册](./quickstart.md) ·
[设备要求](./01-device-requirements.md) ·
[微信版本验证](./02-wechat-8070-install.md) · [Windows 工具链](./03-windows-toolchain.md) ·
[Agent 构建与配对](./04-agent-build-install.md)

> [!IMPORTANT]
> 第一次部署请直接阅读[《Android Hook 从零部署操作手册》](./quickstart.md)，按照
> “服务器 → Windows → 平板”的顺序完成。下面四篇文章是专题参考，不是四套独立教程。

Android 模式由同一仓库中的两个独立模块组成：

```text
tools/windows-android/   ADB、环境检查、构建、安装和配对
apps/android-agent/     运行在已 Root Android 设备上的 Agent 与适配器
```

当前验证基线：

| 项目 | 已验证版本 |
| --- | --- |
| 设备 | Samsung Galaxy Tab A8 `SM-X200` |
| Android | 14 |
| Root | Magisk 30.7，已启用 Zygisk |
| 模块框架 | LSPosed/Vector |
| 微信 | `8.0.70` (`arm64-v8a`) |
| 电脑 | Windows 10/11 |
| Android Agent | `0.6.0` |
| 云端协议 | `feagle.android.v1` |

其他设备可以参与适配，但在真实验证前应显示为“未经验证”，不能向新手承诺兼容。

## 命令速查

在 Monorepo 根目录打开 PowerShell：

```powershell
.\feagle.cmd android bootstrap-tools -AcceptAndroidSdkLicense
.\feagle.cmd android doctor
.\feagle.cmd android verify-wechat
.\feagle.cmd android build-agent
.\feagle.cmd android install-agent -ConfirmAgentInstall
.\feagle.cmd android agent-status
.\feagle.cmd android pair-agent `
  -ServerHost YOUR_ECS_PUBLIC_IP `
  -BridgeEndpoint ws://100.x.y.z:6191/android
```

`ServerHost` 是 Windows 用来 SSH 登录 ECS 的地址；`BridgeEndpoint` 是平板访问 Bridge
的地址，二者不是同一个概念。完整网络选择与预期状态见[从零操作手册](./quickstart.md)。

也可以直接调用底层工具：

```powershell
.\tools\windows-android\feagle-android.ps1 doctor
```

工具会把 JDK、Android SDK 和下载缓存放在仓库根目录的 `.tools/`，不会永久修改系统
`PATH`、`JAVA_HOME` 或注册表。下载内容必须通过固定 SHA-256 校验；Android SDK License
仍需用户显式接受。

## 安全边界

- 工具不会替用户解锁 Bootloader 或执行 Root。
- 不会静默卸载、降级微信或清除微信数据。
- 不托管、不重新分发微信 APK。
- 未通过包名、版本、ABI、文件哈希和签名证书验证的 APK 不会自动安装。
- 仓库不保存设备 Token、配对码、微信账号数据或诊断日志。
- 模块作用域、Zygisk 和系统敏感权限必须由设备所有者确认。

微信版本参考指纹位于
[`tools/windows-android/checks/wechat-8.0.70.json`](../../tools/windows-android/checks/wechat-8.0.70.json)。
该文件记录第三方候选页面但不把它描述为官方下载源。
