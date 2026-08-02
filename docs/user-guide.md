# FEAGLEwxbot Bridge 操作步骤说明书

[返回 README](../README.md) · [项目介绍](./project-overview.md) ·
[报错与日志积累](./troubleshooting.md)

本说明书以“第一次接触 Linux 和 Docker 也能照着完成”为目标。示例中的
`your-server`、域名、Token 和 Key 都是占位符，不要把真实密钥写进公开文档或截图。

## 1. 部署前准备

### 服务器

- Linux x86_64，推荐 Ubuntu。
- Docker Engine。
- Docker Compose v2。
- `curl` 和 `tar`。
- 推荐至少 2 GB 内存、10 GB 可用磁盘。
- 能通过 SSH 登录服务器。

默认只需要 SSH 端口。Dashboard `6190` 和 AstrBot WebUI `6185` 都绑定在
`127.0.0.1`，通过 SSH 隧道访问，不需要开放公网安全组。

如果使用 Android Agent 的 Tailscale 方案，也不应把 `6191` 直接开放到公网。

### 需要提前准备的配置

- 一个 OpenAI-compatible 模型 API Key；默认向导支持 DeepSeek。
- 可选：飞书企业自建应用的 App ID 和 App Secret。
- Wechat4u 模式：一台能够扫描登录二维码的微信设备。
- Android 模式：已经由设备所有者准备好的兼容 Android 环境。

## 2. 下载项目

### 中国大陆网络说明

项目默认按中国大陆服务器配置下载源：

- Alpine：阿里云镜像；
- npm：`https://registry.npmmirror.com`；
- PyPI：`https://mirrors.aliyun.com/pypi/simple/`；
- AstrBot：国内 GitHub 加速地址优先、GitHub 官方地址回退，并强制校验固定版本的
  SHA-256。

这些默认值会写入 `.env`，需要使用私有镜像或在海外部署时可以自行替换。不要关闭
AstrBot 的 SHA-256 校验，也不要把镜像地址改为 HTTP。

Docker 基础镜像是例外：阿里云 ACR 的 Docker Hub 加速地址与账号绑定，项目不会猜测
或代填第三方公共代理。`./wxbot-bridge doctor` 会检查 Docker 是否配置了镜像加速。
如果未配置，请在阿里云控制台打开“容器镜像服务 ACR → 镜像工具 → 镜像加速器”，
复制当前账号的专属 HTTPS 地址并按页面说明配置 Docker。修改 Docker 配置会重启
Docker 服务，应避开正在处理消息的时段。

登录服务器后执行：

```bash
git clone https://ghfast.top/https://github.com/Wdclouds/FEAGLEwxbot-bridge.git
cd FEAGLEwxbot-bridge
chmod +x wxbot-bridge scripts/*.sh
```

该克隆地址已经在阿里云 ECS 实测可用。若加速入口临时不可用，可以删除
`https://ghfast.top/` 前缀，回退 GitHub 官方地址。

以后所有 Linux 命令默认都在项目根目录执行。

## 3. 运行首次配置

```bash
./wxbot-bridge setup
```

向导会依次询问：

1. 大模型供应商。
2. API 地址、模型名称和上下文长度。
3. API Key；输入时不会回显。
4. 微信接入方式：Wechat4u 或 Android Agent。
5. Android 模式的安全绑定地址与端口；配对密钥由向导自动生成且不回显。
6. 时区。
7. 机器人休眠时段，默认 `00:00-07:00`。
8. Dashboard 与 AstrBot WebUI 的宿主机端口。
9. 是否配置飞书通知；推荐扫码自动创建应用或关联已有应用，也可手动输入凭据。
10. 是否立刻构建并启动。

配置会写入项目根目录 `.env`，权限设为 `600`。如果 `.env` 已存在，重新运行向导
会先创建带时间戳的备份。

> [!IMPORTANT]
> `.env` 包含真实密钥。不要把它发到聊天、Issue、网盘公开链接或提交到 Git。

默认接入层仍是：

```dotenv
WECHAT_TRANSPORT=wechat4u
```

已经准备好兼容 Root 设备的用户可以在首次向导中直接选择 Android Agent；向导会
写入完整 Android 环境变量，后续按照 Android Kit 完成设备检查、安装和单次配对。

