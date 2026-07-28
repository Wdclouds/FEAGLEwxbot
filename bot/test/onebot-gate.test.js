import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeState } from '../src/state.js';
import { OneBotClient } from '../src/onebot-client.js';

function client(options = {}) {
  return new OneBotClient({
    state: new RuntimeState(),
    idMap: {},
    wechat: {},
    isSleeping: () => false,
    requestTimeoutMs: 60_000,
    ...options,
  });
}

test('OneBot request gate limits global and per-user in-flight work', () => {
  const onebot = client({ maxInFlight: 2, maxInFlightPerUser: 1 });
  const first = onebot.reserveRequest(1);
  assert.throws(
    () => onebot.reserveRequest(1),
    (error) => error.code === 'UPSTREAM_BUSY',
  );
  const second = onebot.reserveRequest(2);
  assert.throws(
    () => onebot.reserveRequest(3),
    (error) => error.code === 'UPSTREAM_BUSY',
  );
  assert.equal(onebot.state.onebot.inFlight, 2);

  assert.equal(onebot.releaseRequest(first), true);
  assert.equal(onebot.releaseRequest(second), true);
  assert.equal(onebot.state.onebot.inFlight, 0);
});

test('OneBot request gate releases the oldest pending request for a reply', () => {
  const onebot = client({ maxInFlight: 2, maxInFlightPerUser: 2 });
  onebot.reserveRequest(7);
  onebot.reserveRequest(7);
  assert.equal(onebot.releaseOldestForUser(7), true);
  assert.equal(onebot.state.onebot.inFlight, 1);
  onebot.clearPendingRequests();
});

test('OneBot connection waiters resume when the reverse WebSocket opens', async () => {
  const onebot = client({ connectionWaitMs: 1_000 });
  const waiting = onebot.waitForConnection();
  onebot.ws = { readyState: 1 };
  onebot.resolveConnectionWaiters();
  await waiting;
  assert.equal(onebot.connectionWaiters.size, 0);
});

test('OneBot connection waiters fail cleanly when the client stops', async () => {
  const onebot = client({ connectionWaitMs: 1_000 });
  const waiting = onebot.waitForConnection();
  onebot.stop();
  await assert.rejects(waiting, (error) => error.code === 'UPSTREAM_UNAVAILABLE');
  assert.equal(onebot.connectionWaiters.size, 0);
});

test('OneBot emits a standard group message event with an at segment', async () => {
  let storedEvent;
  const sentEvents = [];
  const onebot = client({
    idMap: {
      storeMessage: (_id, event) => {
        storedEvent = event;
        return 88;
      },
      updateMessage: () => {},
    },
    wechat: { selfId: 1_000_000_000 },
  });
  onebot.ws = { readyState: 1 };
  onebot.sendEvent = (event) => sentEvents.push(event);

  await onebot.sendGroupText({
    groupId: 1_000_000_101,
    groupName: 'Test Group',
    userId: 1_000_000_102,
    nickname: 'Alice',
    text: 'hello',
    wechatMessageId: 'wx-group-1',
  });

  assert.equal(storedEvent.message_type, 'group');
  assert.equal(sentEvents[0].group_id, 1_000_000_101);
  assert.deepEqual(sentEvents[0].message[0], {
    type: 'at',
    data: { qq: '1000000000' },
  });
  assert.equal(sentEvents[0].message_id, 88);
  onebot.clearPendingRequests();
});

test('OneBot send_group_msg releases the pending group request and calls WeChat', async () => {
  const calls = [];
  const responses = [];
  const onebot = client({
    wechat: {
      async sendGroupText(groupId, text) {
        calls.push({ groupId, text });
        return { MsgID: '99' };
      },
    },
  });
  onebot.ws = {
    readyState: 1,
    send: (payload) => responses.push(JSON.parse(payload)),
  };
  onebot.reserveRequest('group:1000000101');

  await onebot.handleAction(Buffer.from(JSON.stringify({
    action: 'send_group_msg',
    params: {
      group_id: 1_000_000_101,
      message: [{ type: 'text', data: { text: 'reply' } }],
    },
    echo: 'group-reply',
  })));

  assert.deepEqual(calls, [{ groupId: 1_000_000_101, text: 'reply' }]);
  assert.equal(onebot.state.onebot.inFlight, 0);
  assert.equal(responses[0].status, 'ok');
});
