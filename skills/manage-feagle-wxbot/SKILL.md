---
name: manage-feagle-wxbot
description: Safely deploy, configure, operate, update, and diagnose FEAGLEwxbot Bridge installations, including Wechat4u, Android Agent, AstrBot, OneBot, Dashboard, Feishu notifications, SSH tunnels, Docker health, and privacy-preserving support bundles. Use when a user asks an agent to install, start, stop, inspect, repair, migrate, or explain FEAGLEwxbot, including Chinese requests such as 部署、启动、停止、排错、重建、飞书配置、安卓接入 or Dashboard 无法访问.
---

# Manage FEAGLE WxBot

Operate FEAGLEwxbot through its checked-in commands and documented safety boundaries. Treat the
repository version currently deployed by the user as the source of truth.

## Establish context

1. Locate the repository root containing `wxbot-bridge` and `docker-compose.yml`.
2. Inspect `git status --short`, `git rev-parse --short HEAD`, `.env` existence, and container state
   before proposing a mutation.
3. Never assume that a local checkout, an SSH server, and the user's browser are the same machine.
4. Identify the requested task and read only the matching reference:

   - New installation or reconfiguration: [deployment.md](references/deployment.md)
   - Status investigation or failures: [diagnostics.md](references/diagnostics.md)
   - Secrets, logs, backups, deletion, or public reports: [privacy.md](references/privacy.md)
   - Android transport: [android-agent.md](references/android-agent.md)

## Route the task

### Deploy or reconfigure

Follow [deployment.md](references/deployment.md). Prefer `./wxbot-bridge setup` and
`./wxbot-bridge doctor` over reproducing their logic manually. Let the user enter API keys and App
Secrets directly in their own terminal; do not ask them to paste secrets into chat.

Keep Dashboard and AstrBot bound to `127.0.0.1`. Run the printed SSH tunnel command on the user's
computer, not inside the already-open server shell. Do not open management or Android transport
ports to the public internet merely to make setup easier.

### Inspect or diagnose

Start read-only. Run:

```bash
skills/manage-feagle-wxbot/scripts/collect-status.sh /path/to/FEAGLEwxbot-bridge
```

Use the resulting secret-free summary before requesting logs. Follow
[diagnostics.md](references/diagnostics.md), moving through Docker, Dashboard, transport, OneBot,
AstrBot, and model status in that order. Request the smallest relevant log window and redact it
according to [privacy.md](references/privacy.md).

Diagnose when the user asks for an explanation. Do not silently turn a diagnostic request into a
repair or redeployment.

### Operate

Use the project wrapper:

```bash
./wxbot-bridge start
./wxbot-bridge stop
./wxbot-bridge restart
./wxbot-bridge status
./wxbot-bridge logs
```

Limit Docker actions to the `bot` service unless the user explicitly places another service in
scope. Do not modify or remove an unrelated website container.

Treat Dashboard `MANUAL_OFFLINE` as an intentional quiet state: do not auto-reconnect or send QR
alerts until the user resumes. Treat quiet hours as message dropping while the session stays alive;
night-time messages must not be replayed after quiet hours.

### Use Android transport

Read [android-agent.md](references/android-agent.md). Keep Wechat4u and Android mutually exclusive.
Use the public Android Kit workflow for device preparation and pairing; do not invent undocumented
Hook points or bypass client protections. Require WSS or a Tailscale private address for remote
transport and keep one-time pairing codes out of public logs.

### Update, reset, or remove

Inspect local changes and persistent paths first. Preserve `.env`, `data/`, AstrBot state, and device
pairing state unless the user explicitly authorizes their removal. Before a destructive reset:

1. State the exact repository, container, volume, and host paths affected.
2. Separate stopping containers from deleting persistent files.
3. Offer a recoverable backup when the data is not explicitly disposable.
4. Require explicit confirmation for any scope broader than the bot service.

Never use broad recursive deletion against a workspace root, home directory, `/opt`, or an
unresolved variable.

## Completion criteria

Report outcomes by layer:

- container is running and healthy;
- Dashboard liveness is reachable locally;
- exactly one WeChat transport is connected;
- OneBot is connected to AstrBot;
- AstrBot has an enabled conversation model;
- an end-to-end private text test succeeds when the user authorizes live testing.

State any remaining manual step, such as scanning a QR code, approving a Feishu app, entering a
secret, configuring a rooted device, or keeping an SSH tunnel open. Never include the secret value
in the handoff.
