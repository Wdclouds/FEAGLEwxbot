# Security Policy

## Secrets and personal data

Do not submit API keys, Feishu secrets, WeChat sessions, cookies, QR codes,
contact data, message databases, server addresses, SSH credentials, or private
logs to issues, pull requests, or discussions.

The following paths are intentionally excluded from Git:

```text
.env
data/
bot/AstrBot/
bot/data/
bot/downloads/
bot/tools/
```

Run this command before every public commit:

```bash
./scripts/check-secrets.sh
```

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting or contact the repository
owner privately. Do not publish exploitable details or real credentials in a
public issue.

If a credential is ever exposed, remove it from the repository history and
revoke or rotate it immediately. Deleting only the latest file is not enough.
