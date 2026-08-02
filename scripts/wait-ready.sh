#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$PROJECT_DIR/.env" ]]; then
  dashboard_port="$(sed -n 's/^DASHBOARD_HOST_PORT=//p' "$PROJECT_DIR/.env" | tail -1)"
  astrbot_port="$(sed -n 's/^ASTRBOT_WEBUI_HOST_PORT=//p' "$PROJECT_DIR/.env" | tail -1)"
fi
dashboard_port="${dashboard_port:-6190}"
astrbot_port="${astrbot_port:-6185}"
deadline=$((SECONDS + 180))

print_access_instructions() {
  cat <<EOF

Dashboard 和 AstrBot WebUI 只监听服务器本机，不能直接在你自己的电脑打开 127.0.0.1。
请在“你自己的电脑”新开 PowerShell 或终端，运行下面的命令（不要在服务器终端里运行）：

  ssh -N -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \\
    -L ${dashboard_port}:127.0.0.1:${dashboard_port} \\
    -L ${astrbot_port}:127.0.0.1:${astrbot_port} \\
    root@<服务器公网IP>

保持该窗口开启，然后用同一台电脑的浏览器访问：
  Dashboard:      http://127.0.0.1:${dashboard_port}
  AstrBot WebUI:  http://127.0.0.1:${astrbot_port}
EOF
}

printf '等待 Dashboard 启动'
while (( SECONDS < deadline )); do
  if curl -fsS "http://127.0.0.1:${dashboard_port}/api/health/live" >/dev/null 2>&1; then
    printf '\n机器人服务已启动。\n'
    if curl -fsS "http://127.0.0.1:${dashboard_port}/api/health/ready" >/dev/null 2>&1; then
      printf '微信、AstrBot 和 OneBot 已全部就绪。\n'
    else
      printf '当前仍需扫码或等待 AstrBot 初始化，请在 Dashboard 查看进度。\n'
    fi
    print_access_instructions
    exit 0
  fi
  printf '.'
  sleep 3
done

printf '\nDashboard 尚未在 180 秒内启动，请运行：\n' >&2
printf '  %s/feagle bridge status\n' "$PROJECT_DIR" >&2
printf '  %s/feagle bridge logs\n' "$PROJECT_DIR" >&2
exit 1
