# Security Policy

## Secrets and personal data

Do not submit API keys, Feishu secrets, WeChat sessions, cookies, QR codes,
contact data, message databases, server addresses, SSH credentials, or private
logs to issues, pull requests, or discussions.

The following paths are intentionally excluded from Git:

```text
.env
data/
apps/bridge/AstrBot/
apps/bridge/data/
apps/bridge/downloads/
apps/bridge/tools/
.tools/
diagnostics/
apps/android-agent/local.properties
apps/android-agent/**/build/
```

Run this command before every public commit:

```bash
./scripts/check-secrets.sh
```

## APK and Android device safety

Do not publish, mirror, or attach WeChat APK files to this repository. A candidate
package must not be treated as verified until its package name, version, file
SHA-256, signing-certificate SHA-256, ABI and verification context all match the
pinned manifest.

- Installing or updating the Agent requires explicit user confirmation.
- The tools must not silently enable Root, Zygisk, module scope, VPN, notification
  access or other sensitive permissions.
- The installer must not uninstall an Agent with a different signer to force an
  update.
- Do not commit pairing codes, device tokens, device identifiers, ADB archives,
  private Tailnet data, APK outputs or device logs.
- Status commands may report redacted state but must not print the stored Bridge
  token or message content.
- Keep the Gradle Wrapper distribution checksum pinned to an official release.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting or contact the repository
owner privately. Do not publish exploitable details or real credentials in a
public issue.

If a credential is ever exposed, remove it from the repository history and
revoke or rotate it immediately. Deleting only the latest file is not enough.
