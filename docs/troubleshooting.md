# FEAGLEwxbot Bridge 报错与日志积累

[返回 README](../README.md) · [项目介绍](./project-overview.md) ·
[操作步骤说明书](./user-guide.md)

本文既是排错手册，也是故障积累模板。每次确认一个新问题后，应记录“现象、判断、
处理、验证和版本”，避免以后只留下零散聊天记录。

## 1. 先不要做什么

出现故障时，先避免以下操作：

- 不要连续点击重启、强制重登或反复扫码。
- 不要直接删除 `.env`、`data/` 或 AstrBot 配置。
- 不要用 `git reset --hard` 处理不理解的 Git 状态。
- 不要把完整日志、二维码、服务器地址或密钥直接发到公开 Issue。
- 不要同时启用 Wechat4u 和 Android Agent 消费同一个账号。

这些操作可能掩盖原始原因，或导致 Session、消息收据和控制状态丢失。

### 下载依赖或构建镜像超时

先运行：

```bash
./wxbot-bridge doctor
```

默认配置已经使用国内 Alpine、npm、PyPI 和 AstrBot 下载加速。AstrBot 下载器会自动
回退官方地址，并拒绝任何 SHA-256 不一致的压缩包。如果卡在拉取 `node:22-alpine`，
通常是 Docker Hub 链路问题；请配置自己阿里云账号的 ACR 镜像加速地址，不要从陌生
教程复制公共代理。若需要临时换源，只修改 `.env` 中对应的 HTTPS 地址，并保留
`ASTRBOT_SOURCE_SHA256`。

## 2. 标准排查顺序

在项目根目录依次运行：

```bash
./wxbot-bridge doctor
./wxbot-bridge status
docker compose ps
docker compose logs --tail 300 bot
```

然后检查两个健康端点：

```bash
curl -i http://127.0.0.1:6190/api/health/live
curl -i http://127.0.0.1:6190/api/health/ready
```

判断顺序：

1. `live` 不通：先查 Docker、端口、Node 进程和容器启动日志。
2. `live` 通、`ready` 不通：查微信、AstrBot 或 OneBot 哪一个未就绪。
3. 三者都就绪但不回复：再查管理员状态、休眠、限流、群聊闸门和模型。
4. Android 模式额外检查 Agent、Hook、WebSocket 和 ACK。

## 3. 安全采集日志

### 推荐命令

保存最近 10 分钟日志：

```bash
docker compose logs --since 10m --no-color bot > feagle-diagnostic.log
```

只看包含错误的行：

```bash
docker compose logs --since 10m --no-color bot \
  | grep -iE 'error|failed|timeout|refused|unhealthy|exception'
```

Android 设备只采集 FEAGLE 标签：

```powershell
adb logcat -d | Select-String "FEAGLE"
```

### 公开前必须删除

- API Key、Bearer Token、飞书 App Secret。
- 微信二维码、Cookie、Session。
- 完整联系人标识、`open_id`、设备 ID。
- 服务器公网 IP、域名和 SSH 用户名。
- 私聊或群聊正文。

保留排错所需的时间、组件名、状态码、错误类型和脱敏事件 ID 即可。不要上传 `.env`
或整个 `data/`。

## 4. 故障条目模板

新增故障时复制以下模板：

```markdown
### TRB-XXX：一句话现象

- 首次出现：
- 影响版本：
- 接入方式：Wechat4u / Android / 两者
- 现象：
- 前置状态：
- 脱敏日志：
- 原因：
- 处理：
- 验证：
- 是否需要代码修复：
```

只有完成“验证”后，才能把推测写成已确认原因。

---

## 5. 已积累问题

### TRB-001：Dashboard 或 AstrBot WebUI 打不开

**现象**

浏览器访问 `127.0.0.1:6190` 或 `127.0.0.1:6185` 显示无法连接。

**常见原因**

- SSH 隧道没有在当前浏览器所在的电脑上运行。
- 用户已经 SSH 到服务器，又在服务器终端里执行第二层 `ssh -L`。
- 本地端口被其他进程占用。
- 容器尚未启动。

**处理**

先在服务器确认：

```bash
curl -fsS http://127.0.0.1:6190/api/health/live
docker compose ps
```

