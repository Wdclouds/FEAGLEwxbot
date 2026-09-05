#!/usr/bin/env bash
# ==============================================================================
# FEAGLE WxBot 规范发布打包脚本 (package-release.sh)
# 用于构建面向 Linux 生产环境的标准分发归档包 (feagle-suite-linux-amd64)
# ==============================================================================
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="${PROJECT_ROOT}/dist"
VERSION_FILE="${PROJECT_ROOT}/VERSION"

VERSION="0.6.0"
if [ -f "$VERSION_FILE" ]; then
  VERSION=$(tr -d ' \r\n' < "$VERSION_FILE")
fi
if [ -n "${1:-}" ]; then
  VERSION="$1"
fi

ARCHIVE_NAME="feagle-suite-linux-amd64-v${VERSION}.tar.gz"

echo "=================================================="
echo "  FEAGLE WxBot Linux Release 归档构建器"
echo "  构建版本: v${VERSION}"
echo "  输出归档: ${ARCHIVE_NAME}"
echo "=================================================="

mkdir -p "$DIST_DIR"

# 创建临时打包工作区
BUILD_TMP=$(mktemp -d 2>/dev/null || mktemp -d -t 'feagle_build')
trap 'rm -rf "$BUILD_TMP"' EXIT

PACKAGE_ROOT="${BUILD_TMP}/feagle-suite"
mkdir -p "$PACKAGE_ROOT"

echo "[1/4] 正在复制核心部署文件与引导脚本..."
cp -r "${PROJECT_ROOT}/install.sh" "$PACKAGE_ROOT/"
cp -r "${PROJECT_ROOT}/docker-compose.yml" "$PACKAGE_ROOT/"
cp -r "${PROJECT_ROOT}/.env.example" "$PACKAGE_ROOT/"
cp -r "${PROJECT_ROOT}/README.md" "$PACKAGE_ROOT/"
cp -r "${PROJECT_ROOT}/VERSION" "$PACKAGE_ROOT/"

mkdir -p "$PACKAGE_ROOT/scripts"
cp -r "${PROJECT_ROOT}/scripts/auto-mirror.sh" "$PACKAGE_ROOT/scripts/"

mkdir -p "$PACKAGE_ROOT/deploy"
if [ -d "${PROJECT_ROOT}/deploy" ]; then
  cp -r "${PROJECT_ROOT}/deploy/"* "$PACKAGE_ROOT/deploy/" 2>/dev/null || true
fi

echo "[2/4] 正在同步 Bridge 核心业务代码 (排除开发缓存与运行时数据)..."
mkdir -p "$PACKAGE_ROOT/apps/bridge"
tar --exclude='node_modules' \
    --exclude='.git' \
    --exclude='*.log' \
    --exclude='dist' \
    --exclude='coverage' \
    -C "${PROJECT_ROOT}/apps/bridge" -cf - . | tar -C "$PACKAGE_ROOT/apps/bridge" -xf -

echo "[3/4] 赋予执行权限并清理非必要文件..."
chmod +x "$PACKAGE_ROOT/install.sh"
chmod +x "$PACKAGE_ROOT/scripts/auto-mirror.sh"

echo "[4/4] 正在生成最终 tar.gz 归档..."
tar -C "$BUILD_TMP" -czf "${DIST_DIR}/${ARCHIVE_NAME}" feagle-suite

echo "=================================================="
echo "  Release 归档构建成功！"
echo "  产物路径: ${DIST_DIR}/${ARCHIVE_NAME}"
ls -lh "${DIST_DIR}/${ARCHIVE_NAME}"
echo "=================================================="
