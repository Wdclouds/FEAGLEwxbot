# Android Agent workflow

## Supported baseline

Use the companion repository:
[FEAGLEwxbot Android Kit](https://github.com/Wdclouds/FEAGLEwxbot-android-kit).

The verified project baseline is Android 14, Magisk/Zygisk, LSPosed/Vector, and WeChat `8.0.70`.
Treat the exact supported version as a hard compatibility gate. Require the device owner to perform
bootloader unlock, Root, account login, and sensitive permission approval.

Current verified scope is private inbound text and private text replies. Do not claim support for
group chat, media, files, historical collection, or arbitrary client versions.

## Divide responsibilities

- Windows + Android Kit: ADB detection, prerequisites, build, install, device checks, module status,
  endpoint configuration, and pairing UI.
- Android device: WeChat client, versioned adapter, Binder connection, persistent outbound queue,
  ACK handling, heartbeat, and reconnect.
- ECS Bridge: authenticated Android WebSocket, stable event deduplication, OneBot conversion, and
  AstrBot connection.

Do not silently enable notification access. Treat notification capture as an explicitly approved,
limited fallback rather than the primary verified route.

## Connect safely

Select `WECHAT_TRANSPORT=android`; never run it alongside Wechat4u for the same account. Use one of:

- `wss://DOMAIN/android` through a reviewed TLS reverse proxy; or
- `ws://TAILSCALE_IP:6191/android` within the encrypted Tailnet.

Reject ordinary public `ws://`, `0.0.0.0` exposure, and opening port `6191` directly in a cloud
security group. Generate a fresh one-time pairing code on the server and enter it only in the Agent.
The code disappearing after successful pairing is expected.

## Verify by layer

1. Confirm the supported WeChat version and enabled module scope.
2. Confirm Agent and message channel connection.
3. Send one private text from another account.
4. Confirm Hook capture without logging text or contact identifiers.
5. Confirm Agent receives `event_ack` from ECS.
6. Confirm OneBot forwards one event to AstrBot.
7. Confirm one text reply returns to the device.

Stop at the first missing layer. Do not compensate by repeatedly sending messages or disabling
deduplication and rate limits.
