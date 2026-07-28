#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="/usr/local/bin/wxbot-bridge"

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  printf '请使用 sudo 运行：sudo ./scripts/install-command.sh\n' >&2
  exit 1
fi

cat >"$TARGET" <<EOF
#!/usr/bin/env bash
export FEAGLE_WXBOT_HOME="$PROJECT_DIR"
exec "$PROJECT_DIR/wxbot-bridge" "\$@"
EOF
chmod 755 "$TARGET"
printf '已安装 %s。现在可以直接运行 wxbot-bridge。\n' "$TARGET"
