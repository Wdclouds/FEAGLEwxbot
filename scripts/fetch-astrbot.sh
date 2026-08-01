#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_PATH="$PROJECT_DIR/.env"
TARGET="$PROJECT_DIR/bot/AstrBot"
DEFAULT_VERSION=v4.26.7
DEFAULT_SHA256=ad85c6405802752d4dc64c7d76c047cc815157e0fdae90079763eebd55fb9959

env_file_value() {
  local key="$1"
  [[ -f "$ENV_PATH" ]] || return 0
  sed -n "s/^${key}=//p" "$ENV_PATH" | tail -n 1
}

configured_value() {
  local key="$1"
  local fallback="$2"
  local shell_value="${!key-}"
  local file_value
  if [[ -n "$shell_value" ]]; then
    printf '%s' "$shell_value"
    return
  fi
  file_value="$(env_file_value "$key")"
  printf '%s' "${file_value:-$fallback}"
}

VERSION="${ASTRBOT_VERSION:-$DEFAULT_VERSION}"
EXPECTED_SHA256="$(configured_value ASTRBOT_SOURCE_SHA256 "$DEFAULT_SHA256")"
GITHUB_PROXY="$(configured_value ASTRBOT_GITHUB_PROXY "https://ghfast.top/")"
OFFICIAL_URL="https://github.com/AstrBotDevs/AstrBot/archive/refs/tags/${VERSION}.tar.gz"

if [[ -f "$TARGET/requirements.txt" && -f "$TARGET/main.py" ]]; then
  printf 'AstrBot 已存在，跳过下载。\n'
  exit 0
fi

if [[ ! "$EXPECTED_SHA256" =~ ^[A-Fa-f0-9]{64}$ ]]; then
  printf 'ASTRBOT_SOURCE_SHA256 不是有效的 SHA-256。\n' >&2
  exit 2
fi

if [[ "$VERSION" != "$DEFAULT_VERSION" && "$EXPECTED_SHA256" == "$DEFAULT_SHA256" ]]; then
  printf '自定义 AstrBot 版本时必须同时提供该版本的 ASTRBOT_SOURCE_SHA256。\n' >&2
  exit 2
fi

temporary_dir="$(mktemp -d)"
cleanup() {
  case "$temporary_dir" in
    /tmp/*) rm -rf -- "$temporary_dir" ;;
    *) printf '拒绝清理异常临时目录：%s\n' "$temporary_dir" >&2 ;;
  esac
}
trap cleanup EXIT

download_urls=()
if [[ -n "${ASTRBOT_SOURCE_URL:-}" ]]; then
  download_urls+=("$ASTRBOT_SOURCE_URL")
elif [[ -n "$GITHUB_PROXY" ]]; then
  download_urls+=("${GITHUB_PROXY%/}/${OFFICIAL_URL}")
fi
download_urls+=("$OFFICIAL_URL")

archive="$temporary_dir/astrbot.tar.gz"
downloaded=false
printf '正在下载 AstrBot %s（国内加速优先，官方源自动回退）...\n' "$VERSION"
for source_url in "${download_urls[@]}"; do
  if [[ "$source_url" != https://* ]]; then
    printf '跳过非 HTTPS 下载地址。\n' >&2
    continue
  fi
  rm -f -- "$archive"
  if ! curl --fail --location --retry 3 --connect-timeout 15 --max-time 180 \
    --proto '=https' --proto-redir '=https' \
    "$source_url" -o "$archive"; then
    printf '当前下载地址不可用，尝试下一地址。\n' >&2
    continue
  fi
  actual_sha256="$(sha256sum "$archive" | awk '{print $1}')"
  if [[ "${actual_sha256,,}" != "${EXPECTED_SHA256,,}" ]]; then
    printf '下载包 SHA-256 校验失败，已拒绝使用并尝试下一地址。\n' >&2
    continue
  fi
  downloaded=true
  break
done

if [[ "$downloaded" != true ]]; then
  printf 'AstrBot 下载失败：国内加速与官方源均不可用或校验未通过。\n' >&2
  exit 1
fi

mkdir -p "$temporary_dir/extracted"
tar -xzf "$archive" \
  --strip-components=1 \
  -C "$temporary_dir/extracted"

if [[ ! -f "$temporary_dir/extracted/requirements.txt" \
  || ! -f "$temporary_dir/extracted/main.py" ]]; then
  printf '下载内容不是有效的 AstrBot 源码。\n' >&2
  exit 1
fi

mkdir -p "$TARGET"
cp -a "$temporary_dir/extracted/." "$TARGET/"
printf 'AstrBot %s 下载完成，SHA-256 校验通过。\n' "$VERSION"
