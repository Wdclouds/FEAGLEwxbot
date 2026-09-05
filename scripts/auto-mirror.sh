#!/usr/bin/env bash
# ==============================================================================
# FEAGLE WxBot 智能网络测速与镜像自适应加速引擎 (auto-mirror.sh)
# ==============================================================================
set -euo pipefail

log_info()  { echo -e "\033[34m[INFO]\033[0m $*"; }
log_succ()  { echo -e "\033[32m[SUCCESS]\033[0m $*"; }
log_warn()  { echo -e "\033[33m[WARN]\033[0m $*"; }

test_url_latency_ms() {
  local url="$1"
  local timeout="${2:-2}"
  local start_ts end_ts
  start_ts=$(date +%s%3N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1000))')
  if curl -fsSL -m "$timeout" -o /dev/null "$url" >/dev/null 2>&1; then
    end_ts=$(date +%s%3N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1000))')
    echo $((end_ts - start_ts))
  else
    echo "99999"
  fi
}

log_info "正在进行全局网络延迟探测 (1秒极速探测)..."

GITHUB_LATENCY=$(test_url_latency_ms "https://github.com" 2)
GHFAST_LATENCY=$(test_url_latency_ms "https://ghfast.top" 2)
NPM_OFFICIAL_LATENCY=$(test_url_latency_ms "https://registry.npmjs.org" 2)
NPM_MIRROR_LATENCY=$(test_url_latency_ms "https://registry.npmmirror.com" 2)

IS_CHINA_NETWORK=false

if [ "$GITHUB_LATENCY" -gt 2500 ] || [ "$GHFAST_LATENCY" -lt "$GITHUB_LATENCY" ]; then
  IS_CHINA_NETWORK=true
fi

echo "--------------------------------------------------------"
echo "  GitHub 延迟:      ${GITHUB_LATENCY} ms"
echo "  国内加速代理延迟: ${GHFAST_LATENCY} ms"
echo "  NPM 官方延迟:     ${NPM_OFFICIAL_LATENCY} ms"
echo "  NPM 国内镜像延迟: ${NPM_MIRROR_LATENCY} ms"
echo "--------------------------------------------------------"

if [ "$IS_CHINA_NETWORK" = true ]; then
  log_succ "检测到当前环境处于国内网络，自动激活国内高速镜像矩阵！"
  export GH_PROXY="https://ghfast.top/"
  export NPM_REGISTRY="https://registry.npmmirror.com"
  export ALPINE_MIRROR="https://mirrors.aliyun.com/alpine"
  export PYPI_INDEX_URL="https://mirrors.aliyun.com/pypi/simple/"
else
  log_succ "检测到当前环境国际互联网访问畅通，使用官方源！"
  export GH_PROXY=""
  export NPM_REGISTRY="https://registry.npmjs.org"
  export ALPINE_MIRROR="https://dl-cdn.alpinelinux.org/alpine"
  export PYPI_INDEX_URL="https://pypi.org/simple"
fi

# 若存在 .env，将测速结果写回 .env
if [ -f ".env" ]; then
  log_info "正在将优化镜像配置同步更新至 .env ..."
  sed -i "s|^ALPINE_MIRROR=.*|ALPINE_MIRROR=${ALPINE_MIRROR}|" .env
  sed -i "s|^NPM_REGISTRY=.*|NPM_REGISTRY=${NPM_REGISTRY}|" .env
  sed -i "s|^PYPI_INDEX_URL=.*|PYPI_INDEX_URL=${PYPI_INDEX_URL}|" .env
  sed -i "s|^ASTRBOT_GITHUB_PROXY=.*|ASTRBOT_GITHUB_PROXY=${GH_PROXY}|" .env
  log_succ ".env 镜像配置同步完成。"
fi