## 4. 启动与环境检查

如果配置向导没有立刻启动，执行：

```bash
./wxbot-bridge doctor
./wxbot-bridge start
```

`doctor` 检查 Docker、Compose、CPU 架构、基础命令、`.env` 权限和模型 Key；
Android 模式还会检查配对密钥、私网绑定地址、端口与 WebSocket 路径。
国内网络模式还会检查 npm/PyPI 地址、AstrBot 校验值，并提示 Docker Hub 加速状态。

`start` 会：

1. 再次执行环境检查。
2. 下载固定版本的 AstrBot；已经存在时跳过。
3. 构建并启动 `Feagle-wxbot` 容器。
4. 等待 Dashboard 健康检查。

启动成功后，终端会打印一条完整的 SSH 隧道命令。复制到“你自己的电脑”执行，不要
在服务器 SSH 会话中再执行一遍。

查看状态：

```bash
./wxbot-bridge status
```

查看实时日志：

```bash
./wxbot-bridge logs
```

退出实时日志只需按 `Ctrl+C`，不会停止容器。

## 5. 认识“启动成功”

启动分两层：

- `live`：Dashboard 进程已经运行。
- `ready`：微信、AstrBot 和 OneBot 都已经就绪。

首次启动只显示“服务已启动，但仍需扫码或等待 AstrBot 初始化”是正常现象。

容器状态：

```bash
docker compose ps
```

本机健康检查：

```bash
curl -fsS http://127.0.0.1:6190/api/health/live
curl -fsS http://127.0.0.1:6190/api/health/ready
```

第二条在尚未扫码或 OneBot 未连接时可能返回失败，这不等于 Docker 容器没有启动。

## 6. 访问管理页面

### macOS、Linux 或普通 SSH 客户端

在“你正在使用的电脑”上运行，不是在已经登录的服务器终端里再次运行：

```bash
ssh \
  -L 6190:127.0.0.1:6190 \
  -L 6185:127.0.0.1:6185 \
  root@your-server
```

保持该 SSH 会话开启，然后在同一台电脑浏览器打开：

- Dashboard：<http://127.0.0.1:6190>
- AstrBot WebUI：<http://127.0.0.1:6185>

如果 SSH 询问是否信任主机指纹，应先通过云控制台或已知可信渠道核对指纹；确认无误
后输入 `yes`。不要在无法核对服务器身份时盲目接受。

### Windows 后台命令

在本地仓库目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install.ps1 `
  -SshTarget root@your-server
```

重新打开 PowerShell 或 CMD：

```powershell
wxbot bridge start
wxbot bridge status
wxbot bridge exit
```

- `start`：后台建立 `6190` 与 `6185` 隧道。
- `status`：检查助手记录的 SSH 进程。
- `exit`：只关闭助手自己启动的隧道，不关闭其他 SSH 会话。

