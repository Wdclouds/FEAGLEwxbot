import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeState } from '../src/state.js';
import { FeishuNotifier, decodeImageDataUrl } from '../src/feishu-notifier.js';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function configuredNotifier({ state, fetchImpl, now = () => Date.now() }) {
  return new FeishuNotifier({
    state,
    appId: 'cli_test',
    appSecret: 'secret_test',
    receiveId: 'owner@example.com',
    receiveIdType: 'email',
    fetchImpl,
    now,
  });
}

test('decodes a base64 QR image data URL', () => {
  const image = decodeImageDataUrl('data:image/png;base64,aGVsbG8=');
  assert.equal(image.mimeType, 'image/png');
  assert.equal(image.bytes.toString('utf8'), 'hello');
});

test('sends a private Feishu test message with a cached tenant token', async () => {
  const state = new RuntimeState();
  state.patch('wechat', { status: 'ONLINE', protocolHealth: 'HEALTHY' });
  state.patch('astrbot', { status: 'READY' });
  state.patch('onebot', { status: 'CONNECTED' });
  const calls = [];
  const notifier = configuredNotifier({
    state,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).includes('/tenant_access_token/internal')) {
        return jsonResponse({
          code: 0,
          tenant_access_token: 't-test',
          expire: 7_200,
        });
      }
      return jsonResponse({ code: 0, data: { message_id: 'om_test' } });
    },
  });
  notifier.start();

  const snapshot = await notifier.sendTest();
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /receive_id_type=email/);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer t-test');
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.receive_id, 'owner@example.com');
  assert.equal(body.msg_type, 'text');
  assert.match(JSON.parse(body.content).text, /通知测试成功/);
  assert.equal(snapshot.notifications.lastType, 'TEST');
  assert.equal(snapshot.notifications.status, 'READY');
  notifier.stop();
});

test('uploads and sends a fresh login QR through Feishu', async () => {
  const state = new RuntimeState();
  const calls = [];
  const notifier = configuredNotifier({
    state,
    now: () => 1_000,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).includes('/tenant_access_token/internal')) {
        return jsonResponse({
          code: 0,
          tenant_access_token: 't-test',
          expire: 7_200,
        });
      }
      if (String(url).endsWith('/im/v1/images')) {
        return jsonResponse({ code: 0, data: { image_key: 'img_test' } });
      }
      return jsonResponse({ code: 0, data: { message_id: 'om_test' } });
    },
  });
  notifier.start();

  state.patch('wechat', {
    status: 'WAITING_SCAN',
    protocolHealth: 'OFFLINE',
    qrCreatedAt: '2026-07-28T00:00:00.000Z',
    qrDataUrl: 'data:image/png;base64,aGVsbG8=',
  });
  await notifier.queue;

  assert.equal(calls.length, 4);
  assert.equal(JSON.parse(calls[1].options.body).msg_type, 'text');
  assert.ok(calls[2].options.body instanceof FormData);
  const imageMessage = JSON.parse(calls[3].options.body);
  assert.equal(imageMessage.msg_type, 'image');
  assert.deepEqual(JSON.parse(imageMessage.content), { image_key: 'img_test' });
  assert.equal(state.notifications.lastType, 'LOGIN_QR');
  notifier.stop();
});

test('sends one alert and one recovery message for a protocol incident', async () => {
  const state = new RuntimeState();
  state.patch('wechat', { status: 'ONLINE', protocolHealth: 'HEALTHY' });
  const calls = [];
  const notifier = configuredNotifier({
    state,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).includes('/tenant_access_token/internal')) {
        return jsonResponse({
          code: 0,
          tenant_access_token: 't-test',
          expire: 7_200,
        });
      }
      return jsonResponse({ code: 0, data: { message_id: 'om_test' } });
    },
  });
  notifier.start();

  state.patch('wechat', { status: 'DEGRADED', protocolHealth: 'STALE' });
  await notifier.queue;
  state.patch('wechat', { status: 'ONLINE', protocolHealth: 'HEALTHY' });
  await notifier.queue;

  assert.equal(calls.length, 3);
  const alert = JSON.parse(JSON.parse(calls[1].options.body).content).text;
  const recovered = JSON.parse(JSON.parse(calls[2].options.body).content).text;
  assert.match(alert, /连接异常/);
  assert.match(recovered, /连接已恢复/);
  assert.equal(state.notifications.lastType, 'RECOVERED');
  notifier.stop();
});

