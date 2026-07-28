#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_PATH="$PROJECT_DIR/.env"

prompt_default() {
  local prompt="$1"
  local default="$2"
  local value
  read -r -p "$prompt [$default]: " value
  printf '%s' "${value:-$default}"
}

prompt_secret() {
  local prompt="$1"
  local value
  read -r -s -p "$prompt: " value
  printf '\n' >&2
  printf '%s' "$value"
}

if [[ -f "$ENV_PATH" ]]; then
  read -r -p ".env 已存在，是否重新配置？现有文件会备份 [y/N]: " overwrite
  if [[ ! "$overwrite" =~ ^[Yy]$ ]]; then
    printf '已取消，现有配置未改变。\n'
    exit 0
  fi
  backup="${ENV_PATH}.backup.$(date +%Y%m%d%H%M%S)"
  cp -p "$ENV_PATH" "$backup"
  printf '旧配置已备份到 %s\n' "$backup"
fi

printf '\n选择大模型供应商：\n'
printf '  1) DeepSeek（推荐，已测试）\n'
printf '  2) OpenAI-compatible 自定义接口\n'
printf '  3) 暂不配置，稍后使用 AstrBot WebUI\n'
read -r -p "请选择 [1-3]: " provider_choice

llm_enabled=true
llm_provider=deepseek
llm_api_base=https://api.deepseek.com/v1
llm_model=deepseek-v4-flash
llm_context=131072
llm_api_key=

case "$provider_choice" in
  1|"")
    llm_api_base="$(prompt_default "API 地址" "$llm_api_base")"
    llm_model="$(prompt_default "模型名称" "$llm_model")"
    llm_context="$(prompt_default "上下文 Token 数" "$llm_context")"
    llm_api_key="$(prompt_secret "API Key（输入不会回显）")"
    ;;
  2)
    llm_provider=openai
    llm_api_base="$(prompt_default "OpenAI-compatible API 地址" "https://api.openai.com/v1")"
    llm_model="$(prompt_default "模型名称" "gpt-4.1-mini")"
    llm_context="$(prompt_default "上下文 Token 数" "128000")"
    llm_api_key="$(prompt_secret "API Key（输入不会回显）")"
    ;;
  3)
    llm_enabled=false
    llm_provider=disabled
    llm_api_base=
    llm_model=
    llm_context=131072
    ;;
  *)
    printf '无效选项。\n' >&2
    exit 2
    ;;
esac

if [[ "$llm_enabled" == true && -z "$llm_api_key" ]]; then
  printf 'API Key 不能为空。\n' >&2
  exit 2
fi

timezone="$(prompt_default "时区" "Asia/Shanghai")"
quiet_hours="$(prompt_default "休眠时段" "00:00-07:00")"
dashboard_port="$(prompt_default "Dashboard 本机端口" "6190")"
astrbot_port="$(prompt_default "AstrBot WebUI 本机端口" "6185")"

read -r -p "是否配置飞书私聊通知？[y/N]: " configure_feishu
feishu_app_id=
feishu_app_secret=
if [[ "$configure_feishu" =~ ^[Yy]$ ]]; then
  feishu_app_id="$(prompt_secret "飞书 App ID（输入不会回显）")"
  feishu_app_secret="$(prompt_secret "飞书 App Secret（输入不会回显）")"
fi

umask 077
temporary_env="${ENV_PATH}.tmp"
cat >"$temporary_env" <<EOF
TZ=$timezone
BOT_TIMEZONE=$timezone
BOT_QUIET_HOURS=$quiet_hours
DASHBOARD_HOST_PORT=$dashboard_port
ASTRBOT_WEBUI_HOST_PORT=$astrbot_port
LLM_ENABLED=$llm_enabled
LLM_PROVIDER=$llm_provider
LLM_API_BASE=$llm_api_base
LLM_MODEL=$llm_model
LLM_API_KEY=$llm_api_key
LLM_MAX_CONTEXT_TOKENS=$llm_context
FEISHU_APP_ID=$feishu_app_id
FEISHU_APP_SECRET=$feishu_app_secret
ONEBOT_WS_URL=ws://127.0.0.1:6199/ws
BOT_MAX_MESSAGE_CHARS=2000
BOT_MAX_MESSAGE_AGE_MS=600000
BOT_DUPLICATE_TTL_MS=300000
BOT_USER_RATE_LIMIT=3
BOT_USER_RATE_WINDOW_MS=30000
BOT_GLOBAL_RATE_LIMIT=30
BOT_GLOBAL_RATE_WINDOW_MS=60000
BOT_MAX_INFLIGHT=3
BOT_MAX_INFLIGHT_PER_USER=1
BOT_GROUP_REPLY_COOLDOWN_MS=5000
BOT_MAX_GROUP_REPLY_CHARS=1000
BOT_GROUP_JITTER_MIN_MS=1000
BOT_GROUP_JITTER_MAX_MS=3000
BOT_GROUP_MEMBER_RATE_LIMIT=3
BOT_GROUP_MEMBER_RATE_WINDOW_MS=60000
BOT_GROUP_RATE_LIMIT=6
BOT_GROUP_RATE_WINDOW_MS=60000
BOT_GROUP_FUSE_FAILURES=3
BOT_GROUP_FUSE_FAILURE_WINDOW_MS=300000
BOT_GROUP_FUSE_ANOMALIES=12
BOT_GROUP_FUSE_ANOMALY_WINDOW_MS=60000
BOT_GROUP_FUSE_DURATION_MS=900000
WECHAT_QR_TTL_MS=120000
WECHAT_WATCHDOG_INTERVAL_MS=15000
WECHAT_STARTUP_GRACE_MS=90000
WECHAT_SYNC_DEGRADED_MS=90000
WECHAT_SYNC_RECOVER_MS=180000
WECHAT_RECOVERY_TIMEOUT_MS=75000
WECHAT_RECOVERY_BASE_DELAY_MS=15000
WECHAT_MAX_RECOVERY_FAILURES=3
WECHAT_FATAL_AFTER_MS=600000
EOF
mv "$temporary_env" "$ENV_PATH"
chmod 600 "$ENV_PATH"
mkdir -p "$PROJECT_DIR/data"
chmod 700 "$PROJECT_DIR/data"

printf '\n配置已安全写入 .env（权限 600）。\n'
"$PROJECT_DIR/scripts/doctor.sh"
"$PROJECT_DIR/scripts/fetch-astrbot.sh"

read -r -p "是否现在构建并启动机器人？[Y/n]: " start_now
if [[ ! "$start_now" =~ ^[Nn]$ ]]; then
  "$PROJECT_DIR/wxbot-bridge" start
fi
