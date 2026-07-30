import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { AndroidWechatClient } from '../src/android-client.js';
import { IdMap } from '../src/id-map.js';
import { MessageGuard } from '../src/message-guard.js';
import { RuntimeState } from '../src/state.js';

const TOKEN = 'android-test-token-with-at-least-24-characters';
const DEVICE_ID = 'device-test-1';

function connectAgent(port) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/android`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const queued = [];
    const waiters = [];
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      const index = waiters.findIndex((waiter) => waiter.predicate(message));
      if (index >= 0) {
        const [waiter] = waiters.splice(index, 1);
        waiter.resolve(message);
      } else {
        queued.push(message);
      }
    });
    socket.once('open', () => {
      resolve({
        socket,
        waitFor(predicate) {
          const index = queued.findIndex(predicate);
          if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]);
          return new Promise((waitResolve, waitReject) => {
            const timer = setTimeout(() => {
              const waiterIndex = waiters.findIndex(
                (waiter) => waiter.resolve === waitResolve,
              );
              if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
              waitReject(new Error('Timed out waiting for Agent message'));
            }, 2_000);
            waiters.push({
              predicate,
              resolve(message) {
                clearTimeout(timer);
                waitResolve(message);
              },
            });
          });
        },
      });
    });
    socket.once('error', reject);
  });
}

function envelope(type, fields = {}) {
  return {
    type,
    protocol: 'feagle.android.v1',
    deviceId: DEVICE_ID,
    ...fields,
  };
}

test('Android transport authenticates, deduplicates, ACKs, and sends replies', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'feagle-android-client-'));
  const idMap = new IdMap(join(directory, 'mapping.sqlite'));
  const state = new RuntimeState();
  const forwarded = [];
  const client = new AndroidWechatClient({
    state,
    idMap,
    isSleeping: () => false,
    messageGuard: new MessageGuard(),
    onPrivateText: async (message) => forwarded.push(message),
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
  });
  await client.start();
  t.after(() => {
    client.shutdown();
    idMap.close();
  });

  const agent = await connectAgent(client.server.address().port);
  t.after(() => agent.socket.close());
  agent.socket.send(JSON.stringify(envelope('hello', {
    hookConnected: true,
    wechatVersion: 'test',
  })));
  await agent.waitFor((message) => message.type === 'hello_ack');
  assert.equal(client.loggedIn, true);
  assert.ok(client.selfId);

  const incoming = envelope('private_text', {
    eventId: 'wxsvr:10001',
    talker: 'notify:0123456789abcdef0123456789abcdef',
    displayName: 'Test contact',
    content: 'hello',
    createTime: Date.now(),
    msgId: 10,
    msgSvrId: 10001,
  });
  agent.socket.send(JSON.stringify(incoming));
  assert.equal(
    (await agent.waitFor((message) => message.type === 'event_ack')).eventId,
    incoming.eventId,
  );
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].nickname, 'Test contact');

  agent.socket.send(JSON.stringify(incoming));
  await agent.waitFor((message) => message.type === 'event_ack');
  assert.equal(forwarded.length, 1);

  const userId = forwarded[0].userId;
  const reply = client.sendText(userId, 'reply');
  const command = await agent.waitFor((message) => message.type === 'send_text');
  assert.equal(command.talker, incoming.talker);
  assert.equal(command.content, 'reply');
  agent.socket.send(JSON.stringify(envelope('command_result', {
    commandId: command.commandId,
    ok: true,
    error: '',
  })));
  assert.equal((await reply).MsgID, command.commandId);
});

test('Android transport NACKs failed forwarding and accepts the retry', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'feagle-android-retry-'));
  const idMap = new IdMap(join(directory, 'mapping.sqlite'));
  let attempts = 0;
  const client = new AndroidWechatClient({
    state: new RuntimeState(),
    idMap,
    isSleeping: () => false,
    messageGuard: new MessageGuard(),
    onPrivateText: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary');
    },
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
  });
  await client.start();
  t.after(() => {
    client.shutdown();
    idMap.close();
  });

  const agent = await connectAgent(client.server.address().port);
  t.after(() => agent.socket.close());
  agent.socket.send(JSON.stringify(envelope('hello', { hookConnected: true })));
  await agent.waitFor((message) => message.type === 'hello_ack');
  const incoming = envelope('private_text', {
    eventId: 'wxsvr:retry',
    talker: 'wxid_retry_contact',
    content: 'retry me',
    createTime: Date.now(),
  });

  agent.socket.send(JSON.stringify(incoming));
  await agent.waitFor((message) => message.type === 'event_nack');
  agent.socket.send(JSON.stringify(incoming));
  await agent.waitFor((message) => message.type === 'event_ack');
  assert.equal(attempts, 2);
});
