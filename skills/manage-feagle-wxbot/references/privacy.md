# Privacy and change safety

## Never expose

- `.env`, model API keys, Feishu App Secret, access tokens, Android pairing/device tokens;
- WeChat QR codes, cookies, sessions, contact identifiers, nicknames, message text, and databases;
- SSH passwords, private keys, public server addresses, private network addresses, and full logs;
- AstrBot credentials or conversation history.

Ask the user to enter secrets locally. If a secret appears in chat, screenshots, Git history, or an
Issue, recommend revoking and rotating it; merely deleting the newest file is insufficient.

## Produce safe support evidence

Prefer the bundled `collect-status.sh` output. If additional logs are necessary:

1. Limit by time and line count.
2. Remove message content and QR payloads.
3. Replace IDs, IPs, domains, usernames, and paths with stable placeholders.
4. Preserve timestamps, component names, error codes, state transitions, and duplicate counts.
5. Run `./scripts/check-secrets.sh` before any public commit.

Do not paste an entire `.env` and attempt to redact it afterward.

## Control mutations

Treat read-only inspection, start, stop, and restart as separate operations. A request to diagnose
does not authorize a repair. A request to remove a container does not authorize deletion of `.env`,
`data/`, another Compose project, or unrelated containers.

Before reset or migration, inventory:

- repository absolute path;
- Compose project and exact service names;
- `.env` and its backups;
- `data/` and AstrBot state;
- transport selection and Android pairing state.

Use explicit literal paths. Avoid broad globs and unresolved environment variables for deletion.
