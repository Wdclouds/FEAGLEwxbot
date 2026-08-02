# Android Agent 构建、安装与状态检查

[返回 README](../../README.md) · [从零操作手册](./quickstart.md) ·
[Windows 工具链一键准备](./03-windows-toolchain.md)

## 1. 当前支持范围

Android Agent 0.6.0 支持：

- 微信 `8.0.70`。
- 入站私聊文本。
- 私聊文本回复。
- 入站群聊文本与群成员稳定 ID。
- 群聊文本回复命令。
- Hook → Binder → Agent → WSS 的持久 ACK 与事件去重。
- 通知读取作为可选兜底，不是主接收链路。

群聊默认仍由 Bridge 关闭。只有 Bridge 处于 `MENTION_ONLY`、群 ID 已加入白名单，
且微信消息对象给出明确 `@` 标记时，消息才会进入 AstrBot；无法确认 `@` 时按未提及
丢弃。通知读取兜底仍只处理私聊，不接管群聊。

图片、文件、历史消息读取和其他微信版本暂不属于已验证范围。0.6.0 的 Java/Gradle
构建和协议往返测试已通过，真实设备升级后仍应先在测试群完成一次人工收发验收。

## 2. 构建 Agent

先完成工具链准备，然后运行：

```powershell
.\tools\windows-android\feagle-android.ps1 build-agent
```

默认构建链已针对中国大陆网络做了优化，不要求用户配置代理：

- Gradle 8.9 分发包从腾讯云国内镜像下载，并继续校验官方固定 SHA-256；
- Android、Maven Central、Gradle Plugin Portal 依赖优先从阿里云镜像解析；
- GitHub Actions 自动只使用官方依赖仓库，不依赖国内镜像的可用性。

如果本机已配置可访问官方仓库的网络，也可以在当前 PowerShell 窗口中运行
`$env:FEAGLE_USE_OFFICIAL_REPOS = "1"` 后再执行 `build-agent`，临时跳过阿里云 Maven 镜像。

首次构建需要下载 Gradle 和 Android 依赖，耗时取决于本地网络。下载中断后可直接重新运行
同一条 `build-agent` 命令，已经完成且通过校验的缓存会被复用。

向导会：

1. 检查 Android 源码结构和 `8.0.70` 版本门禁。
2. 校验 Gradle Wrapper JAR 与 Gradle 8.9 分发包 SHA-256。
3. 清理上次被中断的构建临时目录。
4. 使用仓库本地 JDK 17 和 Android SDK Platform 34 构建。
5. 验证生成 APK 的包名与版本，并打印 APK SHA-256。
6. 在 `.tools/agent-build.json` 保存本机私有构建收据。

输出文件位于：

```text
apps/android-agent/app/build/outputs/apk/debug/app-debug.apk
```

APK 和构建目录均被 Git 忽略，不会进入仓库。
构建收据只保存包名、版本、SHA-256 和构建时间，不包含设备信息或 Token。

## 3. 安装 Agent

连接并授权一台 Android 设备后运行：

```powershell
.\tools\windows-android\feagle-android.ps1 install-agent `
  -ConfirmAgentInstall
```

默认安装上一步生成的 APK，也可以使用 `-AgentApkPath` 指定文件。
无论使用哪个路径，APK 都必须与最近一次本机 `build-agent` 生成的 SHA-256
完全一致；不能把任意同包名 APK 交给向导安装。

安装采用原地更新方式，不主动卸载旧 Agent，也不清除 Agent 数据。签名不一致时
ADB 会拒绝更新，向导不会为了绕过错误而自动卸载。

安装完成后，以下步骤必须由设备所有者手动完成：

1. 在 LSPosed/Vector 中启用 `FEAGLEwxbot Agent`。
2. 模块作用域只选择微信。
3. 重启微信。
4. 完成下一节的一次性配对。
5. 只有确实需要通知兜底时，才手动开启通知读取权限。

向导不会静默开启模块、修改作用域、授予通知读取权限或读取设备 Token。

## 4. 一次性配对

服务器 Bridge 更新并启动后，在 Windows 仓库目录运行：

```powershell
.\tools\windows-android\feagle-android.ps1 pair-agent `
  -ServerHost YOUR_ECS_PUBLIC_IP `
  -SshUser root `
  -BridgeEndpoint ws://100.x.y.z:6191/android
```

