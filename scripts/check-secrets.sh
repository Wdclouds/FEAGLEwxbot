#!/usr/bin/env bash
# ==============================================================================
# FEAGLE WxBot 仓库脱敏与敏感信息安全门禁脚本 (check-secrets.sh)
# ==============================================================================
set -euo pipefail

echo "=== FEAGLE WxBot 敏感信息与脱敏安全门禁 ==="

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

ERRORS=0

# 1. 检查是否存在未被忽略的敏感 .env 文件
if git ls-files --error-unmatch .env >/dev/null 2>&1; then
  echo "[FAIL] 发现被 git 跟踪的真实 .env 文件，存在凭据泄露风险！"
  ERRORS=$((ERRORS + 1))
else
  echo "[PASS] 未发现跟踪的 .env 凭据文件"
fi

# 2. 检查私钥文件
PRIVATE_KEYS=$(git ls-files "*.pem" "*.key" "id_rsa*" 2>/dev/null || true)
if [ -n "$PRIVATE_KEYS" ]; then
  echo "[FAIL] 发现私钥证书文件: $PRIVATE_KEYS"
  ERRORS=$((ERRORS + 1))
else
  echo "[PASS] 未发现明文私钥文件"
fi

# 3. 检查微信数据库文件与真实备份
SQLITE_FILES=$(git ls-files "*.db" "*.sqlite" "*.sqlite3" 2>/dev/null || true)
if [ -n "$SQLITE_FILES" ]; then
  echo "[FAIL] 发现 SQLite 数据库跟踪文件: $SQLITE_FILES"
  ERRORS=$((ERRORS + 1))
else
  echo "[PASS] 未发现跟踪的数据库文件"
fi

echo "=========================================="
if [ "$ERRORS" -gt 0 ]; then
  echo "[FAIL] 安全检查未通过，共检测到 $ERRORS 项隐患！"
  exit 1
fi

echo "[SUCCESS] 仓库安全与脱敏检查全部通过！"
exit 0
