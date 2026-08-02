import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ManagedWechat,
  SessionInvalidError,
  isSessionInvalidError,
  isTransientWechatError,
  parseSyncCheckResponse,
} from '../src/managed-wechat.js';

test('strictly parses a valid synccheck response', () => {
  assert.equal(
    parseSyncCheckResponse('window.synccheck={retcode:"0",selector:"2"}'),
    2,
  );
});

test('does not treat malformed synccheck content as healthy', () => {
  assert.throws(
    () => parseSyncCheckResponse('<html>rate limited</html>'),
    (error) => error.code === 'WECHAT_SYNC_PARSE',
  );
});

test('normalizes string retcode 1101 into a session-invalid error', () => {
  assert.throws(
    () => parseSyncCheckResponse('window.synccheck={retcode:"1101",selector:"0"}'),
    SessionInvalidError,
  );
  assert.equal(isSessionInvalidError({ response: { data: { BaseResponse: { Ret: '1101' } } } }), true);
});

test('classifies network, throttling, and server failures as transient', () => {
  assert.equal(isTransientWechatError({ code: 'ETIMEDOUT' }), true);
  assert.equal(isTransientWechatError({ response: { status: 429 } }), true);
  assert.equal(isTransientWechatError({ response: { status: 503 } }), true);
  assert.equal(isTransientWechatError({ response: { status: 403 } }), false);
});

test('fresh login treats an undefined login() result as a successful confirmation', async () => {
  const bot = new ManagedWechat();
  let initialized = false;
  bot.getUUID = async () => 'uuid';
  bot.checkLogin = async () => ({ code: 200 });
  bot.login = async () => undefined;
  bot._init = async () => {
    initialized = true;
  };

  assert.equal(await bot.start(), true);
  assert.equal(initialized, true);
});

test('fresh login expires an old QR instead of polling it forever', async () => {
  const bot = new ManagedWechat();
  bot.loginTimeoutMs = 0;
  bot.getUUID = async () => 'uuid';
  bot.checkLogin = async () => ({ code: 408 });

  await assert.rejects(
    bot.start(),
    (error) => error.code === 'WECHAT_QR_EXPIRED',
  );
});

test('a destroyed instance cannot finish init and restart polling', async () => {
  const bot = new ManagedWechat();
  let resolveInit;
  let syncStarts = 0;
  bot.init = () => new Promise((resolve) => {
    resolveInit = resolve;
  });
  bot.syncPolling = () => {
    syncStarts += 1;
  };

  const initialization = bot._init();
  bot.destroyLocal();
  resolveInit({ ContactList: [] });

  await assert.rejects(
    initialization,
    (error) => error.code === 'WECHAT_INSTANCE_DESTROYED',
  );
  assert.equal(syncStarts, 0);
});
