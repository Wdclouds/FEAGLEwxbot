import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeState } from '../src/state.js';
import { DashboardServer } from '../src/dashboard.js';

test('dashboard test-mode endpoint toggles the schedule override', async (t) => {
  const state = new RuntimeState();
  const dashboard = new DashboardServer({
    state,
    host: '127.0.0.1',
    port: 0,
    setTestMode(enabled) {
      state.setSchedule({ mode: enabled ? 'TEST' : 'SLEEPING', testMode: enabled });
      return state.snapshot();
    },
  });
  await dashboard.start();
  t.after(() => dashboard.stop());

  const { port } = dashboard.server.address();
  const enableResponse = await fetch(`http://127.0.0.1:${port}/api/test-mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(enableResponse.status, 200);
  const enabled = await enableResponse.json();
  assert.equal(enabled.schedule.mode, 'TEST');
  assert.equal(enabled.schedule.testMode, true);

  const disableResponse = await fetch(`http://127.0.0.1:${port}/api/test-mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(disableResponse.status, 200);
  const disabled = await disableResponse.json();
  assert.equal(disabled.schedule.mode, 'SLEEPING');
  assert.equal(disabled.schedule.testMode, false);
});

test('dashboard exposes separate liveness and readiness endpoints', async (t) => {
  const state = new RuntimeState();
  const dashboard = new DashboardServer({
    state,
    host: '127.0.0.1',
    port: 0,
  });
  await dashboard.start();
  t.after(() => dashboard.stop());

  const { port } = dashboard.server.address();
  const live = await fetch(`http://127.0.0.1:${port}/api/health/live`);
  assert.equal(live.status, 200);

  const notReady = await fetch(`http://127.0.0.1:${port}/api/health/ready`);
  assert.equal(notReady.status, 503);

  state.patch('wechat', { status: 'ONLINE', protocolHealth: 'HEALTHY' });
  state.patch('astrbot', { status: 'READY' });
  state.patch('onebot', { status: 'CONNECTED' });
  const ready = await fetch(`http://127.0.0.1:${port}/api/health/ready`);
  assert.equal(ready.status, 200);
});

test('dashboard sends a Feishu notification test through a POST-only endpoint', async (t) => {
  const state = new RuntimeState();
  let calls = 0;
  const dashboard = new DashboardServer({
    state,
    host: '127.0.0.1',
    port: 0,
    async sendNotificationTest() {
      calls += 1;
      state.patch('notifications', {
        status: 'READY',
        lastType: 'TEST',
      });
      return state.snapshot();
    },
  });
  await dashboard.start();
  t.after(() => dashboard.stop());

  const { port } = dashboard.server.address();
  const getResponse = await fetch(`http://127.0.0.1:${port}/api/notifications/test`);
  assert.equal(getResponse.status, 405);

  const response = await fetch(`http://127.0.0.1:${port}/api/notifications/test`, {
    method: 'POST',
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(calls, 1);
  assert.equal(payload.notifications.lastType, 'TEST');
});

test('dashboard force-relogin endpoint requires explicit confirmation', async (t) => {
  const state = new RuntimeState();
  let calls = 0;
  const dashboard = new DashboardServer({
    state,
    host: '127.0.0.1',
    port: 0,
    async forceWechatRelogin() {
      calls += 1;
      state.patch('wechat', {
        status: 'LOGGED_OUT',
        reloginTestStatus: 'RUNNING',
      });
      return state.snapshot();
    },
  });
  await dashboard.start();
  t.after(() => dashboard.stop());

  const { port } = dashboard.server.address();
  const getResponse = await fetch(`http://127.0.0.1:${port}/api/wechat/force-relogin`);
  assert.equal(getResponse.status, 405);

  const rejected = await fetch(`http://127.0.0.1:${port}/api/wechat/force-relogin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: 'no' }),
  });
  assert.equal(rejected.status, 400);
  assert.equal(calls, 0);

  const accepted = await fetch(`http://127.0.0.1:${port}/api/wechat/force-relogin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: 'FORCE_LOGOUT' }),
  });
  assert.equal(accepted.status, 202);
  assert.equal(calls, 1);
  const payload = await accepted.json();
  assert.equal(payload.wechat.reloginTestStatus, 'RUNNING');
});
