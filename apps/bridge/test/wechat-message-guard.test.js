import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeState } from '../src/state.js';
import { MessageGuard } from '../src/message-guard.js';
import { WechatClient } from '../src/wechat-client.js';

function fixture({ onPrivateText, guardOptions = {} }) {
  const state = new RuntimeState();
  const messageGuard = new MessageGuard({
    maxCodePoints: 20,
    duplicateTtlMs: 60_000,
    perUserLimit: 3,
    perUserWindowMs: 30_000,
    globalLimit: 30,
    globalWindowMs: 60_000,
    ...guardOptions,
  });
  const client = new WechatClient({
    state,
    idMap: { entity: () => 1_000_000_001 },
    isSleeping: () => false,
    messageGuard,
    onPrivateText,
  });
  client.loggedIn = true;
  client.selfId = 1_000_000_000;
  client.bot = {
    user: { UserName: '@self' },
    CONF: { MSGTYPE_TEXT: 1 },
    contacts: {
      '@friend': { NickName: 'Friend' },
    },
  };
  return { state, client };
}

function textMessage(id, text = 'hello') {
  return {
    FromUserName: '@friend',
    MsgType: 1,
    Content: text,
    MsgId: id,
  };
}

test('a forwarding failure rolls back duplicate and rate reservations', async () => {
  let calls = 0;
  const { state, client } = fixture({
    onPrivateText: async () => {
      calls += 1;
      throw new Error('OneBot temporarily unavailable');
    },
  });

  await client.handleMessage(textMessage('same-id'));
  await client.handleMessage(textMessage('same-id'));

  assert.equal(calls, 2);
  assert.equal(state.counters.blocked, 0);
  assert.equal(state.messages[0].status, 'FORWARD-FAILED');
});

test('per-user rate limiting blocks the fourth accepted message', async () => {
  let calls = 0;
  const { state, client } = fixture({
    onPrivateText: async () => {
      calls += 1;
    },
  });

  await client.handleMessage(textMessage('1'));
  await client.handleMessage(textMessage('2'));
  await client.handleMessage(textMessage('3'));
  await client.handleMessage(textMessage('4'));

  assert.equal(calls, 3);
  assert.equal(state.counters.blocked, 1);
  assert.equal(state.messages[0].status, 'USER_RATE_LIMITED');
});
