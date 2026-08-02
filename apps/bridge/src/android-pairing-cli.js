#!/usr/bin/env node
import { AndroidPairingStore } from './android-pairing-store.js';

function usage() {
  console.error(`Usage:
  node src/android-pairing-cli.js create [--json]
  node src/android-pairing-cli.js list [--json]
  node src/android-pairing-cli.js revoke <device-id> [--json]`);
}

function output(value, json, format) {
  console.log(json ? JSON.stringify(value) : format(value));
}

const [command, argument] = process.argv.slice(2).filter((item) => item !== '--json');
const json = process.argv.includes('--json');
const secret = String(process.env.ANDROID_BRIDGE_TOKEN || '').trim();

if (secret.length < 24) {
  console.error('ANDROID_BRIDGE_TOKEN must contain at least 24 characters.');
  process.exitCode = 2;
} else {
  const store = new AndroidPairingStore({
    path: process.env.ANDROID_PAIRING_DB_PATH || '/app/data/android/pairing.sqlite',
    secret,
  });
  try {
    if (command === 'create') {
      const result = store.createCode();
      output(result, json, ({ code, expiresAt }) => (
        `Pairing code: ${code}\nExpires: ${new Date(expiresAt).toISOString()}`
      ));
    } else if (command === 'list') {
      const devices = store.devices();
      output(devices, json, (items) => (
        items.length
          ? items.map((item) => `${item.deviceId}\t${item.revokedAt ? 'revoked' : 'active'}`).join('\n')
          : 'No paired Android devices.'
      ));
    } else if (command === 'revoke' && argument) {
      const revoked = store.revokeDevice(argument);
      output({ deviceId: argument, revoked }, json, (result) => (
        result.revoked ? `Revoked: ${result.deviceId}` : `No active device: ${result.deviceId}`
      ));
      if (!revoked) process.exitCode = 1;
    } else {
      usage();
      process.exitCode = 2;
    }
  } finally {
    store.close();
  }
}