如果服务器本机可访问，在本地电脑重新建立隧道：

```bash
ssh \
  -L 6190:127.0.0.1:6190 \
  -L 6185:127.0.0.1:6185 \
  root@your-server
```

Windows 后台助手：

```powershell
wxbot bridge status
wxbot bridge exit
wxbot bridge start
```

如果报告端口占用，可为 SSH 本地侧换一个端口，例如
`-L 16190:127.0.0.1:6190`，然后访问 `http://127.0.0.1:16190`。

### TRB-002：SSH 首次连接询问主机指纹

**现象**

SSH 显示：

```text
The authenticity of host ... can't be established.
Are you sure you want to continue connecting?
```

**判断**

第一次从这台电脑连接某台服务器时可以正常出现，但不能只凭提示就确认安全。

**处理**

通过云控制台或已有可信连接核对 ED25519 指纹。完全一致时输入 `yes`；不一致时停止
连接并检查目标地址、DNS 或服务器是否重装。

### TRB-003：AstrBot WebUI 要求首次登录密码

**现象**

WebUI 显示首次登录，需要从日志查看默认密码。

**处理**

只在自己的终端运行：

```bash
docker compose logs --tail 300 bot | grep -iE 'password|密码'
```

登录后立即按照 AstrBot WebUI 提示修改密码。不要把默认密码贴进 Issue 或截图。

### TRB-004：提示“未找到任何可用的对话模型（提供商）”

**现象**

微信链路已经通，但回复为：

```text
LLM 请求失败：未找到任何可用的对话模型（提供商）。
```

**原因范围**

- `.env` 中模型被禁用或 API Key 为空。
- AstrBot 提供商或模型没有启用。
- 默认对话模型没有指向可用模型。
- 自定义 API 地址或模型名不受供应商支持。

**处理**

先检查配置是否存在，不要输出 Key：

```bash
./wxbot-bridge doctor
grep -E '^(LLM_ENABLED|LLM_PROVIDER|LLM_API_BASE|LLM_MODEL)=' .env
```

重新创建容器，让启动配置写入 AstrBot：

```bash
docker compose up -d --build bot
```

再进入 AstrBot WebUI，检查提供商、模型和默认模型均已启用。修改后用一条简短私聊
验证，不要连续发送多条测试消息。

### TRB-005：OneBot 显示未连接

**现象**

Dashboard 中 AstrBot 已启动，但 OneBot 长时间为 `DISCONNECTED`。

**判断**

Bridge 作为客户端连接容器内 AstrBot 的：

```text
ws://127.0.0.1:6199/ws
```

该端口不应映射到公网。

**处理**

```bash
docker compose logs --tail 300 bot \
  | grep -iE 'AstrBot|OneBot|6199|aiocqhttp|WebSocket'
```

确认 AstrBot 的 `wechat-onebot` 平台已启用，反向 WebSocket 端口为 `6199`，Token 与
Bridge 一致；默认都是空 Token。配置正确时重启一次容器并等待初始化完成。

### TRB-006：显示“AstrBot 当前处理队列已满”

**现象**

Dashboard 出现：

```text
AstrBot 当前处理队列已满，请稍后再试
```

**含义**

这是并发保护生效，不是微信消息丢失证明。常见于模型响应慢、短时间连续发送或上游
接口超时。

**处理**

1. 暂停发送新测试消息。
2. 等待已有请求结束。
3. 检查模型延迟、配额和错误日志。
4. 必要时临时将 Dashboard 切换为 `PAUSED`，防止继续堆积。

不要第一时间扩大 `BOT_MAX_INFLIGHT`；先确认模型和网络能够承受更高并发。

### TRB-007：重启后同一条旧消息被回复多次

**现象**

机器人恢复或重启后，对同一条历史消息连续回复。

**可能原因**

- 上游恢复流程重放旧消息。
- `data/` 中消息收据丢失或未持久化。
- 两个 transport 同时消费同一账号。
- Android 事件重试时 `eventId` 或 `deviceId` 发生变化。

**处理**

