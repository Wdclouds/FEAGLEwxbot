#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
failures=0

ok() { printf '  [OK] %s\n' "$1"; }
warn() { printf '  [WARN] %s\n' "$1"; }
fail() { printf '  [FAIL] %s\n' "$1"; failures=$((failures + 1)); }

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
