#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_PATH="$PROJECT_DIR/.env"
temporary_env=
feishu_temp_dir=

cleanup_setup() {
  if [[ -n "$feishu_temp_dir" ]]; then
    case "$feishu_temp_dir" in
      /tmp/*) rm -rf -- "$feishu_temp_dir" ;;
      *) printf '拒绝清理异常飞书临时目录：%s\n' "$feishu_temp_dir" >&2 ;;
    esac
  fi
  if [[ -n "$temporary_env" && "$temporary_env" == "${ENV_PATH}.tmp" ]]; then
    rm -f -- "$temporary_env"
  fi
}
trap cleanup_setup EXIT

env_value() {
  local key="$1"
  [[ -f "$ENV_PATH" ]] || return 0
  sed -n "s/^${key}=//p" "$ENV_PATH" | tail -n 1
}

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

prompt_required() {
  local prompt="$1"
  local value
  while true; do
    read -r -p "$prompt: " value
    if [[ -n "$value" ]]; then
      printf '%s' "$value"
      return
    fi
    printf '该项不能为空，请重新输入。\n' >&2
  done
}

prompt_required_secret() {
  local prompt="$1"
  local value
  while true; do
    value="$(prompt_secret "$prompt（输入不会回显，粘贴后按 Enter）")"
    if [[ -n "$value" ]]; then
      printf '%s' "$value"
      return
    fi
    printf '该项不能为空，请重新输入。\n' >&2
  done
}

valid_port() {
  [[ "$1" =~ ^[0-9]+$ ]] && ((10#$1 >= 1 && 10#$1 <= 65535))
}

generate_bridge_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
    return
  fi
  if [[ -r /proc/sys/kernel/random/uuid ]]; then
    local first second
    first="$(tr -d '-' </proc/sys/kernel/random/uuid)"
    second="$(tr -d '-' </proc/sys/kernel/random/uuid)"
    printf '%s%s' "$first" "$second"
    return
  fi
  printf '无法安全生成 Android Bridge 密钥，请安装 openssl 后重试。\n' >&2
  exit 1
}

verify_feishu_credentials() {
  local app_id="$1"
  local app_secret="$2"
  local response
  if [[ ! "$app_id" =~ ^cli_[A-Za-z0-9_-]+$ ]]; then
    printf '飞书 App ID 格式无效，应以 cli_ 开头。\n' >&2
    return 1
  fi
  if [[ ! "$app_secret" =~ ^[A-Za-z0-9_-]{8,}$ ]]; then
    printf '飞书 App Secret 格式或长度无效。\n' >&2
    return 1
  fi
  printf '正在连接飞书开放平台...'
  if ! response="$(
    printf '{"app_id":"%s","app_secret":"%s"}' "$app_id" "$app_secret" \
      | curl --silent --show-error --fail-with-body \
        --connect-timeout 15 --max-time 30 \
        --header 'Content-Type: application/json; charset=utf-8' \
        --data-binary @- \
        https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal/
  )"; then
    printf '失败。\n' >&2
    return 1
  fi
  if ! grep -Eq '"code"[[:space:]]*:[[:space:]]*0' <<<"$response"; then
    printf '失败：凭据无效、应用未启用或飞书暂时不可用。\n' >&2
    return 1
  fi
  printf '完成。\n'
}

configure_feishu_credentials() {
  local method_choice
  local credentials_file
  local helper
  printf '\n飞书 / Lark 配置方式：\n'
  printf '  1) 扫码自动创建应用，或在授权页选择已有应用（推荐）\n'
  printf '  2) 手动输入已有 App ID 和 App Secret\n'
  read -r -p "请选择 [1-2，默认 1]: " method_choice
  case "$method_choice" in
    1|"")
      feishu_temp_dir="$(mktemp -d)"
      credentials_file="$feishu_temp_dir/credentials.env"
      helper="${FEAGLE_FEISHU_REGISTER_HELPER:-$PROJECT_DIR/scripts/feishu-register.sh}"
      if ! bash "$helper" "$credentials_file"; then
        printf '飞书扫码配置未完成；现有 .env 未被覆盖，请重新运行向导或选择手动输入。\n' >&2
        exit 1
      fi
      feishu_app_id="$(sed -n 's/^FEISHU_APP_ID=//p' "$credentials_file" | tail -n 1)"
      feishu_app_secret="$(sed -n 's/^FEISHU_APP_SECRET=//p' "$credentials_file" | tail -n 1)"
      rm -rf -- "$feishu_temp_dir"
      feishu_temp_dir=
      ;;
    2)
      feishu_app_id="$(prompt_required '飞书 App ID（输入会正常显示）')"
      feishu_app_secret="$(prompt_required_secret '飞书 App Secret')"
      ;;
    *)
      printf '无效选项。\n' >&2
      exit 2
      ;;
  esac
  if ! verify_feishu_credentials "$feishu_app_id" "$feishu_app_secret"; then
    printf '飞书配置未保存，请检查后重新运行向导。\n' >&2
    exit 1
  fi
}

existing_feishu_app_id="$(env_value FEISHU_APP_ID)"
existing_feishu_app_secret="$(env_value FEISHU_APP_SECRET)"

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

printf '\n选择微信接入方式：\n'
printf '  1) Wechat4u 扫码登录（简单，但受 Web 微信可用性影响）\n'
printf '  2) Android Hook Agent（推荐备用机，需要单独运行 Android Kit）\n'
read -r -p "请选择 [1-2]: " transport_choice

wechat_transport=wechat4u
android_ws_bind_host=127.0.0.1
android_ws_host_port=6191
android_ws_port=6191
android_ws_path=/android
android_bridge_token=
android_pairing_db_path=/app/data/android/pairing.sqlite

case "$transport_choice" in
  1|"") ;;
  2)
    wechat_transport=android
    android_bridge_token="$(generate_bridge_secret)"
    tailscale_ip=
    if command -v tailscale >/dev/null 2>&1; then
      tailscale_ip="$(tailscale ip -4 2>/dev/null | head -n 1 || true)"
    fi
    if [[ -n "$tailscale_ip" ]]; then
      printf '检测到本机 Tailscale IPv4：%s\n' "$tailscale_ip"
      android_ws_bind_host="$tailscale_ip"
    fi
    android_ws_bind_host="$(prompt_default \
      "Android WebSocket 绑定地址（127.0.0.1 或 Tailscale IPv4）" \
      "$android_ws_bind_host")"
    android_ws_host_port="$(prompt_default \
      "Android WebSocket 端口" "$android_ws_host_port")"
    if [[ "$android_ws_bind_host" == "0.0.0.0" ]]; then
      printf '不允许把 Android WebSocket 直接绑定到全部公网接口。\n' >&2
      exit 2
    fi
    if ! valid_port "$android_ws_host_port"; then
      printf 'Android WebSocket 端口无效。\n' >&2
      exit 2
    fi
    printf '已自动生成 Android 配对密钥；不会在终端显示。\n'
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

if ! valid_port "$dashboard_port" || ! valid_port "$astrbot_port"; then
  printf 'Dashboard 或 AstrBot 端口无效。\n' >&2
  exit 2
fi
if [[ "$dashboard_port" == "$astrbot_port" ]]; then
  printf 'Dashboard 与 AstrBot 端口不能相同。\n' >&2
  exit 2
fi
if [[ "$wechat_transport" == android \
  && ( "$android_ws_host_port" == "$dashboard_port" \
    || "$android_ws_host_port" == "$astrbot_port" ) ]]; then
  printf 'Android WebSocket 端口不能与管理页面端口相同。\n' >&2
  exit 2
fi

feishu_app_id="$existing_feishu_app_id"
feishu_app_secret="$existing_feishu_app_secret"
if [[ -n "$feishu_app_id" && -n "$feishu_app_secret" ]]; then
  printf '\n✓ 飞书 / Lark 已配置。\n'
  read -r -p "是否重新配置飞书 / Lark？[y/N]: " configure_feishu
  if [[ "$configure_feishu" =~ ^[Yy]$ ]]; then
    configure_feishu_credentials
  else
    printf '保留现有飞书配置。\n'
  fi
else
  feishu_app_id=
  feishu_app_secret=
  read -r -p "是否配置飞书 / Lark 私聊通知？[y/N]: " configure_feishu
  if [[ "$configure_feishu" =~ ^[Yy]$ ]]; then
    configure_feishu_credentials
  fi
fi

umask 077
temporary_env="${ENV_PATH}.tmp"
cat >"$temporary_env" <<EOF
TZ=$timezone
BOT_TIMEZONE=$timezone
BOT_QUIET_HOURS=$quiet_hours
NODE_IMAGE=node:22-alpine
ALPINE_MIRROR=https://mirrors.aliyun.com/alpine
NPM_REGISTRY=https://registry.npmmirror.com
PYPI_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/
ASTRBOT_GITHUB_PROXY=https://ghfast.top/
ASTRBOT_SOURCE_SHA256=ad85c6405802752d4dc64c7d76c047cc815157e0fdae90079763eebd55fb9959
WECHAT_TRANSPORT=$wechat_transport
DASHBOARD_HOST_PORT=$dashboard_port
ASTRBOT_WEBUI_HOST_PORT=$astrbot_port
ANDROID_WS_BIND_HOST=$android_ws_bind_host
ANDROID_WS_HOST_PORT=$android_ws_host_port
ANDROID_WS_PORT=$android_ws_port
ANDROID_WS_PATH=$android_ws_path
ANDROID_BRIDGE_TOKEN=$android_bridge_token
ANDROID_PAIRING_DB_PATH=$android_pairing_db_path
ANDROID_DEVICE_ID=
ANDROID_HEARTBEAT_TIMEOUT_MS=75000
ANDROID_COMMAND_TIMEOUT_MS=30000
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
temporary_env=
chmod 600 "$ENV_PATH"

# If Dashboard settings already exist, keep its non-setup safety values but
# make this explicit setup choice authoritative for transport and schedule.
bridge_settings_path="$PROJECT_DIR/data/bridge-settings.json"
if [[ -f "$bridge_settings_path" ]]; then
  temporary_settings="${bridge_settings_path}.setup.tmp"
  sed -E \
    -e "s|(\"transport\"[[:space:]]*:[[:space:]]*)\"[^\"]*\"|\1\"$wechat_transport\"|" \
    -e "s|(\"quietHours\"[[:space:]]*:[[:space:]]*)\"[^\"]*\"|\1\"$quiet_hours\"|" \
    -e "s|(\"timezone\"[[:space:]]*:[[:space:]]*)\"[^\"]*\"|\1\"$timezone\"|" \
    "$bridge_settings_path" >"$temporary_settings"
  mv "$temporary_settings" "$bridge_settings_path"
  chmod 600 "$bridge_settings_path"
fi
mkdir -p "$PROJECT_DIR/data"
chmod 700 "$PROJECT_DIR/data"

printf '\n配置已安全写入 .env（权限 600）。\n'
if [[ "$wechat_transport" == android ]]; then
  printf 'Android 模式下一步：在 Windows 电脑克隆 FEAGLEwxbot-android-kit，\n'
  printf '连接已 Root 的设备，按向导构建、安装并执行一次性配对。\n'
fi
"$PROJECT_DIR/scripts/doctor.sh"
"$PROJECT_DIR/scripts/fetch-astrbot.sh"

read -r -p "是否现在构建并启动机器人？[Y/n]: " start_now
if [[ ! "$start_now" =~ ^[Nn]$ ]]; then
  "$PROJECT_DIR/wxbot-bridge" start
fi
