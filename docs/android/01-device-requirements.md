# 设备与 Root 前置条件

[返回 README](../README.md) ·
[下一步：微信 8.0.70 安装与验证](./02-wechat-8070-install.md)

## 1. 首期支持范围

首期只把以下组合作为已验证基线：

```text
Samsung Galaxy Tab A8 SM-X200
Android 14
Magisk 30.7
Zygisk
LSPosed/Vector
微信 8.0.70
Windows 10/11
```

这不表示其他设备一定不能运行，只表示自动向导尚不能为其他设备提供同等级保证。

## 2. 用户需要自己完成的工作

Android Kit 不负责：

- 解锁 Bootloader。
- 获取或绕过设备厂商授权。
- Root 设备。
- 绕过应用或系统安全检查。
- 恢复因解锁、刷机或降级丢失的数据。

这些操作与具体型号、地区版本和固件有关，可能清除设备数据。必须由设备所有者
依据设备厂商和 Root 工具的官方文档自行完成。

## 3. 开始配置前的状态

开始 Windows 配置前，应满足：

- 设备能够正常开机。
- 设备所有者已经完成必要备份。
- Magisk 能正常打开。
- Zygisk 已开启并在重启后生效。
- 开发者选项与 USB 调试已开启。
- 用户能够在设备上确认当前电脑的 ADB 指纹。
- USB 数据线支持数据传输，不是仅充电线。
- 暂时不要在未经验证的微信 APK 中登录账号。

## 4. Windows 电脑要求

- Windows 10 或 Windows 11。
- 可用 USB 接口。
- PowerShell 5.1 或更新版本。
- 能够访问微软和 Google 的官方工具下载地址。
- ADB、JDK 17 与 Android SDK 不需要提前手动安装；助手会在用户明确接受
  Android SDK License 后，将它们准备到仓库本地 `.tools` 目录。

详见 [Windows 工具链一键准备](./03-windows-toolchain.md)。

## 5. 第一次设备检查

在仓库目录运行：

```powershell
.\tools\windows-android\feagle-android.ps1 doctor
```

预期输出至少包含：

```text
ADB：已找到
设备：已连接并授权
型号：SM-X200
Android：14
ABI：arm64-v8a
Root：可用
微信：未安装，或版本等待验证
```

如果出现 `unauthorized`，请解锁 Android 屏幕，确认 USB 调试授权弹窗，再重新检查。

## 6. 敏感权限原则

下列操作必须由用户在 Android 界面明确确认：

- ADB 电脑指纹。
- VPN 连接。
- 通知读取。
- 忽略电池优化。
- LSPosed/Vector 模块启用与作用域。

配置助手可以检测并指出缺少的步骤，但不能静默代替用户授权。