`ServerHost` 是 Windows 的 SSH 目标，通常是 ECS 公网 IP；`BridgeEndpoint` 是平板的
消息连接地址，Tailscale 方案必须填写 ECS 的 `100.x.y.z` 私网地址。标准 WSS 用户把
Endpoint 改为 `wss://bot.example.com/android`。完整选择见[从零操作手册](./quickstart.md)。

Tailscale 私网可以把 Endpoint 改成服务器的 `100.64.0.0/10` 地址：

```text
ws://100.x.y.z:6191/android
```

向导通过 SSH 在 `Feagle-wxbot` 容器内生成一个 5 分钟有效、只能使用一次的
8 位短码，再通过 ADB 打开 Agent 并预填地址和短码。它不会把服务器长期密钥或
设备 Token 放进 ADB 命令。用户仍需在平板确认地址并点击
“配对并启动 / Pair & Start”。

为避免前台页面保留上一枚已经失效的密码框内容，配对命令会先停止并重新打开
FEAGLE Agent 自身；不会停止微信，也不会清除 Agent 数据或模块设置。

如果设备配对成功后云端连接显示 `1008`，检查 Bridge `.env` 里是否还保留着重装前的
`ANDROID_DEVICE_ID`。应更新为当前 Agent 页面显示的设备 ID，再只重建 bot 容器。

如果显示 `invalid_or_expired_code`，该短码已经过期或被使用。重新运行 `pair-agent`
生成新码，不要重复点击旧码。配对成功后短码输入框自动清空属于正常行为。

配对成功后，Agent 自动保存随机设备 Token、清除短码并重连。Token 保存在 Android
应用私有目录；服务器 SQLite 只保存其 HMAC 摘要。旧版 Agent 的已有 Token 可以
继续使用，但新部署不再要求手工复制长期 Token。

Agent 0.5.1 起，配对成功后页面会同步清空短码输入框，并把按钮切换为
“保存并重连”。无效或不完整的短码不会删除已经保存的设备 Token。

Agent 0.6.0 起，WSS 协议新增 `group_text` 入站事件和带 `chatType=group` 的
`send_text` 命令。旧 Bridge 不理解这些字段时会拒绝群事件，因此升级 Agent 前应先升级
Bridge；私聊协议保持兼容。

## 5. 检查状态

运行：

```powershell
.\tools\windows-android\feagle-android.ps1 agent-status
```

状态检查包括：

- 微信是否安装且版本为 `8.0.70`。
- Agent 是否安装及其版本。
- Agent 进程与 Bridge 前台服务是否运行。
- 通知读取兜底是否由用户开启。
- 最近日志中是否出现 `8.0.70` Hook 适配器加载记录。

最近日志只能证明近期加载过，不等同于当前云端已经连接。云端状态仍以 Agent 页面
的“Cloud / 云端连接”为准。状态检查不会进入 Agent 私有目录读取 Token。

## 6. 常见恢复方式

如果构建被断电或强制终止，直接重新运行 `build-agent`。向导会先执行 Gradle
`clean`，避免残留的增量打包目录导致下一次构建失败。

如果没有找到 Hook：

1. 确认微信版本严格为 `8.0.70`。
2. 确认模块已启用，作用域只选择微信。
3. 强制停止并重新打开微信。
4. 再运行 `agent-status`。

不要通过扩大模块作用域、关闭系统安全机制或安装来源不明的模块来“试错”。