1. 先切换 `PAUSED`，停止继续回复。
2. 确认 `.env` 只有一个 `WECHAT_TRANSPORT`。
3. 确认 `data/` 挂载存在且没有被清空。
4. Android 模式确认 Agent 重试沿用同一 `eventId`，设备 ID 没有重置。
5. 保存脱敏时间线和事件 ID，再恢复测试。

当前设计会持久化消息收据。休眠期间丢弃的消息不应在早晨补发；如果仍发生重放，
应作为新故障记录，而不是视为正常现象。

### TRB-008：飞书持续推送二维码

**现象**

用户希望机器人下线，但系统认为异常掉线，不断发送二维码提醒。

**原因**

“强制重登测试”会主动验证二维码与通知链路，它不是紧急停机按钮。

**处理**

在 Dashboard 选择 `MANUAL_OFFLINE`。该状态会：

- 主动退出微信。
- 停止自动重连。
- 抑制故障与二维码通知。
- 容器重启后继续保持，直到管理员恢复。

同一轮正常异常登录最多应推送一次二维码。若 `MANUAL_OFFLINE` 下仍推送，请保留
时间戳和状态快照，作为通知状态机故障记录。

### TRB-009：Wechat4u 二维码过期或扫码后没有上线

**处理顺序**

1. 确认不是 `PAUSED` 或 `MANUAL_OFFLINE`。
2. 等待 Dashboard 生成当前二维码，不扫描旧截图。
3. 在微信设备确认登录。
4. 查看日志中的登录错误。
5. 只执行一次“强制重登测试”，不要连续点击。

Wechat4u 受微信 Web 登录策略影响。二维码长期无法登录可能是账号不再具备 Web
登录能力，不一定是服务器端口问题。

### TRB-010：容器反复 unhealthy 或重启

**现象**

`docker compose ps` 显示 `unhealthy`，或容器不断重新启动。

**处理**

```bash
docker compose ps
docker inspect Feagle-wxbot --format '{{json .State.Health}}'
docker compose logs --tail 500 bot
```

健康检查只访问 Dashboard `live` 端点。如果 `live` 失败，优先查 Node 启动异常、
依赖安装、端口绑定和 `.env` 格式，而不是微信扫码状态。

### TRB-011：宿主机端口已被占用

**现象**

Docker 报 `address already in use`，常见端口为 `6185`、`6190` 或 `6191`。

**处理**

修改 `.env` 的宿主机端口：

```dotenv
DASHBOARD_HOST_PORT=16190
ASTRBOT_WEBUI_HOST_PORT=16185
```

重新创建容器：

```bash
docker compose up -d --build bot
```

SSH 隧道右侧端口也要与新的宿主机端口一致。容器内部 OneBot `6199` 不应随意修改。

### TRB-012：Android Agent 显示“连接失败”

**检查**

1. `.env` 中 `WECHAT_TRANSPORT=android`。
2. `ANDROID_BRIDGE_TOKEN` 已在服务器设置且至少 24 个字符；Agent 0.5.1 不应手工复制它。
3. Endpoint 路径与 `ANDROID_WS_PATH=/android` 一致。
4. 标准公网远程连接使用 `wss://`。
5. Tailscale 方案中 ECS 与 Android 在同一 Tailnet。
6. `ANDROID_WS_BIND_HOST` 是 ECS 的实际 Tailscale IPv4，而不是公网 IP。
7. 容器已在修改 `.env` 后重新创建。

服务器检查：

```bash
docker compose logs --tail 300 bot | grep -iE 'Android|6191|WebSocket'
```

普通公网明文 `ws://` 会被 Agent 拒绝，这是安全限制，不应通过关闭校验绕过。

如果显示 `pairing failed`：

1. 重新生成配对码；旧码只有 5 分钟有效且只能使用一次。
2. 确认 Agent 版本至少为 `0.5.1`；0.5.0 的页面可能残留已经消费的短码。
3. 确认 Endpoint 以 `/android` 结尾。
4. 连续输错后等待 5 分钟再试，不要关闭服务端频率限制。
5. 使用 `android-pairing-cli.js list` 检查设备是否已登记；必要时先吊销再重配。