test('reports disabled when Feishu configuration is incomplete', async () => {
  const state = new RuntimeState();
  const notifier = new FeishuNotifier({
    state,
    appId: '',
    appSecret: '',
    receiveId: '',
  });
  notifier.start();
  assert.equal(state.notifications.status, 'DISABLED');
  await assert.rejects(() => notifier.sendTest(), /configuration is incomplete/);
});

test('manual relogin sends a dedicated success result without a duplicate recovery', async () => {
  const state = new RuntimeState();
  state.patch('wechat', { status: 'ONLINE', protocolHealth: 'HEALTHY' });
  const calls = [];
  const notifier = configuredNotifier({
    state,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).includes('/tenant_access_token/internal')) {
        return jsonResponse({
          code: 0,
          tenant_access_token: 't-test',
          expire: 7_200,
        });
      }
      return jsonResponse({ code: 0, data: { message_id: 'om_test' } });
    },
  });
  notifier.start();
  notifier.beginReloginTest();

  state.patch('wechat', { status: 'LOGGED_OUT', protocolHealth: 'FAILED' });
  state.patch('wechat', { status: 'ONLINE', protocolHealth: 'HEALTHY' });
  await notifier.finishReloginTest({ success: true, account: 'Bot' });

  assert.equal(calls.length, 2);
  const message = JSON.parse(JSON.parse(calls[1].options.body).content).text;
  assert.match(message, /强制重登录测试成功/);
  assert.equal(state.notifications.lastType, 'LOGIN_SUCCESS');
  notifier.stop();
});

test('manual relogin reports a failed login attempt', async () => {
  const state = new RuntimeState();
  const calls = [];
  const notifier = configuredNotifier({
    state,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).includes('/tenant_access_token/internal')) {
        return jsonResponse({
          code: 0,
          tenant_access_token: 't-test',
          expire: 7_200,
        });
      }
      return jsonResponse({ code: 0, data: { message_id: 'om_test' } });
    },
  });
  notifier.start();
  notifier.beginReloginTest();

  await notifier.finishReloginTest({ success: false, detail: '二维码已过期' });

  assert.equal(calls.length, 2);
  const message = JSON.parse(JSON.parse(calls[1].options.body).content).text;
  assert.match(message, /强制重登录测试失败/);
  assert.match(message, /二维码已过期/);
  assert.equal(state.notifications.lastType, 'LOGIN_FAILED');
  notifier.stop();
});

test('manual offline suppresses alerts and repeated login QR notifications', async () => {
  const state = new RuntimeState();
  const calls = [];
  const notifier = configuredNotifier({
    state,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).includes('/tenant_access_token/internal')) {
        return jsonResponse({
          code: 0,
          tenant_access_token: 't-test',
          expire: 7_200,
        });
      }
      return jsonResponse({ code: 0, data: { message_id: 'om_test' } });
    },
  });
  notifier.start();

  state.patch('wechat', {
    adminMode: 'MANUAL_OFFLINE',
    status: 'MANUAL_OFFLINE',
    protocolHealth: 'OFFLINE',
    qrCreatedAt: '2026-07-28T00:00:00.000Z',
    qrDataUrl: 'data:image/png;base64,aGVsbG8=',
  });
  await notifier.queue;

  assert.equal(calls.length, 0);
  assert.equal(notifier.incidentActive, false);
  assert.equal(notifier.qrNotificationSentForIncident, false);
  notifier.stop();
});

test('one login incident sends only one QR even when Wechat4u refreshes it', async () => {
  const state = new RuntimeState();
  const calls = [];
  let now = 1_000;
  const notifier = configuredNotifier({
    state,
    now: () => now,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).includes('/tenant_access_token/internal')) {
        return jsonResponse({
          code: 0,
          tenant_access_token: 't-test',
          expire: 7_200,
        });
      }
      if (String(url).endsWith('/im/v1/images')) {
        return jsonResponse({ code: 0, data: { image_key: 'img_test' } });
      }
      return jsonResponse({ code: 0, data: { message_id: 'om_test' } });
    },
  });
  notifier.start();

  state.patch('wechat', {
    status: 'WAITING_SCAN',
    protocolHealth: 'OFFLINE',
    qrCreatedAt: '2026-07-28T00:00:00.000Z',
    qrDataUrl: 'data:image/png;base64,aGVsbG8=',
  });
  await notifier.queue;
  now += 20 * 60_000;
  state.patch('wechat', {
    qrCreatedAt: '2026-07-28T00:20:00.000Z',
    qrDataUrl: 'data:image/png;base64,d29ybGQ=',
  });
  await notifier.queue;

  assert.equal(calls.length, 4);
  assert.equal(state.notifications.lastType, 'LOGIN_QR');
  notifier.stop();
});
