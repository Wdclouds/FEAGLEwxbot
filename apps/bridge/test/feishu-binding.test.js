import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeState } from '../src/state.js';
import {
  FeishuBindingClient,
  loadFeishuBinding,
  parseBindingMessage,
  saveFeishuBinding,
} from '../src/feishu-binding.js';

function bindingEvent({
  openId = 'ou_123abc',
  text = '绑定',
  messageId = 'om_1',
  chatType = 'p2p',
} = {}) {
  return {
    sender: {
      sender_id: { open_id: openId },
    },
    message: {
      chat_type: chatType,
      message_type: 'text',
      message_id: messageId,
      content: JSON.stringify({ text }),
    },
  };
}

test('accepts only an explicit private binding message', () => {
  assert.deepEqual(parseBindingMessage(bindingEvent()), {
    openId: 'ou_123abc',
    messageId: 'om_1',
  });
  assert.equal(parseBindingMessage(bindingEvent({ text: 'hello' })), null);
  assert.equal(parseBindingMessage(bindingEvent({ chatType: 'group' })), null);
});

test('persists and reloads only the Feishu open_id binding', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'feishu-binding-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'binding.json');

  const saved = saveFeishuBinding('ou_123abc', {
    path,
    now: () => 1_000,
  });
  assert.deepEqual(loadFeishuBinding(path), saved);
  assert.equal(saved.receiveIdType, 'open_id');
  assert.equal(saved.receiveId, 'ou_123abc');
  if (process.platform !== 'win32') {
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
});

test('binds the first private user and refuses a different replacement', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'feishu-binding-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'binding.json');
  const state = new RuntimeState();
  const sent = [];
  const notifier = {
    enabled: false,
    setRecipient(type, id) {
      this.enabled = true;
      this.type = type;
      this.id = id;
    },
    enqueue(type, task) {
      sent.push(type);
      return Promise.resolve().then(task);
    },
    async sendText(text) {
      sent.push(text);
    },
  };
  const binding = new FeishuBindingClient({
    state,
    notifier,
    appId: 'cli_test',
    appSecret: 'secret_test',
    bindingPath: path,
    now: () => 2_000,
  });

  assert.equal(binding.handleMessage(bindingEvent()), true);
  await Promise.resolve();
  assert.equal(notifier.type, 'open_id');
  assert.equal(notifier.id, 'ou_123abc');
  assert.equal(loadFeishuBinding(path).receiveId, 'ou_123abc');
  assert.equal(state.notifications.bindingStatus, 'BOUND');
  assert.ok(sent.includes('BOUND'));

  assert.equal(binding.handleMessage(bindingEvent({
    openId: 'ou_other',
    messageId: 'om_2',
  })), true);
  assert.equal(loadFeishuBinding(path).receiveId, 'ou_123abc');
  assert.match(state.errors[0].message, /different Feishu user/);
});

test('starts and closes the official long-connection lifecycle', async () => {
  const state = new RuntimeState();
  const notifier = { enabled: false };
  let handlers;
  let closed = false;
  let connectionOptions;
  const fakeWs = {
    start() {
      connectionOptions.onReady();
      return Promise.resolve();
    },
    close() {
      closed = true;
    },
  };
  const client = new FeishuBindingClient({
    state,
    notifier,
    appId: 'cli_test',
    appSecret: 'secret_test',
    wsClientFactory(options) {
      connectionOptions = options;
      return fakeWs;
    },
    eventDispatcherFactory() {
      return {
        register(events) {
          handlers = events;
          return this;
        },
      };
    },
  });

  client.start();
  await client.startPromise;
  assert.equal(state.notifications.connection, 'CONNECTED');
  assert.equal(state.notifications.status, 'WAITING_BIND');
  assert.equal(typeof handlers['im.message.receive_v1'], 'function');
  client.stop();
  assert.equal(closed, true);
});
