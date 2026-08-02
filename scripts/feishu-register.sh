#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_PATH="$PROJECT_DIR/.env"
OUTPUT_PATH="${1:-}"

if [[ -z "$OUTPUT_PATH" ]]; then
  printf '用法：%s <凭据输出文件>\n' "$0" >&2
  exit 2
fi

env_value() {
  local key="$1"
  [[ -f "$ENV_PATH" ]] || return 0
  sed -n "s/^${key}=//p" "$ENV_PATH" | tail -n 1
}

node_image="$(env_value NODE_IMAGE)"
npm_registry="$(env_value NPM_REGISTRY)"
node_image="${node_image:-node:22-alpine}"
npm_registry="${npm_registry:-https://registry.npmmirror.com}"

if [[ "$npm_registry" != https://* ]]; then
  printf 'NPM_REGISTRY 必须使用 HTTPS。\n' >&2
  exit 2
fi

work_dir="$(mktemp -d)"
cleanup() {
  case "$work_dir" in
    /tmp/*) rm -rf -- "$work_dir" ;;
    *) printf '拒绝清理异常临时目录：%s\n' "$work_dir" >&2 ;;
  esac
}
trap cleanup EXIT

cp "$PROJECT_DIR/apps/bridge/package.json" "$work_dir/package.json"
cp "$PROJECT_DIR/apps/bridge/package-lock.json" "$work_dir/package-lock.json"
cp "$PROJECT_DIR/apps/bridge/src/feishu-register-cli.js" "$work_dir/feishu-register-cli.js"

printf '正在准备飞书官方扫码配置工具...\n'
docker run --rm -i \
  --label com.feaglewxbot.purpose=feishu-setup \
  --user "$(id -u):$(id -g)" \
  -e HOME=/tmp \
  -e npm_config_cache=/tmp/npm-cache \
  -e npm_config_registry="$npm_registry" \
  -e npm_config_replace_registry_host=always \
  -v "$work_dir:/work" \
  -w /work \
  "$node_image" \
  sh -eu -c 'npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null && node ./feishu-register-cli.js --output /work/credentials.env'

if [[ ! -s "$work_dir/credentials.env" ]]; then
  printf '飞书扫码配置没有返回凭据。\n' >&2
  exit 1
fi
install -m 600 "$work_dir/credentials.env" "$OUTPUT_PATH"
