#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
failures=0

ok() { printf '  [OK] %s\n' "$1"; }
warn() { printf '  [WARN] %s\n' "$1"; }
fail() { printf '  [FAIL] %s\n' "$1"; failures=$((failures + 1)); }

env_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "$PROJECT_DIR/.env" | tail -n 1
}

printf 'FEAGLE WxBot Bridge 环境检查\n'

if command -v docker >/dev/null 2>&1; then
  ok "Docker: $(docker --version)"
else
  fail "未找到 Docker"
fi

if docker compose version >/dev/null 2>&1; then
  ok "Docker Compose: $(docker compose version --short)"
else
  fail "未找到 Docker Compose v2"
fi

case "$(uname -m)" in
  x86_64|amd64) ok "CPU 架构: $(uname -m)" ;;
  *) warn "当前架构 $(uname -m) 尚未经过完整测试" ;;
esac

for command_name in curl tar; do
  if command -v "$command_name" >/dev/null 2>&1; then
    ok "$command_name 已安装"
  else
    fail "缺少 $command_name"
  fi
done

if [[ -f "$PROJECT_DIR/.env" ]]; then
  mode="$(stat -c '%a' "$PROJECT_DIR/.env" 2>/dev/null || true)"
  if [[ "$mode" == "600" ]]; then
    ok ".env 权限为 600"
  else
    warn ".env 权限为 ${mode:-未知}，建议执行 chmod 600 .env"
  fi
  if grep -Eq '^LLM_ENABLED=(false|0|no|off)$' "$PROJECT_DIR/.env"; then
    warn "大模型暂未启用，可稍后在 AstrBot WebUI 配置"
  elif grep -Eq '^LLM_API_KEY=([^[:space:]]+)$' "$PROJECT_DIR/.env" \
    && ! grep -Eq '^LLM_API_KEY=(replace-me|your-key-here)$' "$PROJECT_DIR/.env"; then
    ok "大模型 API Key 已配置（值未显示）"
  else
    fail "大模型已启用但 API Key 未配置"
  fi

  transport="$(env_value WECHAT_TRANSPORT)"
  transport="${transport:-wechat4u}"
  case "$transport" in
    wechat4u)
      ok "微信接入方式: Wechat4u"
      ;;
    android)
      ok "微信接入方式: Android Agent"
      android_token="$(env_value ANDROID_BRIDGE_TOKEN)"
      android_bind="$(env_value ANDROID_WS_BIND_HOST)"
      android_port="$(env_value ANDROID_WS_HOST_PORT)"
      android_path="$(env_value ANDROID_WS_PATH)"
      if [[ ${#android_token} -ge 24 ]]; then
        ok "Android 配对密钥已配置（值未显示）"
      else
        fail "Android 配对密钥缺失或长度不足"
      fi
      if [[ -z "$android_bind" || "$android_bind" == "0.0.0.0" ]]; then
        fail "Android WebSocket 必须绑定回环或 Tailscale 私网地址"
      else
        ok "Android WebSocket 绑定地址: $android_bind"
      fi
      if [[ "$android_port" =~ ^[0-9]+$ ]] \
        && ((10#$android_port >= 1 && 10#$android_port <= 65535)); then
        ok "Android WebSocket 端口: $android_port"
      else
        fail "Android WebSocket 端口无效"
      fi
      if [[ "$android_path" == /* ]]; then
        ok "Android WebSocket 路径: $android_path"
      else
        fail "Android WebSocket 路径必须以 / 开头"
      fi
      ;;
    *)
      fail "不支持的微信接入方式: $transport"
      ;;
  esac
else
  fail "缺少 .env，请先运行 ./wxbot-bridge setup"
fi

if [[ -d "$PROJECT_DIR/data" ]]; then
  ok "运行数据目录存在"
else
  warn "运行数据目录将在首次启动时创建"
fi

if [[ "$failures" -gt 0 ]]; then
  printf '\n检查发现 %d 个阻塞问题。\n' "$failures"
  exit 1
fi

printf '\n环境检查通过。\n'
