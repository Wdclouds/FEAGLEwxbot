# FEAGLEwxbot

一个面向个人自托管场景的微信机器人 Monorepo。它把微信消息转换成 OneBot v11 事件交给
AstrBot，并把回复沿原通道送回微信。

```text
Wechat4u ─┐
          ├─ FEAGLE Bridge ⇄ OneBot v11 ⇄ AstrBot
Android ──┘
```

项目提供两种互斥的微信接入方式：

- `Wechat4u`：部署步骤少，通过 Dashboard 显示二维码。
- `Android Agent`：固定适配微信 `8.0.70`，由已 Root Android 设备主动连接 Bridge。

两条链路目前都支持私聊文本和受控群聊文本。相同微信账号一次只能启用一个接入方式，
避免重复投递和重复回复。

> [!WARNING]
> 本项目使用非官方微信接入方式，可能受到登录策略、客户端版本和账号风控影响。
> 请使用能够承担掉线或限制风险的账号。本项目不隶属于微信、腾讯或 AstrBot。

## Monorepo 模块

| 模块 | 位置 | 独立产物 |
| --- | --- | --- |
| Bridge 与 Dashboard | [`apps/bridge/`](./apps/bridge/) | Docker 镜像 |
| Android Agent | [`apps/android-agent/`](./apps/android-agent/) | APK |
| Windows Android 工具 | [`tools/windows-android/`](./tools/windows-android/) | PowerShell 工具链 |
| Windows SSH 隧道工具 | [`tools/windows-bridge/`](./tools/windows-bridge/) | 本机管理命令 |
| Agent ↔ Bridge 协议 | [`packages/protocol/`](./packages/protocol/) | Schema 与兼容清单 |
| 服务器部署工具 | [`scripts/`](./scripts/) | Shell 安装与诊断命令 |

这些模块在同一个仓库中协作，但仍然分别构建和发布。Android、Windows 工具不会被打进
服务器 Docker 镜像，Bridge 也不会被打进 APK。

Skill 暂不属于本次 Monorepo 迁移，后续会单独设计其职责和调用边界。

## 文档

| 文档 | 内容 |
| --- | --- |
| [项目介绍](./docs/project-overview.md) | 架构、数据流、安全设计和限制 |
| [部署与操作说明](./docs/user-guide.md) | 服务器部署、Dashboard、模型、飞书和日常管理 |
| [Android 接入工具](./docs/android/index.md) | 设备要求、构建、安装、验证和配对 |
| [报错与日志积累](./docs/troubleshooting.md) | 常见异常、排查顺序和脱敏日志 |
| [共享协议](./packages/protocol/README.md) | Android Agent 与 Bridge 的协议契约 |
| [安全策略](./SECURITY.md) | 隐私边界和漏洞报告 |

## 服务器快速开始

服务器需要 Linux x86_64、Docker Engine、Docker Compose v2、`curl` 和 `tar`。推荐至少
2 GB 内存和 10 GB 可用磁盘。

```bash
git clone https://ghfast.top/https://github.com/Wdclouds/FEAGLEwxbot-bridge.git
cd FEAGLEwxbot-bridge
chmod +x feagle wxbot-bridge scripts/*.sh
./feagle bridge setup
```

中国大陆默认可保留 `ghfast.top` 前缀；海外网络或加速入口不可用时删除该前缀即可。
Alpine、npm 和 PyPI 默认使用国内镜像。AstrBot 下载无论来自加速地址还是官方地址，均须
通过固定 SHA-256 校验。

常用服务器命令：

```bash
./feagle bridge doctor
./feagle bridge start
./feagle bridge status
./feagle bridge logs
./feagle bridge stop
```

原有 `./wxbot-bridge` 命令仍保留兼容。

## Android 快速开始

在 Windows 10/11 克隆同一个仓库，连接已由设备所有者完成 Root、Zygisk 与 USB 调试准备的
Android 设备，然后运行：

```powershell
.\feagle.cmd android bootstrap-tools -AcceptAndroidSdkLicense
.\feagle.cmd android doctor
.\feagle.cmd android verify-wechat
.\feagle.cmd android build-agent
```

工具不会替用户 Root、不会静默卸载微信，也不会安装未经指纹验证的 APK。完整步骤见
[Android 接入工具](./docs/android/index.md)。

Windows 上的 Dashboard SSH 隧道仍可通过以下命令管理：

```powershell
.\feagle.cmd bridge start
.\feagle.cmd bridge status
.\feagle.cmd bridge exit
```

## 版本与协议

产品版本记录在 [`VERSION`](./VERSION)，组件兼容关系记录在
[`packages/protocol/compatibility.json`](./packages/protocol/compatibility.json)。当前基线为：

```text
FEAGLEwxbot       0.6.0
Bridge            0.5.0
Android Agent     0.6.0
Android Protocol  feagle.android.v1
WeChat baseline   8.0.70
```

执行以下命令可以检查服务端、Agent 和 Schema 是否仍使用同一协议：

```bash
./feagle protocol check
```

## 默认管理地址

- Dashboard：`http://127.0.0.1:6190`
- AstrBot WebUI：`http://127.0.0.1:6185`

二者默认只绑定服务器回环地址，应通过 SSH 隧道访问，不需要开放云安全组端口。

## 隐私提醒

请勿提交以下内容：

- `.env`、模型 Key、飞书 Secret、设备 Token 和配对码
- 微信 Cookie、Session、二维码、联系人和消息正文
- `data/`、AstrBot 数据库、APK、设备诊断和未经脱敏的日志
- 服务器地址、SSH 密码和私钥

提交前运行：

```bash
./scripts/check-secrets.sh
```

仓库目前尚未选择开源许可证。在许可证确定前，请勿假定已经获得再分发或商业使用授权。
