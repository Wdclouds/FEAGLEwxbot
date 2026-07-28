#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

mapfile -d '' files < <(git ls-files --cached --others --exclude-standard -z)
failures=0

for path in "${files[@]}"; do
  case "$path" in
    .env|.env.*|bot/.env|data/*|bot/data/*|*/session.json|*.db|*.sqlite|*.pem|*.key)
      if [[ "$path" != ".env.example" ]]; then
        printf '禁止提交敏感或运行时文件：%s\n' "$path" >&2
        failures=$((failures + 1))
      fi
      ;;
  esac
done

if [[ "${#files[@]}" -gt 0 ]]; then
  secret_hits="$(
    rg -l --no-messages \
      '(-----BEGIN ([A-Z ]+ )?PRIVATE KEY-----|sk-[A-Za-z0-9_-]{24,}|gh[opsu]_[A-Za-z0-9]{30,}|AIza[A-Za-z0-9_-]{30,})' \
      "${files[@]}" || true
  )"
  if [[ -n "$secret_hits" ]]; then
    printf '疑似密钥出现在以下文件中：\n%s\n' "$secret_hits" >&2
    failures=$((failures + 1))
  fi
fi

if [[ "$failures" -gt 0 ]]; then
  exit 1
fi

printf '隐私与密钥检查通过。\n'
