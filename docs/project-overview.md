# FEAGLEwxbot 项目介绍

[返回 README](../README.md) · [操作步骤说明书](./user-guide.md) ·
[报错与日志积累](./troubleshooting.md)

## 1. 这个项目解决什么问题

FEAGLEwxbot Bridge 把三个原本彼此独立的部分接到一起：

1. 从微信接收消息并把回复发回微信。
2. 用 OneBot v11 把消息标准化。
3. 让 AstrBot 调用 DeepSeek 或其他 OpenAI-compatible 大模型。

它适合希望自己掌控服务器、配置和运行数据，同时又需要网页管理、休眠时段、
限流和掉线提醒的个人项目。

项目不是一个新的大模型，也不负责训练模型。它的角色是“桥接器与守护进程”：
接住消息、转换协议、保护流量、维护连接和展示运行状态。

## 2. 总体架构

```text
接收消息

┌─────────────────┐
│ Wechat4u        │
│ 或 Android Agent│
└────────┬────────┘
         │
         ▼
┌─────────────────┐    反向 WebSocket    ┌─────────────┐
│ FEAGLE Bridge   │ ───────────────────▶ │ AstrBot     │
│ 去重 / 限流 / ID│      OneBot v11      │ 对话与插件   │
└────────┬────────┘                       └──────┬──────┘
         │                                      │
         │                                      ▼
         │                               ┌─────────────┐
         │                               │ 大模型 API   │
         │                               └──────┬──────┘
         │                                      │
         └──────────── 回复原路返回 ◀───────────┘
```

管理与通知不参与消息正文的生成：

```text
Dashboard ── 状态与控制 ──▶ FEAGLE Bridge
飞书私聊  ◀─ 掉线/扫码提醒 ─ FEAGLE Bridge
```

## 3. 两种微信接入方式

| 对比项 | Wechat4u | Android Agent |
| --- | --- | --- |
| 运行位置 | 机器人 Docker 容器 | Android 设备 + 云端 Bridge |
| 登录方式 | Dashboard 二维码扫码 | Android 微信正常登录 |
| 当前验证范围 | 私聊文本；受控群聊文本 | 私聊文本；受控群聊文本 |
| 连接方式 | 微信 Web 协议 | Hook → Binder → Agent → WSS/Tailscale |
| 版本要求 | 受微信 Web 登录策略影响 | 微信固定为 `8.0.70` |
| 优点 | 部署步骤少，二维码集中管理 | 不依赖 Web 微信登录能力 |
| 主要限制 | 可能掉线或失去登录资格 | 设备准备复杂，适配与微信版本绑定 |

通过 `.env` 选择接入层：

```dotenv
WECHAT_TRANSPORT=wechat4u
```

或：

```dotenv
WECHAT_TRANSPORT=android
```

不要让两个接入层同时消费同一个账号。否则同一条消息可能以不同入口进入系统，
造成重复回复。

## 4. 核心组件

### FEAGLE Bridge

Node.js 服务，是项目的控制中心，负责：

- 启动并监督 AstrBot。
- 管理微信接入层。
- 在微信事件与 OneBot v11 之间转换。
- 维护微信字符串 ID 与 OneBot 数字 ID 的稳定映射。
- 执行消息长度、频率、并发和重复事件保护。
- 提供 Dashboard、健康检查和管理员控制。
- 触发飞书掉线、二维码与恢复通知。

### AstrBot

负责对话管理、模型调用和插件生态。Bridge 会为 AstrBot 创建一个
`aiocqhttp` 平台，并通过容器内的 `ws://127.0.0.1:6199/ws` 连接。

`6199` 只用于同一容器内部通信，不需要映射到宿主机或开放云安全组。

### Dashboard

默认映射到宿主机 `127.0.0.1:6190`，用于：

- 查看微信、AstrBot 和 OneBot 状态。
- 查看二维码和有限的消息概览。
- 切换正常、暂停或紧急离线状态。
- 管理休眠测试、群聊闸门和本地文字策略。
- 查看 Android WSS、设备、Hook、心跳与待确认命令状态。
- 在安全白名单内修改通道、休眠、限流、并发与群聊缓冲参数。
- 手动测试登录与通知链路。

Dashboard 不读取或返回模型 API Key、飞书 Secret、Android Token 和原始 `.env`。
所有网页写操作要求同源请求和专用请求头；Docker 仍默认把面板绑定到宿主机回环地址。

### Android Agent

Android 接入模式由四层组成：

```text
微信 8.0.70
  → 版本化 Hook 适配器
  → Android Messenger/Binder
  → 独立前台 Agent
  → WSS 或 Tailscale 私网 WebSocket
  → FEAGLE Bridge
```

Hook 只负责捕获和注入消息；Agent 负责持久队列、心跳、重连和云端通信。两层分离，
可以避免把网络状态和消息可靠性全部塞进微信进程。

## 5. 一条消息怎样走完

以私聊文本为例：

1. 微信接入层收到文本并生成稳定事件标识。
2. Bridge 检查管理员状态、休眠时段、消息年龄、长度、重复记录和速率。
3. Bridge 把微信标识映射为稳定的 OneBot 数字 ID。
4. Bridge 向 AstrBot 的反向 WebSocket 写入 OneBot v11 `message` 事件。
5. AstrBot 把对话交给已经启用的模型。
6. 模型回复返回 AstrBot。
7. AstrBot 调用 OneBot 发送动作。
8. Bridge 找回原微信联系人标识，通过当前接入层发出文本。

