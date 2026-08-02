# Android Hook 从零部署操作手册

[返回项目首页](../../README.md) · [Android 参考文档](./index.md) ·
[故障排查](../troubleshooting.md)

这篇文章是一条可以从头顺序执行的主线。第一次部署时不要在四篇参考资料之间跳转；
完成本页后，再按需阅读各专题文档。

教程用三个标签标明操作位置：

- **【服务器】**：Linux ECS 的 SSH 终端。
- **【Windows】**：连接 Android 设备的 Windows PowerShell。
- **【平板】**：已 Root 的 Android 设备界面。

## 0. 开始前先确认

当前完整验证过的组合是：

```text
Samsung Galaxy Tab A8 SM-X200
Android 14
Magisk 30.7 + Zygisk
LSPosed/Vector
微信 8.0.70 arm64-v8a
Windows 10/11
FEAGLEwxbot Android Agent 0.6.0
```

开始前应满足：

- ECS 能正常使用 Docker 和 Docker Compose v2。
- Windows 能通过 SSH 登录 ECS。
- 平板已经由设备所有者完成 Root，Magisk 中已经开启 Zygisk。
- 平板已经开启开发者选项和 USB 调试。
- USB 数据线支持数据传输。
- 微信账号能够承担非官方接入方式可能带来的掉线或限制风险。

本项目不会自动 Root、解锁 Bootloader、下载微信 APK，也不会替用户点击 Android
系统授权弹窗。

> [!IMPORTANT]
> Wechat4u 与 Android Agent 一次只能启用一个。切换接入方式不会自动合并两种通道产生的
> 临时联系人 ID，首次切换后可能在 AstrBot 中形成一段新会话。

## 1. 先选择平板如何连接服务器

Android Agent 必须主动连接 ECS。Dashboard 的 SSH 隧道只供 Windows 浏览器使用，
不能让平板借此连接 Bridge。

### 方案 A：Tailscale 私网（新手推荐）

适合没有域名和 HTTPS 反向代理的用户。ECS 与平板加入同一个 Tailnet 后，Android
Endpoint 使用：

```text
ws://100.x.y.z:6191/android
```

这里的 `100.x.y.z` 是 ECS 的 Tailscale IPv4，不是 ECS 公网 IP。链路由 Tailscale
加密，因此不需要在阿里云安全组开放 `6191`。

**【服务器】** 按 Tailscale 官方 Linux 文档安装，然后连接账号：

```bash
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up
tailscale ip -4
tailscale status
```

记录 `tailscale ip -4` 输出的 `100.x.y.z` 地址。

**【平板】** 安装 Tailscale，登录同一个 Tailnet，并确认能在设备列表中看到 ECS。
官方安装入口：<https://tailscale.com/docs/install>。

> [!WARNING]
> Android 同一时间只能运行一个 VPN。需要另一个 VPN 才能完成 Tailscale 下载或登录时，
> 可以先用原 VPN 完成安装与登录，再断开原 VPN并启用 Tailscale。需要长期保留其他 VPN
> 的用户应选择下面的标准 WSS 方案。

### 方案 B：标准 WSS（已有域名的用户）

适合已经拥有域名、有效 HTTPS 证书和 Nginx/Caddy 反向代理的用户。Endpoint 使用：

```text
wss://bot.example.com/android
```

