# FEAGLEwxbot Bridge

一个可自托管的微信 AI 机器人桥接项目。它把微信消息转换为 OneBot v11
事件交给 AstrBot，再把大模型生成的回复送回微信。

```text
微信接入层 → FEAGLE Bridge → OneBot v11 → AstrBot → 大模型
```

项目目前提供两种并列的微信接入方式：

- `Wechat4u`：部署简单，支持扫码登录、私聊文本和受控群聊。
- `Android Agent`：固定适配微信 `8.0.70`，通过 Android 设备、Hook 适配器和
  独立 Agent 接入；当前已验证私聊文本收发。

同一账号一次只能选择一种接入方式，避免消息重复进入 AstrBot。

> [!WARNING]
> 本项目使用非官方微信接入方式，可能受到登录策略、客户端版本和账号风控影响。
> 请使用能够承担掉线或限制风险的账号。项目不保证接口长期可用，也不隶属于微信、
> 腾讯、AstrBot、DeepSeek 或飞书。

## 文档导航

| 文档 | 适合谁 | 内容 |
| --- | --- | --- |
| [项目介绍](./docs/project-overview.md) | 想先理解项目的人 | 架构、组件、数据流、功能范围、安全设计和已知限制 |
| [操作步骤说明书](./docs/user-guide.md) | 准备部署或日常管理的人 | 从零部署、首次登录、模型、Dashboard、飞书、Android 和备份 |
| [报错与日志积累](./docs/troubleshooting.md) | 遇到异常的人 | 排查顺序、日志采集、隐私脱敏和典型故障处理 |

专项资料：

- [Android Agent 构建与接入](./android/README.md)
- [安全策略](./SECURITY.md)

## 快速开始

服务器需要 Linux x86_64、Docker Engine、Docker Compose v2、`curl` 和 `tar`。
推荐至少 2 GB 内存和 10 GB 可用磁盘。

中国大陆服务器默认使用阿里云 Alpine/PyPI 镜像和 npmmirror；AstrBot 源码优先通过
国内加速地址下载，失败后回退 GitHub 官方地址，且无论来源都必须通过固定 SHA-256
校验。Docker Hub 加速地址由阿里云按账号生成，项目只做自动检测和提示，不会写入
未经确认的公共代理。

```bash
git clone https://ghfast.top/https://github.com/Wdclouds/FEAGLEwxbot-bridge.git
cd FEAGLEwxbot-bridge
chmod +x wxbot-bridge scripts/*.sh
./wxbot-bridge setup
```

上面的仓库地址是中国大陆默认加速入口；海外网络或加速入口临时不可用时，将
`https://ghfast.top/` 前缀删除即可使用 GitHub 官方地址。

配置向导会检查环境，让用户选择 Wechat4u 或 Android Agent，询问模型与休眠时段、
生成本机 `.env`，然后下载固定版本的 AstrBot 并启动机器人。Android 模式会自动
生成不回显的配对密钥，并引导继续使用 Android Kit。

完整步骤、首次扫码和 SSH 隧道说明见
[操作步骤说明书](./docs/user-guide.md)。

## 常用命令

```bash
./wxbot-bridge setup
./wxbot-bridge doctor
./wxbot-bridge start
./wxbot-bridge stop
./wxbot-bridge restart
./wxbot-bridge status
./wxbot-bridge logs
```

不带参数运行 `./wxbot-bridge` 会打开中文交互菜单。

## 默认管理地址

Dashboard 和 AstrBot WebUI 默认只绑定服务器回环地址，不直接暴露到公网：

- FEAGLE Dashboard：`http://127.0.0.1:6190`
- AstrBot WebUI：`http://127.0.0.1:6185`

应通过 SSH 隧道访问，通常不需要为这两个端口开放云安全组。具体命令见
[操作步骤说明书：访问管理页面](./docs/user-guide.md#6-访问管理页面)。

## 隐私提醒

请勿把以下内容提交到 GitHub、公开 Issue 或聊天记录：

- `.env`、API Key、飞书 Secret 和设备 Token
- 微信 Cookie、Session、二维码和联系人数据
- `data/`、AstrBot 会话数据库和消息 ID 映射
- 服务器地址、SSH 密码、私钥和未经脱敏的运行日志

仓库已经通过 `.gitignore` 排除主要私密路径。提交前仍建议执行：

```bash
./scripts/check-secrets.sh
```

## 当前范围

当前重点是文本机器人链路、单机 Docker 部署、本地管理面板、会话自愈、消息限流、
持久化去重和可选飞书通知。图片、文件、引用消息、更完整的群成员资料和一键升级
流程仍在后续计划中。

仓库目前尚未选择开源许可证。在许可证确定前，代码可供查看和测试，但请勿假定
已经获得再分发或商业使用授权。
