#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="$PROJECT_DIR/bot/AstrBot"
VERSION="${ASTRBOT_VERSION:-v4.26.7}"
SOURCE_URL="${ASTRBOT_SOURCE_URL:-https://github.com/AstrBotDevs/AstrBot/archive/refs/tags/${VERSION}.tar.gz}"

if [[ -f "$TARGET/requirements.txt" && -f "$TARGET/main.py" ]]; then
  printf 'AstrBot 已存在，跳过下载。\n'
  exit 0
fi

temporary_dir="$(mktemp -d)"
cleanup() { rm -rf -- "$temporary_dir"; }
trap cleanup EXIT

printf '正在下载 AstrBot %s...\n' "$VERSION"
curl --fail --location --retry 3 --connect-timeout 15 \
  "$SOURCE_URL" -o "$temporary_dir/astrbot.tar.gz"
mkdir -p "$temporary_dir/extracted"
tar -xzf "$temporary_dir/astrbot.tar.gz" \
  --strip-components=1 \
  -C "$temporary_dir/extracted"

if [[ ! -f "$temporary_dir/extracted/requirements.txt" ]]; then
  printf '下载内容不是有效的 AstrBot 源码。\n' >&2
  exit 1
fi

mkdir -p "$TARGET"
cp -a "$temporary_dir/extracted/." "$TARGET/"
printf 'AstrBot %s 下载完成。\n' "$VERSION"
