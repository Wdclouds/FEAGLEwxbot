# Deployment workflow

## Separate the machines

- Run Linux and Docker commands on the server.
- Run `ssh -L` or the Windows tunnel helper on the computer that owns the browser.
- Perform WeChat and Feishu scans on the user's trusted phone.
- Run Android Kit and ADB commands on the Windows computer connected to the rooted device.

Never tell a user to open `http://127.0.0.1:6190` on their computer until a tunnel is running there.

## Prepare the server

Require Linux x86-64, Docker Engine, Docker Compose v2, `curl`, `tar`, at least 2 GB RAM, and about
10 GB free disk. For a mainland China server, use the repository's default mirrors and checksum
verification:

```bash
git clone https://ghfast.top/https://github.com/Wdclouds/FEAGLEwxbot-bridge.git
cd FEAGLEwxbot-bridge
chmod +x wxbot-bridge scripts/*.sh
./wxbot-bridge setup
```

If the GitHub accelerator is unavailable, remove only the `https://ghfast.top/` prefix. Do not
replace it with an unreviewed executable mirror.

## Run the guided setup

Let the user choose:

- model provider and model name;
- Wechat4u or Android transport;
- timezone and quiet hours;
- local Dashboard and AstrBot ports;
- optional Feishu notifications.

Do not collect model keys or Feishu secrets in chat. Pause while the user enters them in the hidden
terminal prompt. For Feishu, prefer official QR registration; it can create a new app or select an
existing app. Keep the manual credential path as a fallback.

The setup script writes `.env` with mode `600`, downloads a pinned AstrBot archive, verifies its
SHA-256 checksum, and optionally starts the bot. If `.env` exists, preserve its timestamped backup.

## Access management pages

Use the ports printed by `./wxbot-bridge start`. With defaults, run this on the user's computer:

```bash
ssh -N -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -L 6190:127.0.0.1:6190 \
  -L 6185:127.0.0.1:6185 \
  root@SERVER_PUBLIC_IP
```

Keep the terminal open, then visit Dashboard at `http://127.0.0.1:6190` and AstrBot at
`http://127.0.0.1:6185`. Do not open these ports in a cloud security group.

## Finish first login

For Wechat4u, scan the Dashboard QR code and wait for WeChat `ONLINE/HEALTHY`, OneBot `CONNECTED`,
and AstrBot `READY`. For Android, switch to [android-agent.md](android-agent.md).

Confirm AstrBot has an enabled provider and default conversation model before sending one short
private test message. Avoid group testing until the group gate and allowlist are deliberately
enabled.
