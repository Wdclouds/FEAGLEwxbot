import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RuntimeState } from '../src/state.js';
import { WechatClient } from '../src/wechat-client.js';

function createClient(options = {}) {
  const state = new RuntimeState();
  const client = new WechatClient({
    state,
    idMap: {},
    isSleeping: () => false,
    onPrivateText: async () => {},
    ...options,
  });
  return { state, client };
}

function installReplacementFactory(client, now, restartError = null) {
  client.createBot = (session) => {
    const replacement = new EventEmitter();
    replacement.botData = session;
    replacement.destroyLocal = () => {};
    replacement.restart = async () => {
      if (restartError) throw restartError;
      client.loggedIn = true;
      client.selfId = 1;
      client.loginStartedAt = now;
      client.lastValidatedSyncTime = now;
      replacement.emit('protocol-sync', { at: now, selector: 0 });
    };
    client.bot = replacement;
    client.sessionUsable = true;
  };
}

test('wechat protocol health reports a recent strictly validated sync', async () => {
  const now = Date.parse('2026-07-28T02:00:00Z');
  const { state, client } = createClient({ now: () => now });
  client.loggedIn = true;
  client.watchSession = true;
  client.bot = {};
  client.lastValidatedSyncTime = now - 5_000;

  await client.inspectProtocolHealth();

  assert.equal(state.wechat.protocolHealth, 'HEALTHY');
  assert.equal(state.wechat.syncAgeMs, 5_000);
  assert.equal(state.wechat.recoveryAttempts, 0);
});

test('wechat protocol watchdog performs a local session-preserving recovery', async () => {
  const now = Date.parse('2026-07-28T02:00:00Z');
  const { state, client } = createClient({
    now: () => now,
    startupGraceMs: 10_000,
    degradedAfterMs: 30_000,
    recoverAfterMs: 60_000,
    recoveryTimeoutMs: 1_000,
  });
  client.loggedIn = true;
  client.watchSession = true;
  client.sessionUsable = true;
  client.lastValidatedSyncTime = now - 120_000;
  client.bot = {
    botData: { uin: 'session' },
    destroyLocal() {},
  };
  installReplacementFactory(client, now);

  await client.inspectProtocolHealth();

  assert.equal(state.wechat.status, 'ONLINE');
  assert.equal(state.wechat.protocolHealth, 'HEALTHY');
  assert.equal(state.wechat.recoveryAttempts, 1);
});

test('fatal callback only runs after recovery exhaustion and the fatal window', async () => {
  const now = Date.parse('2026-07-28T02:00:00Z');
  let fatalCalls = 0;
  const restartError = new Error('protocol implementation failed');
  const { state, client } = createClient({
    now: () => now,
    startupGraceMs: 10_000,
    degradedAfterMs: 30_000,
    recoverAfterMs: 60_000,
    recoveryTimeoutMs: 1_000,
    maxRecoveryFailures: 1,
    fatalAfterMs: 1,
    onFatal: () => {
      fatalCalls += 1;
    },
  });
  client.loggedIn = true;
  client.watchSession = true;
  client.sessionUsable = true;
  client.lastValidatedSyncTime = now - 120_000;
  client.recoveryWindowStartedAt = now - 2_000;
  client.bot = {
    botData: { uin: 'session' },
    destroyLocal() {},
  };
  installReplacementFactory(client, now, restartError);

  await client.inspectProtocolHealth();

  assert.equal(fatalCalls, 1);
  assert.equal(state.wechat.protocolHealth, 'FAILED');
  assert.equal(state.wechat.status, 'ERROR');
});

test('a late successful sync restores the active login flags after recovery timeout', () => {
  const now = Date.parse('2026-07-28T02:00:00Z');
  const state = new RuntimeState();
  const client = new WechatClient({
    state,
    idMap: { entity: () => 1_000_000_001 },
    isSleeping: () => false,
    onPrivateText: async () => {},
    now: () => now,
  });
  const bot = new EventEmitter();
  bot.user = { UserName: '@self', NickName: 'Bot' };
  bot.PROP = { uin: '1' };
  bot.botData = { uin: '1' };
  client.bot = bot;
  client.saveSession = () => {};
  client.bindEvents();
  client.loggedIn = false;
  client.watchSession = true;

  bot.emit('protocol-sync', { at: now, selector: 0 });

  assert.equal(client.loggedIn, true);
  assert.equal(client.selfId, 1_000_000_001);
  assert.equal(state.wechat.protocolHealth, 'HEALTHY');
});

