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

cat >"$fake_bin/curl" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
output=
while (($#)); do
  if [[ "$1" == -o ]]; then
    output="$2"
    shift 2
  else
    shift
  fi
done
cp "$FAKE_ASTRBOT_ARCHIVE" "$output"
EOF
chmod +x "$fake_bin/docker" "$fake_bin/openssl" "$fake_bin/curl"

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
grep -qx 'NPM_REGISTRY=https://registry.npmmirror.com' "$env_file"
grep -qx 'PYPI_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/' "$env_file"
grep -qx 'ASTRBOT_GITHUB_PROXY=https://ghfast.top/' "$env_file"
grep -Eq '^ASTRBOT_SOURCE_SHA256=[0-9a-f]{64}$' "$env_file"
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

fetch_case="$temporary_root/fetch-case"
mkdir -p "$fetch_case/scripts" "$fetch_case/source/AstrBot-test"
cp "$PROJECT_DIR/scripts/fetch-astrbot.sh" "$fetch_case/scripts/fetch-astrbot.sh"
printf 'dependency\n' >"$fetch_case/source/AstrBot-test/requirements.txt"
printf 'print("test")\n' >"$fetch_case/source/AstrBot-test/main.py"
tar -czf "$fetch_case/astrbot.tar.gz" -C "$fetch_case/source" AstrBot-test
fetch_sha="$(sha256sum "$fetch_case/astrbot.tar.gz" | awk '{print $1}')"
cat >"$fetch_case/.env" <<EOF
ASTRBOT_GITHUB_PROXY=https://mirror.invalid/
ASTRBOT_SOURCE_SHA256=$fetch_sha
EOF
FAKE_ASTRBOT_ARCHIVE="$fetch_case/astrbot.tar.gz" \
  PATH="$fake_bin:$PATH" "$fetch_case/scripts/fetch-astrbot.sh"
[[ -f "$fetch_case/bot/AstrBot/requirements.txt" ]]
[[ -f "$fetch_case/bot/AstrBot/main.py" ]]

bad_fetch_case="$temporary_root/bad-fetch-case"
mkdir -p "$bad_fetch_case/scripts"
cp "$PROJECT_DIR/scripts/fetch-astrbot.sh" "$bad_fetch_case/scripts/fetch-astrbot.sh"
cat >"$bad_fetch_case/.env" <<'EOF'
ASTRBOT_GITHUB_PROXY=https://mirror.invalid/
ASTRBOT_SOURCE_SHA256=0000000000000000000000000000000000000000000000000000000000000000
EOF
if FAKE_ASTRBOT_ARCHIVE="$fetch_case/astrbot.tar.gz" \
  PATH="$fake_bin:$PATH" "$bad_fetch_case/scripts/fetch-astrbot.sh"; then
  printf 'SHA-256 不一致的 AstrBot 包被意外接受。\n' >&2
  exit 1
fi
[[ ! -e "$bad_fetch_case/bot/AstrBot" ]]

printf 'Shell 向导测试通过。\n'
