import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MessageGuard,
  MESSAGE_GUARD_STATUS,
  countCodePoints,
} from '../src/message-guard.js';

function testGuard(options = {}) {
  let timestamp = 0;
  const guard = new MessageGuard({
    maxCodePoints: 100,
    duplicateTtlMs: 1_000,
    perUserLimit: 100,
    perUserWindowMs: 1_000,
    globalLimit: 100,
    globalWindowMs: 1_000,
    clock: () => timestamp,
    ...options,
  });
  return {
    guard,
    setTime(value) {
      timestamp = value;
    },
  };
}

test('counts Unicode code points instead of UTF-16 code units', () => {
  assert.equal(countCodePoints('A😀𠮷'), 3);
  const { guard } = testGuard({ maxCodePoints: 2 });

  const accepted = guard.check({ userId: 1, msgId: 'one', text: '😀a' });
  assert.deepEqual(accepted, {
    allowed: true,
    verdict: 'ALLOW',
    status: MESSAGE_GUARD_STATUS.ALLOWED,
    retryAfterMs: 0,
    userId: '1',
    msgId: 'one',
    codePointLength: 2,
  });

  const rejected = guard.check({ userId: 1, msgId: 'two', text: '😀ab' });
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.verdict, 'DROP');
  assert.equal(rejected.status, MESSAGE_GUARD_STATUS.TOO_LONG);
  assert.equal(rejected.retryAfterMs, null);
  assert.equal(rejected.codePointLength, 3);
  assert.equal(rejected.maxCodePoints, 2);
});

test('rejects duplicate message IDs until their TTL expires', () => {
  const { guard, setTime } = testGuard({ duplicateTtlMs: 100 });

  assert.equal(
    guard.check({ userId: 'u1', msgId: 'm1', text: 'first' }).status,
    MESSAGE_GUARD_STATUS.ALLOWED,
  );
  setTime(40);
  const duplicate = guard.check({ userId: 'u2', msgId: 'm1', text: 'again' });
  assert.equal(duplicate.status, MESSAGE_GUARD_STATUS.DUPLICATE);
  assert.equal(duplicate.retryAfterMs, 60);

  setTime(100);
  assert.equal(
    guard.check({ userId: 'u2', msgId: 'm1', text: 'after ttl' }).status,
    MESSAGE_GUARD_STATUS.ALLOWED,
  );
});

test('applies a per-user sliding-window limit without penalizing other users', () => {
  const { guard, setTime } = testGuard({
    perUserLimit: 2,
    perUserWindowMs: 1_000,
  });

  assert.equal(guard.check({ userId: 'a', msgId: '1', text: 'a' }).allowed, true);
  setTime(100);
  assert.equal(guard.check({ userId: 'a', msgId: '2', text: 'b' }).allowed, true);
  setTime(200);
  const limited = guard.check({ userId: 'a', msgId: '3', text: 'c' });
  assert.equal(limited.status, MESSAGE_GUARD_STATUS.USER_RATE_LIMITED);
  assert.equal(limited.scope, 'user');
  assert.equal(limited.retryAfterMs, 800);
  assert.equal(guard.check({ userId: 'b', msgId: '4', text: 'd' }).allowed, true);

  setTime(1_000);
  assert.equal(guard.check({ userId: 'a', msgId: '5', text: 'e' }).allowed, true);
});

test('applies a global sliding-window limit across users', () => {
  const { guard, setTime } = testGuard({
    globalLimit: 2,
    globalWindowMs: 1_000,
  });

  assert.equal(guard.check({ userId: 'a', msgId: '1', text: 'a' }).allowed, true);
  setTime(100);
  assert.equal(guard.check({ userId: 'b', msgId: '2', text: 'b' }).allowed, true);
  setTime(250);
  const limited = guard.check({ userId: 'c', msgId: '3', text: 'c' });
  assert.equal(limited.status, MESSAGE_GUARD_STATUS.GLOBAL_RATE_LIMITED);
  assert.equal(limited.scope, 'global');
  assert.equal(limited.retryAfterMs, 750);

  setTime(1_000);
  assert.equal(guard.check({ userId: 'c', msgId: '3', text: 'c' }).allowed, true);
});

test('supports allow and block user ID sets with block taking precedence', () => {
  const { guard } = testGuard({
    allowUserIds: new Set([10, 20]),
    blockUserIds: new Set([20]),
  });

  assert.equal(
    guard.check({ userId: 10, msgId: 'a', text: 'ok' }).status,
    MESSAGE_GUARD_STATUS.ALLOWED,
  );
  assert.equal(
    guard.check({ userId: 20, msgId: 'b', text: 'blocked' }).status,
    MESSAGE_GUARD_STATUS.BLOCKED_USER,
  );
  assert.equal(
    guard.check({ userId: 30, msgId: 'c', text: 'not listed' }).status,
    MESSAGE_GUARD_STATUS.NOT_ALLOWLISTED,
  );
});

test('rejected messages do not consume rate slots or duplicate IDs', () => {
  const { guard, setTime } = testGuard({
    maxCodePoints: 3,
    globalLimit: 1,
    globalWindowMs: 100,
  });

  assert.equal(
    guard.check({ userId: 'a', msgId: 'too-long', text: 'four' }).status,
    MESSAGE_GUARD_STATUS.TOO_LONG,
  );
  assert.equal(
    guard.check({ userId: 'a', msgId: 'too-long', text: 'ok' }).status,
    MESSAGE_GUARD_STATUS.ALLOWED,
  );

  assert.equal(
    guard.check({ userId: 'b', msgId: 'retry-me', text: 'ok' }).status,
    MESSAGE_GUARD_STATUS.GLOBAL_RATE_LIMITED,
  );
  setTime(100);
  assert.equal(
    guard.check({ userId: 'b', msgId: 'retry-me', text: 'ok' }).status,
    MESSAGE_GUARD_STATUS.ALLOWED,
  );
});

test('accepts Wechat4u and bridge field aliases', () => {
  const { guard } = testGuard();
  const fromWechat = guard.check({
    FromUserName: '@alice',
    MsgId: 'wx-1',
    Content: 'hello',
  });
  assert.equal(fromWechat.userId, '@alice');
  assert.equal(fromWechat.msgId, 'wx-1');

  const fromBridge = guard.check({
    userId: 42,
    wechatMessageId: 'wx-2',
    text: 'hello',
  });
  assert.equal(fromBridge.userId, '42');
  assert.equal(fromBridge.msgId, 'wx-2');
});

test('rolls back a reservation when forwarding fails', () => {
  const { guard } = testGuard({
    perUserLimit: 1,
    globalLimit: 1,
  });
  const reserved = guard.check({ userId: 'a', msgId: 'retry', text: 'hello' });
  assert.equal(reserved.allowed, true);
  assert.equal(guard.rollback(reserved), true);
  assert.equal(guard.rollback(reserved), false);

  const retried = guard.check({ userId: 'a', msgId: 'retry', text: 'hello' });
  assert.equal(retried.allowed, true);
});