反向代理把精确路径 `/android` 转发到宿主机 `127.0.0.1:6191/android`。只需要对外开放
HTTPS 的 `443`，不要把 `6191` 直接暴露到公网。配置示例见
[Android Agent 远程传输说明](../../apps/android-agent/README.md#远程传输)。

如果既没有可用的 Tailscale，也没有配置完成的 WSS 域名，请先解决网络方案，不要继续
生成配对码。普通公网 `ws://公网IP:6191/android` 会被 Agent 主动拒绝。

## 2. 在服务器部署并选择 Android 模式

**【服务器】** 克隆项目并进入仓库：

```bash
git clone https://ghfast.top/https://github.com/Wdclouds/FEAGLEwxbot.git
cd FEAGLEwxbot
chmod +x feagle wxbot-bridge scripts/*.sh
./feagle bridge setup
```

向导询问“微信接入方式”时选择：

```text
2) Android Hook Agent
```

网络相关输入：

| 使用方案 | Android WebSocket 绑定地址 | 端口 |
| --- | --- | --- |
| Tailscale | ECS 的 `100.x.y.z` | `6191` |
| 标准 WSS | `127.0.0.1` | `6191` |

如果 Tailscale 已经运行，向导通常会自动检测 ECS 的 Tailscale IPv4。确认它确实是
`tailscale ip -4` 的输出后再按 Enter。

向导会自动生成 Android 配对密钥，但不会在终端显示。它不是一次性配对码，不需要手动
复制。一次性配对码会在后面的 Windows 命令中生成。

如果向导没有立刻启动服务，执行：

```bash
./feagle bridge doctor
./feagle bridge start
```

最后检查：

```bash
./feagle bridge status
```

此时 Bridge 已经等待 Android 设备，但设备尚未配对是正常现象。

### 已有 Wechat4u 部署如何切换

最稳妥的方式是重新运行 `./feagle bridge setup`，在向导中选择 Android，并保留需要的
模型与飞书配置。向导会先备份现有 `.env`。也可以在 Dashboard 的“设置 / Settings”中
切换，但只有 `.env` 已经包含 Android 配对密钥时，Dashboard 才允许切换。

## 3. 在 Windows 准备同一份仓库

**【Windows】** 打开普通 PowerShell。服务器与 Windows 各自需要一份仓库；不要在 SSH
终端里执行下面的 Windows 命令。

```powershell
Set-Location $HOME
git clone https://ghfast.top/https://github.com/Wdclouds/FEAGLEwxbot.git
Set-Location .\FEAGLEwxbot
```

如果已经克隆过：

```powershell
Set-Location $HOME\FEAGLEwxbot
git pull --ff-only
```

准备仓库本地 JDK、ADB 和 Android SDK：

```powershell
.\feagle.cmd android bootstrap-tools -AcceptAndroidSdkLicense
```

第一次执行需要下载工具。成功标志是 JDK、Android CLI、Platform Tools、Build Tools
和 Android 34 Platform 均显示“通过”。下载中断时直接重新运行同一条命令。

## 4. 用 USB 检查平板

**【平板】** 解锁屏幕，连接 USB 数据线。首次连接时接受“允许 USB 调试”弹窗；这是
Android 系统授权，不是 FEAGLE 的配对。

**【Windows】** 运行：

```powershell
.\feagle.cmd android doctor
```

继续下一步前至少应看到：

```text
[通过] 设备已连接并授权
[通过] 设备属于当前已验证基线
[通过] Root：su 可用
```

常见停点：

| 输出 | 怎么处理 |
| --- | --- |
| `unauthorized` | 解锁平板并接受当前电脑的 USB 调试指纹，再运行 `doctor` |
| 没有设备 | 换数据线或 USB 口，确认连接模式不是“仅充电” |
| `su` 不可用 | 在平板查看 Magisk 是否弹出 Shell Root 授权 |
| 未经验证的型号 | 可以继续研究，但本教程不再保证后续结果 |

微信尚未安装时，`doctor` 在微信项目上提示注意是正常的。

## 5. 验证并登录微信 8.0.70

如果平板已经安装微信 `8.0.70`，直接运行：

```powershell
.\feagle.cmd android verify-wechat
```

只有版本、文件哈希与签名证书全部通过，才能继续。

如果尚未安装，先从
[候选页面](https://www.apkmirror.com/apk/wechat/wechat/wechat-8-0-70-release/wechat-8-0-70-android-apk-download/)
手动下载 `8.0.70`、`arm64-v8a` APK 到 Windows。该页面是第三方归档站，不是微信官方
渠道；工具仍会独立校验实际文件。

假设文件位于下载目录：

```powershell
$WechatApk = "$HOME\Downloads\wechat-8.0.70.apk"
.\feagle.cmd android verify-apk -ApkPath $WechatApk
.\feagle.cmd android install-wechat -ApkPath $WechatApk -ConfirmInstall
.\feagle.cmd android verify-wechat
```

文件名与实际下载不同时，只修改 `$WechatApk`。如果平板已有其他微信版本，安装助手会
停止，不会自动卸载或清除微信数据。

**【平板】** 校验通过后再打开微信并登录。确认能够进入聊天列表、正常收发一条人工
消息，然后关闭应用商店里的微信自动更新。这里没有“我已登录”按钮，登录结果由用户
在微信界面自行确认。

## 6. 构建并安装 FEAGLE Agent

**【Windows】** 运行：

```powershell
.\feagle.cmd android build-agent
.\feagle.cmd android install-agent -ConfirmAgentInstall
```

`build-agent` 成功后会打印 APK 路径和 SHA-256；`install-agent` 只接受本机刚刚构建并
记录的 APK。完成后，平板应用列表中应出现 `FEAGLEwxbot Agent`。

## 7. 在平板启用模块

**【平板】** 按以下顺序操作：

1. 打开 LSPosed/Vector 管理器。
2. 进入“模块 / Modules”。
3. 打开 `FEAGLEwxbot Agent` 模块开关。
4. 进入该模块的作用域，只勾选微信 `com.tencent.mm`。
5. 不要勾选系统界面、Tailscale、FEAGLE Agent 自身或其他应用。
6. 强制停止微信，再重新打开微信；如果管理器明确要求重启设备，则重启平板。
7. 打开 `FEAGLEwxbot Agent`。

**【Windows】** 运行：

```powershell
.\feagle.cmd android agent-status
```

此时“消息通道 / Message channel”已经连接是理想状态；“云端连接”未连接、“设备配对”
未配对仍然正常，因为还没有执行下一步。

## 8. 生成一次性配对码并连接

准备两个不同的地址：

| 参数 | 用途 | 示例 |
| --- | --- | --- |
| `ServerHost` | Windows 通过 SSH 登录 ECS | `YOUR_ECS_PUBLIC_IP` |
| `BridgeEndpoint` | 平板连接 Android Bridge | `ws://100.x.y.z:6191/android` |

不要把 ECS 公网 IP 误填进 Tailscale Endpoint，也不要把 Tailscale IP 当成 Windows 必须
使用的 SSH 地址。

### Tailscale 示例

**【Windows】** 在仓库目录运行：

```powershell
.\feagle.cmd android pair-agent `
  -ServerHost YOUR_ECS_PUBLIC_IP `
  -SshUser root `
  -BridgeEndpoint ws://100.x.y.z:6191/android
```

把 `YOUR_ECS_PUBLIC_IP` 与 `100.x.y.z` 换成自己的地址。第一次 SSH 连接可能要求确认
服务器指纹；应先核对指纹，再输入 `yes` 或使用已经配置的 SSH 密钥。

### 标准 WSS 示例

```powershell
.\feagle.cmd android pair-agent `
  -ServerHost YOUR_ECS_PUBLIC_IP `
  -SshUser root `
  -BridgeEndpoint wss://bot.example.com/android
```

命令会完成三件事：

1. 通过 SSH 在 `Feagle-wxbot` 容器中生成 5 分钟有效、只能使用一次的 8 位短码。
2. 通过 ADB 打开平板上的 FEAGLE Agent。
3. 自动预填 Endpoint 和短码。

**【平板】** 核对 Endpoint 后点击“配对并启动 / Pair & Start”。

成功后短码输入框自动清空，按钮变成“保存并重连 / Save & Reconnect”。这是正常现象，
不需要保存短码或长期 Token。

## 9. 对照四项状态

Agent 页面最终应显示：

| 页面项目 | 首次验收期望 | 含义 |
| --- | --- | --- |
| 云端连接 / Cloud | `已连接 / connected` | Agent 已连接 ECS Bridge |
| 设备配对 / Pairing | `已配对 / paired` | 一次性短码已换成设备 Token |
| 消息通道 / Message channel | `已连接 / connected` | 微信 Hook 已连接 Agent |
| 通知兜底 / Notifications | `未开启 / disabled` 也正常 | 主 Hook 不依赖通知读取 |

再在 Windows 运行一次：

```powershell
.\feagle.cmd android agent-status
```

在服务器查看：

```bash
./feagle bridge status
./feagle bridge logs
```

Dashboard 应显示当前通道为 Android，AstrBot 为 Ready，OneBot 为 Connected。Dashboard
仍通过服务器启动时打印的 SSH 隧道访问，不需要为 `6190` 开放安全组。

## 10. 做第一次私聊验收

先不要开启群聊回复。从另一个微信账号向机器人账号发送一条容易识别的文本，例如：

```text
FEAGLE 私聊链路测试 001
```

依次确认：

```text
平板微信收到消息
→ Agent 消息通道保持已连接
→ Dashboard 出现 Android 私聊事件
→ AstrBot 收到 OneBot 私聊消息
→ 回复返回原微信私聊
```

同一条测试消息只应回复一次。若没有模型回复，先确认 AstrBot WebUI 已启用默认对话模型；
这不代表 Android Hook 失败。

## 11. 再开启受控群聊

私聊通过后，在 Dashboard 设置页把群聊模式从 `OFF` 调成 `OBSERVE`，先在目标群发送一条
消息并确认群 ID。将准确群 ID 加入白名单后，再切换到 `MENTION_ONLY`。

首次测试必须明确 `@` 机器人：

```text
@机器人 FEAGLE 群聊链路测试 001
```

Android Hook 无法确认明确 `@` 标记时会保持静默。不要在未核对群 ID、速率限制和休眠
时段前开放群回复。

## 12. 常见状态与处理

| 现象 | 原因与处理 |
| --- | --- |
| `invalid_or_expired_code` | 短码已过期或已使用；重新运行 `pair-agent`，不要重复点击旧短码 |
| 点击配对后短码消失 | 通常表示已成功保存设备 Token；看“设备配对”是否为已配对 |
| `已断开 / disconnected (1008)` | 常见于服务器仍限制旧 `ANDROID_DEVICE_ID`；将 `.env` 中该值清空或改为 Agent 页面当前设备 ID，然后重新创建 bot 容器 |
| 云端已连接，但消息通道未连接 | 检查微信必须是 8.0.70、模块已启用、作用域只选微信，并强制停止后重开微信 |
| 消息通道已连接，但云端未连接 | 检查 Tailscale/WSS、Endpoint、Bridge 绑定地址和容器状态 |
| Tailscale 一开启，原 VPN 断开 | Android 只允许一个 VPN；关闭原 VPN，或改用标准 WSS |
| 私聊进入 Dashboard，但没有回复 | 检查 AstrBot 默认模型、OneBot 状态、休眠时段和处理队列 |
| 收到多次相同回复 | 停止另一种接入通道，确认只有 Android 或 Wechat4u 其中之一处于启用状态 |

修改服务器 `.env` 后，只重建 bot 容器：

```bash
docker compose up -d --force-recreate bot
```

不要删除 `data/`，否则会丢失 AstrBot 数据、设备配对和消息去重收据。更多诊断见
[故障排查](../troubleshooting.md)。

## 13. 部署完成检查表

- [ ] ECS 的 Bridge 使用 Android transport。
- [ ] 平板与 ECS 之间存在 Tailscale 私网或标准 WSS。
- [ ] `doctor` 通过设备、Root 和微信版本检查。
- [ ] `verify-wechat` 通过文件和签名检查。
- [ ] Agent 0.6.0 已构建并安装。
- [ ] LSPosed/Vector 作用域只勾选微信。
- [ ] Agent 显示云端已连接、设备已配对、消息通道已连接。
- [ ] Dashboard 显示 Android、AstrBot Ready、OneBot Connected。
- [ ] 私聊只回复一次。
- [ ] 群聊保持 OFF/OBSERVE，或只对白名单群的明确 @ 回复。

