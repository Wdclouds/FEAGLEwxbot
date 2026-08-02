import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AndroidWechatClient } from '../src/android-client.js';
import { IdMap } from '../src/id-map.js';
import { MessageGuard } from '../src/message-guard.js';
import { RuntimeState } from '../src/state.js';

const token = String(
  process.env.ANDROID_BRIDGE_TOKEN || process.argv[2] || '',
).trim();
if (token.length < 24) {
  throw new Error('Set ANDROID_BRIDGE_TOKEN to at least 24 characters');
}

const directory = mkdtempSync(join(tmpdir(), 'feagle-android-smoke-'));
const idMap = new IdMap(join(directory, 'mapping.sqlite'));
const state = new RuntimeState();
let received = 0;
let replies = 0;
let replyFailures = 0;
const replyText = String(process.env.ANDROID_SMOKE_REPLY_TEXT || '');
const statusFile = String(process.env.ANDROID_SMOKE_STATUS_FILE || '').trim();
let lastReplyError = '';

function writeStatus(status = 'running') {
  if (!statusFile) return;
  writeFileSync(statusFile, JSON.stringify({
    status,
    received,
    replies,
    replyFailures,
    lastReplyError,
  }));
}

const client = new AndroidWechatClient({
  state,
  idMap,
  isSleeping: () => false,
  messageGuard: new MessageGuard(),
  onPrivateText: async ({ userId, text }) => {
    received += 1;
    writeStatus();
    console.log(`[Smoke] private text accepted length=${Array.from(text).length}`);
    if (!replyText) return;
    try {
      await client.sendText(userId, replyText);
      replies += 1;
      lastReplyError = '';
      writeStatus();
      console.log('[Smoke] notification reply accepted');
    } catch (error) {
      replyFailures += 1;
      lastReplyError = String(error?.message || 'unknown');
      writeStatus();
      console.log(
        `[Smoke] notification reply failed reason=${error?.message || 'unknown'}`,
      );
    }
  },
  host: '127.0.0.1',
  port: 6191,
  token,
});

await client.start();
writeStatus('ready');
console.log('[Smoke] ready; send one private text to the tablet account');

const statusTimer = setInterval(() => {
  const snapshot = state.snapshot();
  console.log(
    `[Smoke] status=${snapshot.wechat.status} received=${received}`
      + ` replies=${replies} replyFailures=${replyFailures}`,
  );
  writeStatus('stopping');
}, 10_000);
statusTimer.unref();

function stop(signal) {
  console.log(
    `[Smoke] stopping on ${signal}; received=${received}`
      + ` replies=${replies} replyFailures=${replyFailures}`,
  );
  clearInterval(statusTimer);
  client.shutdown();
  idMap.close();
  setTimeout(() => process.exit(0), 100).unref();
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
