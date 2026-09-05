#!/usr/bin/env bash
# ==============================================================================
# FEAGLE WxBot 开发者一键打包脱敏脚本 (backup-pack.sh)
# ==============================================================================
set -euo pipefail

BACKUP_DIR="backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
ARCHIVE_NAME="feagle_backup_${TIMESTAMP}.tar.gz"

mkdir -p "$BACKUP_DIR"

echo "=== FEAGLE WxBot 数据打包归档 ==="
echo "1. 正在创建脱敏备份包..."

tar --exclude='.git' \
    --exclude='node_modules' \
    --exclude='.tools' \
    --exclude='*.apk' \
    --exclude='*.log' \
    -czf "${BACKUP_DIR}/${ARCHIVE_NAME}" \
    apps/ deploy/ docs/ scripts/ docker-compose.yml .env.example README.md

echo "2. 备份已成功生成: ${BACKUP_DIR}/${ARCHIVE_NAME}"
ls -lh "${BACKUP_DIR}/${ARCHIVE_NAME}"
echo "================================="
