#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FEAGLE_TARGET="/usr/local/bin/feagle"
BRIDGE_TARGET="/usr/local/bin/wxbot-bridge"

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  printf '请使用 sudo 运行：sudo ./scripts/install-command.sh\n' >&2
  exit 1
fi

cat >"$FEAGLE_TARGET" <<EOF
#!/usr/bin/env bash
export FEAGLE_WXBOT_HOME="$PROJECT_DIR"
exec "$PROJECT_DIR/feagle" "\$@"
EOF
cat >"$BRIDGE_TARGET" <<EOF
#!/usr/bin/env bash
export FEAGLE_WXBOT_HOME="$PROJECT_DIR"
exec "$PROJECT_DIR/wxbot-bridge" "\$@"
EOF
chmod 755 "$FEAGLE_TARGET" "$BRIDGE_TARGET"
printf '已安装 %s，并保留兼容命令 %s。\n' "$FEAGLE_TARGET" "$BRIDGE_TARGET"
printf '现在可以运行 feagle bridge setup。\n'
