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
