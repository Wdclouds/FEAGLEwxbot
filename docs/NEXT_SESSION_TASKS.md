# FEAGLE WxBot 下次会话续接工作与剩余任务清单 (NEXT_SESSION_TASKS.md)

> **创建时间**: 2026-09-05  
> **基线状态**: 全系统标准化封装已落地，代码已推送到 GitHub 主分支 (`main`)，贡献热力图 100% 完整保留。  
> **使用说明**: 下次会话唤醒时，直接把本文件路径提供给 AI 助手，即可秒级恢复上下文无缝继续推进！

---

## 📌 当前已完成的里程碑 (Completed Baseline)

1. **热力图与历史提交安全完整**：
   - GitHub 仓库 `https://github.com/Wdclouds/FEAGLEwxbot` 主分支已同步至最新提交（`55ebcba`），历史未提交改动归档至 `archive-legacy-v1` 分支，提交记录连续完整。
2. **全局核心解耦与标准套件目录落地**：
   - 建立了 `deploy/hermes/`、`deploy/mnemosyne/`、`apps/plugins/` 规范插槽。
   - 彻底清理根目录下杂乱的遗留测试脚本与 Markdown 排错草稿。
3. **全局统一配置与多 Profile 编排**：
   - `.env.example`：单一真实源，支持 `BOT_BACKEND=hermes` 或 `BOT_BACKEND=astrbot` 自由切换。
   - `docker-compose.yml`：基于 Compose Profile 机制解耦双大脑，严防 1.6G 内存轻量服务器 OOM。
4. **Linux 极速自适应安装引导器**：
   - `scripts/auto-mirror.sh`：1 秒极速探测并发比对国内外延迟，动态启用 `ghfast.top` 及阿里云镜像加速。
   - `scripts/backup-pack.sh`：一键自动打包脱敏备份。
   - `install.sh`：纯命令行交互式新手安装向导。
5. **Bridge 自适应控制台与扫码免密配对**：
   - Bridge 后端实现 `/api/device/pair-code`（生成包含时间戳签名的配对二维码 Payload）与 `/api/device/check-update`（OTA 检查）。
   - 前端增加【📱 连接设备】扫码配对弹窗，并根据 `botBackend` 动态切换 Tab（AstrBot 模式自动展示【插件与配置】并内嵌 6185 后台）。
   - Bridge 核心自动化测试集全部通过（单测 pass 61/61 + contacts-sync pass 18/18）。

---

## 🚀 剩余待办任务与下次会话推进路线图 (Backlog & Roadmap)

### 任务一：Android Agent 平板端“扫码免密连接”原生界面落地
- **目标**：在 `apps/android-agent/` 中引入轻量级二维码扫描器（如基于 ZXing 或 CameraX 的极简扫码页）。
- **具体细节**：
  1. 在 Android Agent 主界面增加显眼的 **【扫码连接服务器】** 按钮。
  2. 扫描 Bridge 控制台生成的二维码，解析 JSON Payload：
     ```json
     { "endpoint": "ws://...", "token": "...", "timestamp": 1757044800 }
     ```
  3. 自动存入 `SharedPreferences`，无需手敲任何长字符串，即刻发起认证连接。

### 任务二：利用 Root 权限实现应用内 OTA 静默自更新
- **目标**：彻底免去插 USB 数据线敲 `adb install -r` 的繁琐过程。
- **具体细节**：
  1. 平板建立 WS 连接握手时，Bridge 比对版本（例如当前 `0.6.0` vs 最新 `0.7.0`）。
  2. 若有更新，Bridge 下发更新提示或自动触发下载。
  3. 平板端下载最新 APK 到 `/data/local/tmp/update.apk`。
  4. 利用已验证的 Root 权限（三星平板已具备 Magisk 30.7 su），在后台执行：
     ```bash
     su -c 'pm install -r /data/local/tmp/update.apk && am start -n io.github.wdclouds.feaglewxbot.agent/.MainActivity'
     ```
  5. 实现无人值守或远程一键静默热升级。

### 任务三：物理机环境彻底剥离 Tailscale 验证
- **背景**：当前平板通过 Tailscale 组网连接 `100.70.137.52:6191`，但在休眠时容易产生 TCP 假死。
- **具体细节**：
  1. 确认服务器云安全组开放 6191 端口（或配置 Nginx/Caddy 的反向代理绑定域名，如 `wss://bot.feagle.top/android`）。
  2. 平板端直接填入服务器公网 IP 或域名，验证直连稳定度。
  3. 验证通过后，平板端可完全卸载 Tailscale，彻底降维依赖。

### 任务四：云端生产环境（39.97.255.91）无缝拉取与验收
- **目标**：在云端服务器拉取最新 `main` 分支代码，验证全新 `install.sh` 与多 Profile 编排。
- **具体细节**：
  1. 在云端服务器 `git pull origin main`。
  2. 运行 `bash install.sh`，验证网络测速与交互引导流程。
  3. 确认 systemd 守护进程与 Docker Compose 各服务无缝对接，不影响正在运行的微信长连接会话。

---

## 🔍 下次会话唤醒极速检查命令
```bash
# 1. 检查云端 Bridge 状态
ssh root@39.97.255.91 "curl -s http://127.0.0.1:6190/api/status"

# 2. 检查本地三星平板 ADB 状态
.\feagle.cmd android doctor

# 3. 查看本地 Git 仓库状态
git status
```