如果配对显示成功，但云端连接随后显示 `1008`，检查 `.env` 中的
`ANDROID_DEVICE_ID`。卸载重装 Agent 会生成新的设备 ID；旧白名单会允许短码兑换，
但拒绝随后的正式 `hello`。把它更新为 Agent 页面显示的新 ID 并重新创建 bot 容器。
配对 Token 本身也会绑定设备 ID，因此留空该可选白名单并不取消 Token 绑定校验。

### TRB-013：Android Agent 已连云端，但 Hook 未连接

**现象**

Agent 显示网络已连接，但 Hook 状态仍为未连接。

**检查**

- 微信版本必须是 `8.0.70`。
- LSPosed/Vector 模块已经启用。
- 作用域包含微信且没有错误扩大到无关应用。
- 微信与 Agent 在模块启用后已经按要求重启。
- Agent 前台服务仍在运行。

只采集 FEAGLE 标签日志，不公开消息正文：

```powershell
adb logcat -c
# 发送一条测试私聊后
adb logcat -d | Select-String "FEAGLE"
```

出现类似 `private text captured` 只能证明捕获层触发；还要继续确认 Binder、WSS、
OneBot 和 AstrBot 状态。

### TRB-014：Android 收到消息但没有 AI 回复

按链路逐段判断：

1. Hook 是否捕获。
2. Binder 是否把事件交给 Agent。
3. Agent 是否连到 Bridge。
4. Bridge 是否返回 `event_ack`。
5. OneBot 是否连接 AstrBot。
6. AstrBot 是否有可用模型。
7. 回复命令是否回到 Agent 和发送适配器。

不要仅凭“平板微信收到消息”就判断 Hook 正常，也不要仅凭 ACK 判断模型已经回复。
每个状态只证明它所在的那一段。

### TRB-015：飞书绑定或通知没有反应

**检查**

- App ID 与 App Secret 已写入服务器 `.env`。
- 飞书应用已发布。
- 机器人能力已启用。
- 长连接事件订阅已经发布。
- `im.message.receive_v1` 和私聊收发权限已生效。
- 用户是在私聊中发送“绑定”。
- 修改 `.env` 后已经重新创建容器。

日志：

```bash
docker compose logs --tail 300 bot | grep -iE 'Feishu|飞书|Lark'
```

不要在排错截图中显示 App Secret、访问 Token 或真实 `open_id`。

### TRB-015A：飞书扫码配置未完成

- `invalid_or_expired_code`：授权链接已过期，重新运行 `./wxbot-bridge setup` 生成新码。
- 授权页没有可选应用：确认扫码账号是目标企业管理员，或改用“创建新应用”。
- 企业策略不允许自动创建：选择手动输入，并让管理员先在开放平台创建、配置和发布。
- 显示凭据验证失败：检查应用是否属于当前租户、App Secret 是否完整，然后重试。
- 国内服务器下载扫码工具慢：向导默认使用 `https://registry.npmmirror.com`，可先运行
  `./wxbot-bridge doctor` 检查镜像配置。

向导失败时不会覆盖已有 `.env`。不要把二维码、App Secret 或 Token 发到 Issue。

### TRB-016：休眠恢复后是否会处理夜间旧消息

**预期行为**

默认 `00:00-07:00` 期间保持连接，但新消息在 Bridge 层被丢弃，不进入 AstrBot，也
不应在恢复后补处理。

如果早晨出现夜间消息重复回复：

1. 立即切换 `PAUSED`。
2. 记录消息发送时间、首次回复时间、重启时间和重复次数。
3. 检查 `data/` 是否在夜间被清理或替换。
4. 检查是否切换过 transport 或恢复过旧备份。
5. 用脱敏事件 ID 核对是否属于上游重放。

这属于需要调查的异常，不是正常休眠机制。

## 6. 提交故障记录前的最小信息

一份可用且不泄露隐私的故障记录至少包含：

- 当前 Git 提交：`git rev-parse --short HEAD`
- 操作系统与 CPU 架构。
- Docker 与 Compose 版本。
- 接入方式：Wechat4u 或 Android。
- 故障发生时间和时区。
- Dashboard 中微信、AstrBot、OneBot 的状态。
- 故障前最后一个人工操作。
- 经过脱敏的相关日志。
- 是否能够稳定复现。

不需要提供真实联系人、消息正文、服务器地址、二维码或任何密钥。
