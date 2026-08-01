# Diagnostic workflow

## Check the chain in order

Use the first failed layer as the working boundary:

```text
Docker → Dashboard → WeChat transport → OneBot reverse WS → AstrBot → model → reply transport
```

Run the bundled secret-free collector first. Then use the repository commands:

```bash
./wxbot-bridge doctor
./wxbot-bridge status
docker compose ps
```

Request logs only after the failing layer is known:

```bash
docker compose logs --since 10m --tail 300 bot
```

Redact the output before sharing it. Do not request the full `data/` directory, `.env`, QR image,
session file, contact mapping, or AstrBot database.

## Interpret common states

| Symptom | Likely boundary | Next check |
| --- | --- | --- |
| Browser refuses `127.0.0.1:6190` | Local SSH tunnel | Run the tunnel on the browser computer and keep it open |
| Container healthy, Dashboard not ready | Transport/OneBot/AstrBot | Inspect Dashboard component states |
| QR repeats while intentionally offline | Admin state | Select `MANUAL_OFFLINE`, not force-relogin test |
| `invalid_or_expired_code` | One-time QR/pairing flow | Generate a new code; do not reuse the old one |
| Android message channel connected, no events | Hook/Agent boundary | Verify supported app version and module status using Android Kit |
| OneBot connected, model request fails | AstrBot provider | Enable a provider and select a conversation model |
| Queue full | Upstream concurrency | Pause testing, inspect in-flight work, rate limits, and provider latency |
| Old message replies after quiet hours | Replay/dedup regression | Pause the bot and preserve event times plus redacted stable IDs |

## Avoid false repairs

- Do not clear cookies merely because readiness is false during a fresh QR login.
- Do not restart repeatedly while AstrBot is initializing.
- Do not treat Dashboard liveness as proof that message delivery works.
- Do not process or resend messages captured during quiet hours.
- Do not enable group replies to test a private-message failure.
- Do not disable rate limits, event ACKs, or persistent deduplication to make a test pass.

Finish with the failed layer, supporting evidence, safe repair options, and whether a live message
test still requires the user.
