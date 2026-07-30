# FEAGLEwxbot Android Agent

Android Agent 是 FEAGLEwxbot Bridge 的可选微信接入方式。它和 Wechat4u
并列存在，不会同时消费同一个微信账号的消息。

```text
微信 8.0.70 → 版本化 Hook 适配器
  → Android Messenger/Binder
  → Agent 持久待确认队列
  → WSS 或 Tailscale 私网 WebSocket
  → ECS Android transport
  → OneBot v11
  → AstrBot

AstrBot 回复
  → ECS Android transport
  → Agent
  → 8.0.70 发送适配器
  → 微信
```

当前已验证范围只有入站私聊文本和私聊文本回复。群聊、图片、文件、历史消息读取均
不在首期范围内。Hook 入口通过微信版本硬门禁固定为 `8.0.70`；其他微信版本不会
尝试加载该适配器。`NotificationListenerService` 仍保留为受限兜底和通知回复
通道，但不是已验证主链路。

## 平板设置

已验证基线为 Android 14、Magisk/Zygisk、LSPosed/Vector 和微信 `8.0.70`。
Root、系统框架安装与设备解锁由设备所有者自行完成。

1. 安装 Agent APK，并在 LSPosed/Vector 中启用模块，作用域只选择微信。
2. 锁定微信 `8.0.70` 并关闭应用商店自动更新。
3. 打开 Agent，填写 Bridge Endpoint 和独立设备 Token。
4. 点击“保存并启动”，确认 Agent 与 Hook 均显示已连接。
5. 如需通知兜底或通知回复，再手动开启“通知读取权限”。

通知读取属于敏感系统权限，安装脚本不会静默开启。Agent 只处理
`com.tencent.mm`，日志不记录联系人或正文。通知兜底在微信位于前台、会话静音、
正文被隐藏或只显示聚合摘要时可能漏收。

## 可靠投递

每条入站事件使用稳定的 `eventId`：

1. Hook 适配器（或通知兜底）把事件交给 Agent。
2. Agent 在本机持久化事件，然后通过安全 WebSocket 发送。
3. ECS 使用 `deviceId:eventId` 在 SQLite 中声明事件。
4. ECS 成功把事件送入 OneBot 后返回 `event_ack`。
5. Agent 收到 ACK 才删除待发送事件；断线或 NACK 会重发。
6. 重放事件复用同一个 OneBot `message_id`。

Hook 事件优先使用微信消息服务端 ID 生成稳定 `eventId`；通知兜底使用通知键与
发布时间的 SHA-256 截断值，不上传原始通知键。Bridge 尚未连接时，Agent 会暂存
事件并在连接恢复后补发。

这是带持久幂等保护的“至少一次”投递。极端情况下，如果 ECS 在 WebSocket 写入
OneBot 后、更新 SQLite 前崩溃，事件可能再次写入 OneBot；相同 `message_id` 会
帮助下游识别重放，但跨两个独立系统无法承诺严格的全局恰好一次。

## 构建

需要 JDK 17、Android SDK 34 和 Gradle 8.9：

```powershell
cd android
.\gradlew.bat :app:assembleDebug
```

APK 输出到：

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

构建产物已被 `.gitignore` 排除。

## Bridge 配置

生成独立设备 Token，不要复用大模型、飞书或 SSH 密钥：

```bash
openssl rand -hex 32
```

在服务器 `.env` 中选择 Android transport：

```dotenv
WECHAT_TRANSPORT=android
ANDROID_WS_BIND_HOST=127.0.0.1
ANDROID_WS_PORT=6191
ANDROID_WS_PATH=/android
ANDROID_BRIDGE_TOKEN=替换为随机生成的设备Token

# 可选：首次成功连接后，把 Agent 页面显示的 Device ID 填到这里，
# 从而只允许这一台设备。
ANDROID_DEVICE_ID=
```

重新创建 bot 容器后，服务只通过 Docker 映射到宿主机
`127.0.0.1:6191`。不要直接开放 6191 安全组端口。

## 远程传输

### 方案 A：标准 WSS

远程 Android 设备必须使用 TLS。可在现有 HTTPS 反向代理中添加一个精确路径：

```nginx
location = /android {
    proxy_pass http://127.0.0.1:6191/android;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Authorization $http_authorization;
    proxy_read_timeout 90s;
}
```

如果反向代理也运行在 Docker 中，`proxy_pass` 应改为它能访问到的 bot
容器地址，并让两个容器加入同一个专用网络。不要为了省事使用宿主机全端口暴露。

Agent 页面填写：

```text
Endpoint: wss://你的域名/android
Token:    ANDROID_BRIDGE_TOKEN 的值
```

### 方案 B：Tailscale 私网

让 ECS 和 Android 设备加入同一个 Tailnet，不开放 `6191` 公网安全组端口：

```dotenv
ANDROID_WS_BIND_HOST=ECS 的 Tailscale IPv4
ANDROID_WS_HOST_PORT=6191
```

Agent 填写：

```text
Endpoint: ws://ECS的Tailscale-IPv4:6191/android
```

这条 `ws://` 只允许 Tailscale 的 `100.64.0.0/10` 地址，实际链路由 Tailscale
加密；普通公网明文 WebSocket 会被 Agent 拒绝。

## 安全边界

- Binder 服务只接受 Agent 自身 UID 和微信包 UID。
- WSS 或 Tailscale 私网连接必须提供 Bearer Token；服务端要求至少 24 个字符。
- 可选 `ANDROID_DEVICE_ID` 用于固定唯一设备。
- 日志不输出消息正文、完整联系人标识或 Token。
- 待确认事件保存在 Android 应用私有 SharedPreferences 中。
- 服务器联系人映射、事件收据和消息 ID 位于 `data/`，不得提交到 Git。
- 明文 `ws://` 仅允许 Android 回环地址和 Tailscale `100.64.0.0/10` 地址。

## Transport 切换

保留原来的 Wechat4u：

```dotenv
WECHAT_TRANSPORT=wechat4u
```

切换到 Android：

```dotenv
WECHAT_TRANSPORT=android
```

当前设计一次只启用一个 transport，避免一条消息从两个入口重复进入 AstrBot。

## 参考

微信 `8.0.70` 版本化适配点的研究参考了
[moluhualuo/wechat-Monitor-hook](https://github.com/moluhualuo/wechat-Monitor-hook)。
本项目没有引入其广播或文件轮询控制面，而是使用受 UID 限制的 Binder、独立
Agent、设备 Token 和服务器 ACK 收据。
