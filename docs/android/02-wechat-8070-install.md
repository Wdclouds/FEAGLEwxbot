# 微信 8.0.70 安装与验证

[返回 README](../../README.md) · [从零操作手册](./quickstart.md) ·
[上一步：设备与 Root 前置条件](./01-device-requirements.md)

## 1. 为什么不能直接提供一个随意搜索的链接

Android Agent 当前固定适配微信 `8.0.70`，但历史版本 APK 可能来自第三方归档站。
用户会在 Root 设备上登录真实账号，因此错误签名、被修改的安装包或失效链接都属于
高风险情况。

本项目只在同时具备以下信息时发布下载源：

- 包名为 `com.tencent.mm`。
- 版本名为 `8.0.70`。
- 文件 SHA-256 已记录。
- 签名证书 SHA-256 已记录。
- CPU ABI 与支持设备一致。
- 来源和验证日期已经记录。

当前校验状态见
[`tools/windows-android/checks/wechat-8.0.70.json`](../../tools/windows-android/checks/wechat-8.0.70.json)。

清单状态含义：

- `metadata-pending`：参考安装包的指纹尚未确认。
- `reference-verified`：已从验证设备取得文件与签名指纹，但没有可信下载源。
- `source-verified`：候选下载文件与参考指纹完全一致，可以由安装助手使用。

只有 `source-verified` 才表示项目已经发布可供新手直接使用的下载源。

### 当前第三方候选页面

[APKMirror：WeChat 8.0.70 / 3060 / arm64-v8a](https://www.apkmirror.com/apk/wechat/wechat/wechat-8-0-70-release/wechat-8-0-70-android-apk-download/)

截至 `2026-07-31`，该页面报告的以下信息与参考设备完全一致：

- 文件大小：`255119524` bytes。
- 文件 SHA-256：
  `65808aa07d48d2ee2079ee4b1abfda3ca318482259f19a4d942bee0372f61079`。
- 签名证书 SHA-256：
  `0fe4ff85c215918396dadc7cd8ce6963339af33d37751a56e54c7206b63a3c7c`。
- 签名主体为 Tencent。

APKMirror 是第三方归档站，不是微信官方渠道。页面报告值一致仍不能替代安装助手
对实际下载文件的再次校验，因此清单继续保持 `reference-verified`。

## 2. 正确顺序

```text
获得候选 APK
→ 先不要登录
→ 校验文件 SHA-256
→ 校验包名、版本和签名证书
→ 校验通过后安装
→ 再登录微信
→ 确认 Hook 与 Agent
→ 完成私聊收发测试
```

不要采用：

```text
下载 → 登录账号 → 出问题后再检查
```

## 3. 推荐方式：由 Windows 助手处理

当前配置助手会：

1. 读取用户已经下载到电脑的 APK。
2. 在解析 APK 前先检查文件大小和 SHA-256。
3. 使用 Android SDK `apksigner` 检查签名证书。
4. 使用 `aapt2` 检查包名、版本和 ABI。
5. 完全匹配后才允许执行 ADB 安装。
6. 安装需要用户显式添加 `-ConfirmInstall`。
7. 安装后再次从设备读取 APK 并完成同样的指纹检查。

只要文件大小、哈希、签名、包名、版本或 ABI 任意一项变化，助手就停止，不提供
“忽略警告并继续”。

需要 Windows PowerShell 5.1、JDK 17 和 Android SDK Build Tools。尚未实现工具依赖
自动下载时，可以显式指定路径：

```powershell
.\tools\windows-android\feagle-android.ps1 verify-apk `
  -ApkPath C:\Downloads\wechat-8.0.70.apk `
  -AndroidSdkPath C:\Android\Sdk `
  -JavaHome C:\Java\jdk-17
```

验证通过后安装：

```powershell
.\tools\windows-android\feagle-android.ps1 install-wechat `
  -ApkPath C:\Downloads\wechat-8.0.70.apk `
  -AndroidSdkPath C:\Android\Sdk `
  -JavaHome C:\Java\jdk-17 `
  -ConfirmInstall
```

如果设备已经安装其他微信版本，助手会停止。它不会自动卸载、降级或清除用户数据。

## 4. 备用方式：用户在平板手动下载

如果后续确实需要在平板浏览器中下载：

1. 打开校验清单记录的候选页面，不要使用转载页面或缩短链接。
2. 下载后先不要打开微信，也不要输入账号。
3. 通过 USB 连接 Windows 电脑。
4. 运行：

   ```powershell
   .\tools\windows-android\feagle-android.ps1 verify-apk `
     -ApkPath C:\Downloads\wechat-8.0.70.apk
   ```

5. 只有工具同时确认文件、版本和签名后，才执行安装。
6. 安装后运行：

   ```powershell
   .\tools\windows-android\feagle-android.ps1 verify-wechat
   ```

7. 已安装包再次通过完整检查后，才进入登录步骤。

`verify-wechat` 会把设备中的 APK 拉取到随机临时目录，校验完成后立即删除，不上传
或保留 APK，也不读取微信账号和消息数据。

## 5. 登录后的确认

签名验证通过后：

1. 用户自己打开微信。
2. 用户自己完成账号登录和必要验证。
3. 用户确认能够进入聊天列表并人工收发一条消息。
4. 这里没有“我已登录”按钮；登录状态由用户在微信界面自行确认。
5. 后续 `agent-status` 只检查微信进程、Hook、Binder 和 Agent 状态，不读取或展示
   微信号、手机号、联系人和消息正文。

最终需要从另一个账号发送一条明确的测试文本，逐段确认：

```text
Hook 捕获
→ Binder 交付
→ Agent 发送
→ Bridge ACK
→ OneBot
→ AstrBot
→ 模型
→ 回复返回微信
```

## 6. 版本与自动更新

Hook 适配器会对微信版本做硬门禁。不是 `8.0.70` 时不应尝试加载已验证适配器。

应用商店可能把微信升级到新版本。安装完成后应关闭微信自动更新，并在每次启动
Agent 时重新检查实际版本。发现版本变化时，系统应停止 Hook 并给出明确提醒，而
不是继续尝试运行。

## 7. 后续如何发布可信元数据

已经从验证工作的设备提取：

- 当前安装包路径与拆分包情况。
- APK 文件 SHA-256。
- 签名证书 SHA-256。
- 包名、版本名、版本代码和 ABI。

仓库只提交这些元数据，不提交微信 APK、账号信息或设备标识。下一步找到候选下载
源后重新下载并比对；只有完全一致，才把清单状态改为 `source-verified`。