本地 PID 和日志位于 `%LOCALAPPDATA%\FEAGLEwxbot\`，不保存 SSH 密码或私钥。

## 7. Wechat4u 首次登录

确认 `.env` 中：

```dotenv
WECHAT_TRANSPORT=wechat4u
```

重新创建容器：

```bash
docker compose up -d --build bot
```

打开 Dashboard，等待二维码出现：

1. 使用微信扫描二维码。
2. 在微信设备上确认登录。
3. 等待微信状态变为 `ONLINE / HEALTHY`。
4. 等待 AstrBot 状态为 `READY`。
5. 等待 OneBot 状态为 `CONNECTED`。

Session 会保存在本机 `data/`。正常重启会优先尝试恢复登录态，不应每次都要求扫码。

## 8. AstrBot 与模型

项目会预配置：

- AstrBot WebUI：容器端口 `6185`。
- OneBot 平台：`aiocqhttp`。
- 反向 WebSocket：`127.0.0.1:6199`。
- OneBot Token：默认空，只在容器内部通信。
- 向导选择的大模型提供商与默认模型。

AstrBot 首次登录密码会写入容器日志。只在自己的终端查看，不要截图公开：

```bash
docker compose logs --tail 300 bot | grep -iE 'password|密码'
```

登录 WebUI 后检查：

1. 提供商已经启用。
2. 模型已经启用。
3. 默认对话模型指向正确模型。
4. API 地址和模型名称与供应商文档一致。

然后给机器人发送一条简短私聊文本做端到端验证。

## 9. 飞书私聊通知

飞书功能是可选项，用于通知微信意外掉线、重新扫码和恢复结果。

### 推荐：官方扫码配置

首次运行 `./wxbot-bridge setup` 时选择配置飞书，再选择：

```text
1) 扫码自动创建应用，或在授权页选择已有应用（推荐）
```

向导会使用飞书官方 Node SDK 显示二维码和授权链接。管理员扫码后，可以创建新应用，
也可以在官方授权页选择已有应用。向导只申请本项目需要的机器人能力、私聊消息读取、
以机器人身份发消息权限和 `im.message.receive_v1` 事件；返回的 App Secret 不会打印，
只会写入权限为 `600` 的 `.env`。

不同企业的管理策略不同，授权页仍可能要求管理员确认、审核或发布。以飞书开放平台
页面显示的状态为准。

### 备用：手动填写已有应用

如果无法扫码或企业禁止自动创建应用，在向导中选择手动方式。App ID 会正常显示，
App Secret 输入时不回显；粘贴后按 Enter。向导会先连接飞书验证凭据，成功后才保存。

手动创建的企业自建应用至少需要：

- 机器人能力。
- 长连接事件订阅。
- `im.message.receive_v1`。
- 私聊消息读取和机器人发消息所需权限。

完成权限配置后发布应用。若不使用向导，也可以自行把 App ID、App Secret 写入服务器
`.env`：

```dotenv
FEISHU_APP_ID=
FEISHU_APP_SECRET=
```

重新创建容器：

```bash
docker compose up -d --build bot
```

在飞书中私聊机器人发送：

```text
绑定
```

收到绑定成功消息后，可在 Dashboard 使用通知测试。

管理员主动进入 `MANUAL_OFFLINE` 时，系统不会把它当成故障，也不会持续推送二维码。

## 10. Dashboard 日常操作

### 管理员运行状态

- `RUNNING`：正常接收并回复。
- `PAUSED`：保持 Session 和心跳，丢弃新消息，不调用模型。
- `MANUAL_OFFLINE`：主动退出微信，停止自动重连和二维码通知，状态会持久化。

“强制重登测试”用于验证掉线、二维码和通知链路；“紧急离线”用于让机器人立即安静。
二者用途不同。

### 休眠时段

默认时段：

```dotenv
BOT_QUIET_HOURS=00:00-07:00
```

休眠时保持连接，但新消息不会进入模型。Dashboard 的测试开关可以临时忽略在线时间
限制；再次点击后恢复原休眠计划。

### 群聊模式

Wechat4u 与 Android Agent 共用同一套群聊安全闸门：

- `OFF`：完全不处理群消息。
- `OBSERVE`：只显示概览，不进入 AstrBot。
- `MENTION_ONLY`：只有白名单群中明确 `@` 机器人时才回复。

第一次放入群聊时先使用 `OBSERVE`，确认群 ID，再添加白名单并切换
`MENTION_ONLY`。Android 模式还要求 Hook 能确认这条消息明确 `@` 了机器人；无法
确认时会保持静默。不要在白名单未核对前开启回复。

### 设置页与通道切换

Dashboard 顶部进入“设置 / Settings”，可以修改：

- Wechat4u / Android 通道。
- 休眠时段与时区。
- 私聊长度、速率和 AstrBot 并发限制。
- 群聊冷却、回复长度、随机延迟和成员/群级速率限制。

保存普通设置或切换通道都会让 Bridge 进程自动重启。容器由 Docker 自动拉起，
`data/` 中的 AstrBot 数据、Wechat4u Session、ID 映射、控制状态和 Android 配对均保留。
模型 Key、飞书 Secret 和 Android Token 不在设置页中，应继续通过 AstrBot WebUI、
安装向导或服务器环境变量管理。
如果 Android 配对密钥尚未由 `./wxbot-bridge setup` 生成，Dashboard 会拒绝切换到
Android，避免重启后进入不可用状态。

切换后机器人 OneBot 身份保持不变，但 Web 临时联系人 ID 不能可靠等同于 Android
`wxid`。项目不会按昵称自动合并，因此跨通道首次聊天可能创建新的 AstrBot 会话。

## 11. 切换到 Android Agent

Android Agent 是高级可选接入。当前验证基线为 Android 14、Magisk/Zygisk、
LSPosed/Vector 和微信 `8.0.70`。Agent 0.6.0 增加受控群聊文本收发；通知兜底仍只处理私聊。

服务器 `.env`：

```dotenv
WECHAT_TRANSPORT=android
ANDROID_WS_BIND_HOST=127.0.0.1
ANDROID_WS_HOST_PORT=6191
ANDROID_WS_PORT=6191
ANDROID_WS_PATH=/android
ANDROID_BRIDGE_TOKEN=至少32字符的独立随机密钥
ANDROID_PAIRING_DB_PATH=/app/data/android/pairing.sqlite
ANDROID_DEVICE_ID=
```

生成 Bridge 配对密钥：

```bash
openssl rand -hex 32
```

不要复用模型 Key、飞书 Secret 或 SSH 凭据。这个值用于保护配对摘要，同时兼容
旧版 Agent；新用户不需要把它复制到平板。

远程设备必须使用：

- 标准 `wss://` 反向代理；或
- ECS 与 Android 同一 Tailnet 中的 Tailscale 私网地址。