Android 模式还会使用 `event_ack`：

1. Agent 先把待发送事件写入设备本地持久队列。
2. 云端成功接纳事件后返回 ACK。
3. Agent 收到 ACK 才从待发送队列移除事件。
4. 断线重试沿用同一个 `eventId`，云端收据和稳定 `message_id` 用于抑制重复投递。

该设计提供“至少一次投递 + 幂等保护”，但不声称跨多个独立系统实现数学意义上的
全局恰好一次。

## 6. 运行保护

### 私聊保护

- 最大消息长度和最大消息年龄。
- 单用户与全局速率限制。
- 全局与单用户并发限制。
- 持久化消息收据，减少重启后旧消息重复回复。

### 群聊闸门

Wechat4u 与 Android 模式共用三种群聊状态：

- `OFF`：不进入 AstrBot，不调用模型。
- `OBSERVE`：只显示本地概览，不进入 AstrBot，不回复。
- `MENTION_ONLY`：仅白名单群中明确 `@` 机器人时进入 AstrBot。

群聊还具有成员级与群级限流、发送冷却、回复长度限制、随机缓冲和按群熔断。
白名单为空时，`MENTION_ONLY` 仍然不会回复任何群。

### 管理员状态

- `RUNNING`：正常处理消息。
- `PAUSED`：保持连接和 Session，但丢弃新消息，不调用模型。
- `MANUAL_OFFLINE`：主动退出并停止自动重连、二维码和故障通知，直到管理员恢复。

默认休眠时段为 `00:00-07:00`。休眠期间收到的新消息会被丢弃，不应在恢复后补发。

## 7. 数据与隐私边界

公开仓库不需要真实运行数据。以下内容只应保存在部署机器：

| 内容 | 默认位置 |
| --- | --- |
| 模型与飞书密钥、端口和开关 | `.env` |
| 微信 Session、ID 映射、控制状态和 AstrBot 数据 | `data/` |
| Dashboard 安全设置 | `data/bridge-settings.json` |
| Android 设备 Token | 服务器 `.env` 与 Android 应用私有存储 |
| Windows SSH 隧道配置 | `%LOCALAPPDATA%\\FEAGLEwxbot\\` |

Dashboard 和 AstrBot WebUI 默认只监听宿主机回环地址。Android 远程连接应使用标准
WSS，或仅绑定 Tailscale 私网地址；不要把明文 WebSocket 直接暴露到公网。

更完整的提交与漏洞报告规则见 [安全策略](../SECURITY.md)。

切换通道不会清除上述数据，并使用固定的 OneBot `self_id` 保持机器人平台身份。
但 Wechat4u 的联系人/群临时标识与 Android 的 `wxid`/`@chatroom` 标识并不等价；
项目不会按昵称自动合并，以免同名联系人串话。因此同一联系人跨通道首次出现时，
AstrBot 仍可能把它识别为一段新会话。

## 8. 当前能力与限制

当前重点：

- 私聊文本接收与回复。
- Wechat4u 群消息观察，以及白名单群内被 `@` 后的文本回复。
- Docker 单机部署。
- Dashboard 管理、休眠和紧急离线。
- 微信会话健康检查与自愈。
- 消息去重、限流和熔断。
- 飞书私聊通知。
- Android `8.0.70` 私聊文本接入。
- Android `8.0.70` 群聊文本接收与回复命令。
- Dashboard Android 状态诊断、通道切换和安全设置页。

当前限制：

- 群聊不支持图片、文件和引用消息。
- Android 群聊只有在 Hook 提供明确 `@` 标记时才会进入 AstrBot；无法确认时按未提及丢弃。
- Wechat4u 群成员资料可能不完整。
- 微信 Web 协议或 Android 客户端更新都可能导致接入失效。
- 个别 OpenAI-compatible 提供商仍可能需要在 AstrBot WebUI 手动调整字段。
- 尚无完整的一键升级与回滚流程。

## 9. 仓库结构

```text
.
├── apps/
│   ├── android-agent/      # Android Agent 与 8.0.70 适配器
│   └── bridge/
│       ├── src/            # Bridge、微信、OneBot、AstrBot、Dashboard
│       └── test/           # Node.js 自动化测试与手动冒烟入口
├── tools/
│   ├── windows-android/    # ADB、构建、安装、验证与配对
│   └── windows-bridge/     # Dashboard/AstrBot SSH 隧道工具
├── packages/protocol/      # Android Agent ↔ Bridge 协议契约
├── docs/                   # 项目说明、Android 指南和故障积累
├── scripts/                # 服务器安装、检查与下载脚本
├── .env.example            # 不含真实密钥的配置模板
├── docker-compose.yml
├── feagle                   # Monorepo 统一命令入口
└── wxbot-bridge             # 服务器 Bridge 兼容入口
```

## 10. 上游与许可

- [AstrBot](https://github.com/AstrBotDevs/AstrBot)
- [Wechat4u](https://github.com/nodeWechat/wechat4u)
- [OneBot 11](https://github.com/botuniverse/onebot-11)
- Android `8.0.70` 适配研究参考
  [moluhualuo/wechat-Monitor-hook](https://github.com/moluhualuo/wechat-Monitor-hook)

仓库目前尚未选择开源许可证。在许可证确定前，请不要假定拥有再分发或商业使用授权。
