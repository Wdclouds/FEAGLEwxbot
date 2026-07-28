#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$PROJECT_DIR/.env" ]]; then
  dashboard_port="$(sed -n 's/^DASHBOARD_HOST_PORT=//p' "$PROJECT_DIR/.env" | tail -1)"
fi
dashboard_port="${dashboard_port:-6190}"
deadline=$((SECONDS + 180))

printf '等待 Dashboard 启动'
while (( SECONDS < deadline )); do
  if curl -fsS "http://127.0.0.1:${dashboard_port}/api/health/live" >/dev/null 2>&1; then
    printf '\n机器人服务已启动。\n'
    printf 'Dashboard: http://127.0.0.1:%s\n' "$dashboard_port"
    if curl -fsS "http://127.0.0.1:${dashboard_port}/api/health/ready" >/dev/null 2>&1; then
      printf '微信、AstrBot 和 OneBot 已全部就绪。\n'
    else
      printf '当前仍需扫码或等待 AstrBot 初始化，请在 Dashboard 查看进度。\n'
    fi
    exit 0
  fi
  printf '.'
  sleep 3
done

printf '\nDashboard 尚未在 180 秒内启动，请运行：\n' >&2
printf '  %s/wxbot-bridge status\n' "$PROJECT_DIR" >&2
printf '  %s/wxbot-bridge logs\n' "$PROJECT_DIR" >&2
exit 1