不要把普通公网明文 `ws://` 直接暴露。完整的 APK 构建、设备配置、WSS、Tailscale、
ACK 和版本限制见
[FEAGLEwxbot Android Kit](https://github.com/Wdclouds/FEAGLEwxbot-android-kit)。

切换后重新创建容器：

```bash
docker compose up -d --build bot
```

生成一个 5 分钟有效、只能使用一次的 8 位配对码：

```bash
docker exec Feagle-wxbot node /app/src/android-pairing-cli.js create
```

在 Agent 0.5.1 或更高版本中填写 Endpoint 与配对码，点击“配对并启动”。Agent 会
自动换取设备专属 Token、保存到应用私有目录并重连；成功后短码框自动清空，
服务器数据库只保存 Token 摘要。

已配对设备的查询与吊销：

```bash
docker exec Feagle-wxbot node /app/src/android-pairing-cli.js list
docker exec Feagle-wxbot node /app/src/android-pairing-cli.js revoke 设备ID
```

## 12. 日常命令

```bash
./wxbot-bridge start      # 检查、构建并启动
./wxbot-bridge stop       # 停止 bot 容器
./wxbot-bridge restart    # 重启并等待健康检查
./wxbot-bridge status     # 查看容器与 Dashboard 状态
./wxbot-bridge logs       # 跟随最近 200 行日志
./wxbot-bridge doctor     # 重新检查环境
```

如果需要在任意目录执行命令：

```bash
sudo ./scripts/install-command.sh
wxbot-bridge
```

## 13. 备份与迁移

至少备份：

```text
.env
data/
```

其中可能包含密钥、微信 Session、联系人映射、消息收据和 AstrBot 会话。备份必须通过
加密通道传输，并存放在私密位置。

建议维护窗口：

```bash
./wxbot-bridge stop
```

完成加密备份或迁移后再启动：

```bash
./wxbot-bridge start
```

不要为了排错随意删除 `data/`。消息收据和控制状态丢失后，可能出现旧消息重新处理、
群聊闸门恢复默认或需要重新登录。

## 14. 更新代码

项目尚未提供完整的一键升级与回滚。更新前先：

1. 阅读目标版本的提交与文档。
2. 备份 `.env` 和 `data/`。
3. 确认本地没有未提交修改。

然后：

```bash
git status
git pull --ff-only
./wxbot-bridge start
```

如果 `git pull --ff-only` 拒绝执行，不要使用 `git reset --hard`。先确认本地修改来源，
再决定保留、提交或另行备份。

## 15. 停止与紧急处置

- 临时不回复但保留 Session：Dashboard 选择 `PAUSED`。
- 需要微信协议主动退出且不告警：选择 `MANUAL_OFFLINE`。
- 只停止容器：`./wxbot-bridge stop`。
- 只关闭本地 Windows 隧道：`wxbot bridge exit`。

遇到异常时不要反复重启或连续扫码。先进入
[报错与日志积累](./troubleshooting.md) 按顺序检查。