test('an empty or obsolete session file does not arm the watchdog during QR login', () => {
  const { client } = createClient();
  client.createBot({});

  assert.equal(client.watchSession, false);
  assert.equal(client.sessionUsable, false);
});

test('force relogin logs out, clears the saved session, and starts a fresh login', async () => {
  const now = Date.parse('2026-07-28T03:00:00Z');
  const { state, client } = createClient({ now: () => now });
  let logoutCalls = 0;
  let destroyCalls = 0;
  let clearCalls = 0;
  let freshLoginCalls = 0;
  const originalBot = {
    async logout() {
      logoutCalls += 1;
    },
    destroyLocal() {
      destroyCalls += 1;
    },
  };
  client.bot = originalBot;
  client.loggedIn = true;
  client.watchSession = true;
  client.sessionUsable = true;
  client.selfId = 1_000_000_001;
  client.clearSession = () => {
    clearCalls += 1;
  };
  client.createBot = () => {
    client.bot = {};
  };
  client.startFreshLogin = async () => {
    freshLoginCalls += 1;
  };
  state.patch('wechat', { status: 'ONLINE', protocolHealth: 'HEALTHY' });

  const snapshot = await client.forceReloginTest();

  assert.equal(logoutCalls, 1);
  assert.equal(destroyCalls, 1);
  assert.equal(clearCalls, 1);
  assert.equal(freshLoginCalls, 1);
  assert.equal(snapshot.wechat.status, 'LOGGED_OUT');
  assert.equal(snapshot.wechat.reloginTestStatus, 'RUNNING');
  assert.equal(client.loggedIn, false);
  assert.equal(client.sessionUsable, false);
});

test('a healthy protocol sync completes a running relogin test once', async () => {
  const now = Date.parse('2026-07-28T03:00:00Z');
  const outcomes = [];
  const state = new RuntimeState();
  const client = new WechatClient({
    state,
    idMap: { entity: () => 1_000_000_001 },
    isSleeping: () => false,
    onPrivateText: async () => {},
    onReloginOutcome: (outcome) => outcomes.push(outcome),
    now: () => now,
  });
  const bot = new EventEmitter();
  bot.user = { UserName: '@self', NickName: 'Bot' };
  bot.PROP = { uin: '1' };
  bot.botData = { uin: '1' };
  client.bot = bot;
  client.saveSession = () => {};
  client.bindEvents();
  client.manualReloginInFlight = true;
  state.patch('wechat', { reloginTestStatus: 'RUNNING' });

  bot.emit('protocol-sync', { at: now, selector: 0 });
  await Promise.resolve();
  bot.emit('protocol-sync', { at: now, selector: 0 });

  assert.equal(state.wechat.reloginTestStatus, 'SUCCESS');
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].success, true);
  assert.equal(outcomes[0].account, 'Bot');
});

test('contact refresh errors are deduplicated without degrading protocol health', () => {
  const now = Date.parse('2026-07-28T03:00:00Z');
  const state = new RuntimeState();
  const client = new WechatClient({
    state,
    idMap: { entity: () => 1_000_000_001 },
    isSleeping: () => false,
    onPrivateText: async () => {},
    now: () => now,
  });
  const bot = new EventEmitter();
  client.bot = bot;
  client.bindEvents();
  client.loggedIn = true;
  state.patch('wechat', { status: 'ONLINE', protocolHealth: 'HEALTHY' });
  const error = new Error('');
  error.tips = '批量获取联系人失败';

  bot.emit('error', error);
  bot.emit('error', error);

  assert.equal(state.wechat.status, 'ONLINE');
  assert.equal(state.wechat.protocolHealth, 'HEALTHY');
  assert.equal(state.errors.length, 1);
  assert.equal(state.errors[0].source, 'wechat-contact');
});

test('a single managed sync error is left to the watchdog instead of degrading immediately', () => {
  const state = new RuntimeState();
  const client = new WechatClient({
    state,
    idMap: { entity: () => 1_000_000_001 },
    isSleeping: () => false,
    onPrivateText: async () => {},
  });
  const bot = new EventEmitter();
  client.bot = bot;
  client.bindEvents();
  client.loggedIn = true;
  state.patch('wechat', { status: 'ONLINE', protocolHealth: 'HEALTHY' });
  const error = new Error('');
  error.managedProtocolError = true;

  bot.emit('error', error);

  assert.equal(state.wechat.status, 'ONLINE');
  assert.equal(state.wechat.protocolHealth, 'HEALTHY');
  assert.equal(state.errors.length, 0);
});
