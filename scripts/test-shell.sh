#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for script in "$PROJECT_DIR/wxbot-bridge" "$PROJECT_DIR"/scripts/*.sh; do
  bash -n "$script"
done

temporary_root="$(mktemp -d)"
cleanup() {
  case "$temporary_root" in
    /tmp/*) rm -rf -- "$temporary_root" ;;
    *) printf '拒绝清理异常临时目录：%s\n' "$temporary_root" >&2 ;;
  esac
}
trap cleanup EXIT

fake_bin="$temporary_root/bin"
mkdir -p "$fake_bin"

cat >"$fake_bin/docker" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == --version ]]; then
  printf 'Docker version test\n'
elif [[ "${1:-}" == compose && "${2:-}" == version ]]; then
  printf '2.0.0\n'
else
  exit 2
fi
EOF

cat >"$fake_bin/openssl" <<'EOF'
#!/usr/bin/env bash
printf '%064d\n' 0
EOF
chmod +x "$fake_bin/docker" "$fake_bin/openssl"

make_case() {
  local root="$1"
  mkdir -p "$root/scripts"
  cp "$PROJECT_DIR/scripts/setup.sh" "$root/scripts/setup.sh"
  cp "$PROJECT_DIR/scripts/doctor.sh" "$root/scripts/doctor.sh"
  cat >"$root/scripts/fetch-astrbot.sh" <<'EOF'
#!/usr/bin/env bash
printf 'AstrBot test fixture ready.\n'
EOF
  chmod +x "$root/scripts"/*.sh
}

android_case="$temporary_root/android-case"
make_case "$android_case"
printf '3\n2\n\n16291\n\n\n16290\n16285\nn\nn\n' \
  | PATH="$fake_bin:$PATH" "$android_case/scripts/setup.sh"

env_file="$android_case/.env"
grep -qx 'WECHAT_TRANSPORT=android' "$env_file"
grep -qx 'ANDROID_WS_BIND_HOST=127.0.0.1' "$env_file"
grep -qx 'ANDROID_WS_HOST_PORT=16291' "$env_file"
grep -qx 'DASHBOARD_HOST_PORT=16290' "$env_file"
grep -qx 'ASTRBOT_WEBUI_HOST_PORT=16285' "$env_file"
token="$(sed -n 's/^ANDROID_BRIDGE_TOKEN=//p' "$env_file")"
[[ ${#token} -eq 64 ]]
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) ;;
  *) [[ "$(stat -c '%a' "$env_file")" == 600 ]] ;;
esac

unsafe_case="$temporary_root/unsafe-case"
make_case "$unsafe_case"
if printf '3\n2\n0.0.0.0\n' \
  | PATH="$fake_bin:$PATH" "$unsafe_case/scripts/setup.sh"; then
  printf '不安全的 Android 公网绑定被意外接受。\n' >&2
  exit 1
fi
[[ ! -e "$unsafe_case/.env" ]]

printf 'Shell 向导测试通过。\n'
