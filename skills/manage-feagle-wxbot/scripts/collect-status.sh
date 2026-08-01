#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_PROJECT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
PROJECT_DIR="${1:-$DEFAULT_PROJECT_DIR}"

if [[ ! -d "$PROJECT_DIR" ]]; then
  printf 'Project directory does not exist.\n' >&2
  exit 2
fi
PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"
if [[ ! -f "$PROJECT_DIR/docker-compose.yml" || ! -f "$PROJECT_DIR/wxbot-bridge" ]]; then
  printf 'The selected directory is not a FEAGLEwxbot Bridge repository.\n' >&2
  exit 2
fi

env_value() {
  local key="$1"
  [[ -f "$PROJECT_DIR/.env" ]] || return 0
  sed -n "s/^${key}=//p" "$PROJECT_DIR/.env" | tail -n 1
}

http_status() {
  local url="$1"
  local code
  code="$(curl --silent --output /dev/null --write-out '%{http_code}' \
    --connect-timeout 2 --max-time 5 "$url" 2>/dev/null || true)"
  [[ "$code" =~ ^[1-5][0-9]{2}$ ]] || code=unreachable
  printf '%s' "$code"
}

printf 'FEAGLEwxbot safe status summary\n'
printf 'generated_at_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'platform=%s/%s\n' "$(uname -s)" "$(uname -m)"

commit="$(git -C "$PROJECT_DIR" rev-parse --short HEAD 2>/dev/null || true)"
printf 'git_commit=%s\n' "${commit:-not-versioned}"
worktree_status="$(git -C "$PROJECT_DIR" status --porcelain 2>/dev/null || true)"
if [[ -n "$commit" && -z "$worktree_status" ]]; then
  printf 'git_worktree=clean\n'
else
  printf 'git_worktree=modified-or-unknown\n'
fi

docker_version="$(docker --version 2>/dev/null || true)"
compose_version="$(docker compose version --short 2>/dev/null || true)"
printf 'docker=%s\n' "${docker_version:-unavailable}"
printf 'compose=%s\n' "${compose_version:-unavailable}"

if [[ -f "$PROJECT_DIR/.env" ]]; then
  env_mode="$(stat -c '%a' "$PROJECT_DIR/.env" 2>/dev/null || true)"
  transport="$(env_value WECHAT_TRANSPORT)"
  case "$transport" in
    wechat4u|android) ;;
    "") transport=wechat4u ;;
    *) transport=unsupported ;;
  esac
  llm_enabled="$(env_value LLM_ENABLED)"
  case "${llm_enabled,,}" in
    false|0|no|off) llm_status=disabled ;;
    *)
      [[ -n "$(env_value LLM_API_KEY)" ]] && llm_status=configured || llm_status=incomplete
      ;;
  esac
  if [[ -n "$(env_value FEISHU_APP_ID)" && -n "$(env_value FEISHU_APP_SECRET)" ]]; then
    feishu_status=configured
  else
    feishu_status=disabled-or-incomplete
  fi
  dashboard_port="$(env_value DASHBOARD_HOST_PORT)"
  [[ "$dashboard_port" =~ ^[0-9]+$ ]] || dashboard_port=6190
  printf 'env=present mode=%s\n' "${env_mode:-unknown}"
  printf 'transport=%s\n' "$transport"
  printf 'llm=%s\n' "$llm_status"
  printf 'feishu=%s\n' "$feishu_status"
else
  dashboard_port=6190
  printf 'env=missing\n'
  printf 'transport=unconfigured\n'
  printf 'llm=unconfigured\n'
  printf 'feishu=unconfigured\n'
fi

if docker inspect Feagle-wxbot >/dev/null 2>&1; then
  container_state="$(docker inspect --format '{{.State.Status}}' Feagle-wxbot 2>/dev/null || true)"
  container_health="$(docker inspect --format \
    '{{if .State.Health}}{{.State.Health.Status}}{{else}}not-configured{{end}}' \
    Feagle-wxbot 2>/dev/null || true)"
  printf 'container=%s health=%s\n' \
    "${container_state:-unknown}" "${container_health:-unknown}"
else
  printf 'container=absent health=unknown\n'
fi

printf 'dashboard_live_http=%s\n' \
  "$(http_status "http://127.0.0.1:${dashboard_port}/api/health/live")"
printf 'dashboard_ready_http=%s\n' \
  "$(http_status "http://127.0.0.1:${dashboard_port}/api/health/ready")"
[[ -d "$PROJECT_DIR/data" ]] && printf 'persistent_data=present\n' \
  || printf 'persistent_data=missing\n'

printf 'privacy=No secrets, addresses, message text, contacts, QR data, or logs collected.\n'
