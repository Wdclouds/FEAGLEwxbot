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
const DEVICE_ID = 'device-contacts-test';

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
        waitFor(predicate, timeoutMs = 2_000) {
          const index = queued.findIndex(predicate);
          if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]);
          return new Promise((waitResolve, waitReject) => {
            const timer = setTimeout(() => {
              const waiterIndex = waiters.findIndex(
                (waiter) => waiter.resolve === waitResolve,
              );
              if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
              waitReject(new Error('Timed out waiting for Agent message'));
            }, timeoutMs);
            waiters.push({
              predicate,
              resolve(message) {
                clearTimeout(timer);
                waitResolve(message);
              },
            });
          });
        },
        received: () => queued.slice(),
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

function groupEntry(talker, name = '群', memberCount = 0) {
  return { talker, name, avatarBase64: '', memberCount };
}

function privateEntry(talker, name = '联系人') {
  return { talker, name, avatarBase64: '' };
}

function snapshot({
  groups = [],
  privateContacts = [],
  full = true,
  generatedAt = new Date().toISOString(),
} = {}) {
  return { generatedAt, groups, privateContacts, full };
}

async function waitForCondition(condition, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitForCondition timed out');
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function makeClient(directory, options = {}) {
  const idMap = new IdMap(join(directory, 'mapping.sqlite'));
  const state = new RuntimeState();
  const client = new AndroidWechatClient({
    state,
    idMap,
    isSleeping: () => false,
    messageGuard: new MessageGuard(),
    onPrivateText: async () => {},
    onGroupText: async () => {},
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    pairingDbPath: join(directory, 'pairing.sqlite'),
    contactsSyncIntervalMs: 0, // 禁用周期定时，避免测试干扰
    ...options,
  });
  return { client, idMap, state };
}

/** 连接 + hello，并等待/应答「认证连接后自动同步」，让后续手动测试不受干扰。 */
async function connectAndSettleAutoSync(client, agent) {
  agent.socket.send(JSON.stringify(envelope('hello', { hookConnected: true })));
  await agent.waitFor((message) => message.type === 'hello_ack');
  const autoRequest = await agent.waitFor(
    (message) => message.type === 'refresh_contacts',
  );
  return autoRequest;
}

// ────────────────────────── id-map 层（contacts 表） ──────────────────────────

test('同时同步群聊和私聊；新联系人插入、现有联系人更新', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'feagle-contacts-'));
  const idMap = new IdMap(join(directory, 'mapping.sqlite'));
  t.after(() => idMap.close());

  const first = idMap.syncContacts(snapshot({
    groups: [groupEntry('room1@chatroom', '群一')],
    privateContacts: [privateEntry('wxid_a', '甲'), privateEntry('wxid_b', '乙')],
  }));
  assert.deepEqual(first, { inserted: 3, updated: 0, deleted: 0 });
  assert.equal(idMap.listContacts().length, 3);

  const second = idMap.syncContacts(snapshot({
    groups: [
      groupEntry('room1@chatroom', '群一改名', 12),
      groupEntry('room2@chatroom', '群二'),
    ],
    privateContacts: [
      privateEntry('wxid_a', '甲备注'),
      privateEntry('wxid_c', '丙'),
    ],
  }));
  // 完整快照语义：第一轮插入的 wxid_b 不在本轮快照 → 物理删除
  assert.deepEqual(second, { inserted: 2, updated: 2, deleted: 1 });

  const rows = idMap.listContacts();
  assert.equal(rows.length, 4);
  const room1 = rows.find((row) => row.talker === 'room1@chatroom');
  assert.equal(room1.kind, 'group');
  assert.equal(room1.name, '群一改名');
  assert.equal(room1.memberCount, 12);
  const a = rows.find((row) => row.talker === 'wxid_a');
  assert.equal(a.name, '甲备注');
  const c = rows.find((row) => row.talker === 'wxid_c');
  assert.equal(c.kind, 'private');
});

test('已退群群聊与已删除私人联系人被物理删除', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'feagle-contacts-'));
  const idMap = new IdMap(join(directory, 'mapping.sqlite'));
  t.after(() => idMap.close());

  idMap.syncContacts(snapshot({
    groups: [groupEntry('r1@chatroom'), groupEntry('r2@chatroom')],
    privateContacts: [privateEntry('wxid_x'), privateEntry('wxid_y')],
  }));
  const result = idMap.syncContacts(snapshot({
    groups: [groupEntry('r1@chatroom')],
    privateContacts: [privateEntry('wxid_x')],
  }));
  // r1/wxid_x 已存在 → 重新 upsert 计入 updated
  assert.deepEqual(result, { inserted: 0, updated: 2, deleted: 2 });
  const talkers = idMap.listContacts().map((row) => row.talker);
  assert.deepEqual(talkers.sort(), ['r1@chatroom', 'wxid_x']);
});

test('rcontact 行仍在但 chatroom 权威判据已剔除的退群群被删除（2026-08-13 真机：58483015293@chatroom 在 rcontact type=2 deleteFlag=0 仍存在，必须由 Agent 侧 chatroom 表/成员列表交集剔除）', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'feagle-contacts-'));
  const idMap = new IdMap(join(directory, 'mapping.sqlite'));
  t.after(() => idMap.close());

  // 上一轮快照：rcontact 中两个群行都存在（包括已退群群 left@chatroom）
  idMap.syncContacts(snapshot({
    groups: [groupEntry('left@chatroom'), groupEntry('stay@chatroom')],
    privateContacts: [privateEntry('wxid_x')],
  }));
  // 本轮 Agent 经 ChatroomStorage 判据（chatroom 行存在 + memberlist 含自己）
  // 将 left@chatroom 判定为已退群并从快照剔除——rcontact 行并未删除，但快照没有它
  const result = idMap.syncContacts(snapshot({
    groups: [groupEntry('stay@chatroom')],
    privateContacts: [privateEntry('wxid_x')],
  }));
  assert.deepEqual(result, { inserted: 0, updated: 2, deleted: 1 });
  const talkers = idMap.listContacts().map((row) => row.talker);
  assert.deepEqual(talkers.sort(), ['stay@chatroom', 'wxid_x']);
});

test('群成员权威判定不可用（full=false）时绝不删除任何群，即使快照缺群', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'feagle-contacts-'));
  const idMap = new IdMap(join(directory, 'mapping.sqlite'));
  t.after(() => idMap.close());

  idMap.syncContacts(snapshot({
    groups: [groupEntry('g1@chatroom'), groupEntry('g2@chatroom')],
  }));
  // Agent 未捕获 ChatroomStorage / 判据抛错 → full=false：只 upsert，绝不做删除
  const result = idMap.syncContacts(snapshot({
    groups: [groupEntry('g1@chatroom')],
    full: false,
  }));
  assert.deepEqual(result, { inserted: 0, updated: 1, deleted: 0 });
  const talkers = idMap.listContacts().map((row) => row.talker);
  assert.deepEqual(talkers.sort(), ['g1@chatroom', 'g2@chatroom']);
});

test('空但明确合法的完整快照可以清空 contacts', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'feagle-contacts-'));
  const idMap = new IdMap(join(directory, 'mapping.sqlite'));
  t.after(() => idMap.close());

  idMap.syncContacts(snapshot({
    groups: [groupEntry('r1@chatroom')],
    privateContacts: [privateEntry('wxid_x')],
  }));
  const result = idMap.syncContacts(snapshot({ groups: [], privateContacts: [] }));
  assert.deepEqual(result, { inserted: 0, updated: 0, deleted: 2 });
  assert.deepEqual(idMap.listContacts(), []);
});

test('不完整快照（未标记 full）不能删除旧数据', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'feagle-contacts-'));
  const idMap = new IdMap(join(directory, 'mapping.sqlite'));
  t.after(() => idMap.close());

  idMap.syncContacts(snapshot({
    groups: [groupEntry('r1@chatroom'), groupEntry('r2@chatroom')],
  }));
  // full 缺失：只做 upsert，绝不做删除
  const result = idMap.syncContacts(snapshot({
    groups: [groupEntry('r1@chatroom')],
    full: false,
  }));
  assert.equal(result.deleted, 0);
  assert.ok(idMap.listContacts().some((row) => row.talker === 'r2@chatroom'));
});

test('数据解析失败（非法行）时抛错且不写入任何数据', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'feagle-contacts-'));
  const idMap = new IdMap(join(directory, 'mapping.sqlite'));
  t.after(() => idMap.close());

  idMap.syncContacts(snapshot({ groups: [groupEntry('r1@chatroom')] }));
  const before = JSON.stringify(idMap.listContacts());

  assert.throws(() => idMap.syncContacts(snapshot({
    privateContacts: [privateEntry('filehelper')], // 系统账号，非法私聊 talker
  })), /talker 非法/);
  assert.throws(() => idMap.syncContacts(snapshot({
    groups: 'not-an-array',
  })), /groups 数组/);
  assert.throws(() => idMap.syncContacts({
    generatedAt: 'not-a-date',
    groups: [],
    privateContacts: [],
    full: true,
  }), /generatedAt/);
  assert.equal(JSON.stringify(idMap.listContacts()), before);
});

test('事务失败（staged 后抛错）完整回滚，不保留任何部分写入', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'feagle-contacts-'));
  const idMap = new IdMap(join(directory, 'mapping.sqlite'));
  t.after(() => idMap.close());

  idMap.syncContacts(snapshot({ groups: [groupEntry('keep@chatroom')] }));
  const before = JSON.stringify(idMap.listContacts());

  assert.throws(() => idMap.syncContacts(snapshot({
    groups: [groupEntry('new1@chatroom'), groupEntry('new2@chatroom')],
    privateContacts: [privateEntry('wxid_new')],
  }), {
    afterStage() {
      throw new Error('injected commit failure');
    },
  }), /injected commit failure/);

  assert.equal(JSON.stringify(idMap.listContacts()), before);
});

test('联系人删除不影响 OneBot ID 映射、历史消息与回执', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'feagle-contacts-'));
  const idMap = new IdMap(join(directory, 'mapping.sqlite'));
  t.after(() => idMap.close());

  idMap.syncContacts(snapshot({ groups: [groupEntry('r1@chatroom')] }));
  const onebotId = idMap.entity('user', 'wxid_x', 'wxid_x', '旧昵称');
  idMap.storeMessage('wxsvr:10001', { hello: 'world' });
  idMap.claimMessage('wxsvr:10002', 'private');

  // 完整快照里没有 r1@chatroom 和 wxid_x 之外的联系人 → 物理删除
  idMap.syncContacts(snapshot({ privateContacts: [privateEntry('wxid_other')] }));
  assert.equal(idMap.listContacts().some((row) => row.talker === 'r1@chatroom'), false);

  assert.equal(idMap.protocolId(onebotId, 'user'), 'wxid_x');
  assert.equal(idMap.contact(onebotId).nickname, '旧昵称');
  assert.deepEqual(idMap.message(idMap.storeMessage('wxsvr:10001', { hello: 'world' })), { hello: 'world' });
  assert.equal(idMap.messageReceipt('wxsvr:10002').status, 'RECEIVED');
});

test('快照行去重、名称限长、字段类型校验', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'feagle-contacts-'));
  const idMap = new IdMap(join(directory, 'mapping.sqlite'));
  t.after(() => idMap.close());

  const longName = '很'.repeat(200);
  idMap.syncContacts(snapshot({
    groups: [
      groupEntry('r1@chatroom', longName, -5),
      groupEntry('r1@chatroom', '重复', 0), // 同 talker 去重，保留首个
    ],
    privateContacts: [{
      talker: 'wxid_x',
      name: '  甲  ',
      avatarBase64: 12345, // 非字符串 → 空串
    }],
  }));

  const rows = idMap.listContacts();
  assert.equal(rows.length, 2);
  const room = rows.find((row) => row.talker === 'r1@chatroom');
  assert.equal(room.name.length, 80);
  assert.equal(room.memberCount, 0); // 负数 → 0
  const priv = rows.find((row) => row.talker === 'wxid_x');
  assert.equal(priv.name, '甲');
  assert.equal(priv.avatarBase64, '');
});

// ────────────────────── android-client 层（协议/等待器） ──────────────────────

test('refreshContacts 端到端：快照入库 + 状态 READY + 不发微信消息不重连', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'feagle-contacts-'));
  const { client, idMap, state } = makeClient(directory);
  await client.start();
  t.after(() => {
    client.shutdown();
    idMap.close();
  });

  const agent = await connectAgent(client.server.address().port);
  t.after(() => agent.socket.close());
  const autoRequest = await connectAndSettleAutoSync(client, agent);

  // 应答自动同步（认证连接后执行一次）
  agent.socket.send(JSON.stringify(envelope('contacts_snapshot', {
    commandId: autoRequest.commandId,
    full: true,
    generatedAt: new Date().toISOString(),
    groups: [groupEntry('room1@chatroom', '群一')],
    privateContacts: [privateEntry('wxid_a', '甲')],
  })));
  await waitForCondition(() => client.contactsSyncing === null);
  assert.equal(state.contacts.status, 'READY');
  assert.equal(idMap.listContacts().length, 2);

  // 手动内部调用
  const beforeCount = agent.received().length;
  const resultPromise = client.refreshContacts({ includeAvatars: true });
  const request = await agent.waitFor(
    (message) => message.type === 'refresh_contacts' && message.commandId !== autoRequest.commandId,
  );
  assert.equal(request.includeAvatars, true);

  agent.socket.send(JSON.stringify(envelope('contacts_snapshot', {
    commandId: request.commandId,
    full: true,
    generatedAt: new Date().toISOString(),
    groups: [
      groupEntry('room1@chatroom', '群一'),
      groupEntry('room2@chatroom', '群二'),
    ],
    privateContacts: [privateEntry('wxid_a', '甲'), privateEntry('wxid_b', '乙')],
  })));
  const result = await resultPromise;
  assert.deepEqual(result, {
    groups: 2,
    privates: 2,
    inserted: 2,
    updated: 2,
    deleted: 0,
    refreshedAt: result.refreshedAt,
  });

  // 同步过程不发送任何微信消息（无 send_text），不触发重连（无 hello）
  const received = agent.received();
  assert.equal(received.some((message) => message.type === 'send_text'), false);
  assert.equal(received.filter((message) => message.type === 'hello').length, 0);
  assert.equal(agent.socket.readyState, WebSocket.OPEN);
  assert.equal(client.loggedIn, true);
  assert.equal(idMap.listContacts().length, 4);
  assert.equal(state.contacts.counts.inserted, 2);
});

test('超时后清理 pending Promise 并拒绝，不清理旧数据', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'feagle-contacts-'));
  const { client, idMap } = makeClient(directory, { contactsSyncTimeoutMs: 80 });
  await client.start();
  t.after(() => {
    client.shutdown();
    idMap.close();
  });

  const agent = await connectAgent(client.server.address().port);
  t.after(() => agent.socket.close());
  const autoRequest = await connectAndSettleAutoSync(client, agent);
  // 自动同步也超时（80ms 内无应答）→ 失败只记录错误
  await waitForCondition(() => client.contactsSyncing === null);

  const p = client.refreshContacts();
  await agent.waitFor((message) => message.type === 'refresh_contacts' && message.commandId !== autoRequest.commandId);
  await assert.rejects(p, /contacts_snapshot timed out/);
  assert.equal(client.contactSyncWaiters.size, 0);
  assert.equal(client.contactsSyncing, null);

  // 超时清理后可再次发起
  const again = client.refreshContacts();
  const request = await agent.waitFor((message) => message.type === 'refresh_contacts');
  agent.socket.send(JSON.stringify(envelope('contacts_snapshot', {
    commandId: request.commandId,
    full: true,
    generatedAt: new Date().toISOString(),
    groups: [],
    privateContacts: [],
  })));
  await again;
});

test('commandId 不匹配的 contacts_snapshot 不能完成请求', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'feagle-contacts-'));
  const { client, idMap } = makeClient(directory);
  await client.start();
  t.after(() => {
    client.shutdown();
    idMap.close();
  });

  const agent = await connectAgent(client.server.address().port);
  t.after(() => agent.socket.close());
  const autoRequest = await connectAndSettleAutoSync(client, agent);
  agent.socket.send(JSON.stringify(envelope('contacts_snapshot', {
    commandId: autoRequest.commandId,
    full: true,
    generatedAt: new Date().toISOString(),
    groups: [groupEntry('auto@chatroom')],
    privateContacts: [],
  })));
  await waitForCondition(() => client.contactsSyncing === null);

  const p = client.refreshContacts();
  const request = await agent.waitFor(
    (message) => message.type === 'refresh_contacts' && message.commandId !== autoRequest.commandId,
  );
  // 先发错误 commandId（不匹配 → 必须忽略）
  agent.socket.send(JSON.stringify(envelope('contacts_snapshot', {
    commandId: `${request.commandId}-wrong`,
    full: true,
    generatedAt: new Date().toISOString(),
    groups: [groupEntry('wrong@chatroom')],
    privateContacts: [],
  })));
  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });
  await delay(60);
  assert.equal(settled, false, '错误 commandId 不得完成请求');

  // 匹配的 commandId → 正常完成
  agent.socket.send(JSON.stringify(envelope('contacts_snapshot', {
    commandId: request.commandId,
    full: true,
    generatedAt: new Date().toISOString(),
    groups: [groupEntry('right@chatroom')],
    privateContacts: [],
  })));
  const result = await p;
  assert.equal(result.groups, 1);
  assert.ok(idMap.listContacts().some((row) => row.talker === 'right@chatroom'));
  assert.equal(idMap.listContacts().some((row) => row.talker === 'wrong@chatroom'), false);
});

test('重复刷新复用同一任务，不向 Agent 重复发送', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'feagle-contacts-'));
  const { client, idMap } = makeClient(directory);
  await client.start();
  t.after(() => {
    client.shutdown();
    idMap.close();
  });

  const agent = await connectAgent(client.server.address().port);
  t.after(() => agent.socket.close());
  const autoRequest = await connectAndSettleAutoSync(client, agent);
  agent.socket.send(JSON.stringify(envelope('contacts_snapshot', {
    commandId: autoRequest.commandId,
    full: true,
    generatedAt: new Date().toISOString(),
    groups: [],
    privateContacts: [],
  })));
  await waitForCondition(() => client.contactsSyncing === null);

  const first = client.refreshContacts();
  const second = client.refreshContacts();
  assert.equal(first, second, '同步中重复调用必须复用同一 Promise');

  const request = await agent.waitFor(
    (message) => message.type === 'refresh_contacts' && message.commandId !== autoRequest.commandId,
  );
  await delay(80);
  // 唯一一次请求已被 waitFor 消费；队列里不得再出现重复请求
  assert.equal(
    agent.received().some((message) => message.type === 'refresh_contacts'),
    false,
    '同步中不得重复发送 refresh_contacts',
  );
  agent.socket.send(JSON.stringify(envelope('contacts_snapshot', {
    commandId: request.commandId,
    full: true,
    generatedAt: new Date().toISOString(),
    groups: [groupEntry('r1@chatroom')],
    privateContacts: [],
  })));
  const result = await second;
  assert.equal(result.groups, 1);
});

test('Agent 断线时 pending Promise 被正确拒绝', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'feagle-contacts-'));
  const { client, idMap } = makeClient(directory);
  await client.start();
  t.after(() => {
    client.shutdown();
    idMap.close();
  });

  const agent = await connectAgent(client.server.address().port);
  const autoRequest = await connectAndSettleAutoSync(client, agent);
  agent.socket.send(JSON.stringify(envelope('contacts_snapshot', {
    commandId: autoRequest.commandId,
    full: true,
    generatedAt: new Date().toISOString(),
    groups: [],
    privateContacts: [],
  })));
  await waitForCondition(() => client.contactsSyncing === null);

  const p = client.refreshContacts();
  await agent.waitFor(
    (message) => message.type === 'refresh_contacts' && message.commandId !== autoRequest.commandId,
  );
  agent.socket.close(); // 断线
  await assert.rejects(p, /Android Agent disconnected/);
  assert.equal(client.contactSyncWaiters.size, 0);
  assert.equal(client.contactsSyncing, null);
});

test('错误响应（command_result ok=false）不能删除旧数据', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'feagle-contacts-'));
  const { client, idMap, state } = makeClient(directory);
  await client.start();
  t.after(() => {
    client.shutdown();
    idMap.close();
  });

  // 预置旧数据
  idMap.syncContacts(snapshot({ groups: [groupEntry('keep@chatroom')] }));
  const before = JSON.stringify(idMap.listContacts());

  const agent = await connectAgent(client.server.address().port);
  t.after(() => agent.socket.close());
  const autoRequest = await connectAndSettleAutoSync(client, agent);
  // 自动同步失败：只记录错误，不清理数据、不重启任何组件
  agent.socket.send(JSON.stringify(envelope('command_result', {
    commandId: autoRequest.commandId,
    ok: false,
    error: 'hook_not_connected',
  })));
  await waitForCondition(() => client.contactsSyncing === null);
  assert.equal(state.contacts.status, 'ERROR');
  assert.equal(JSON.stringify(idMap.listContacts()), before);

  const p = client.refreshContacts();
  const request = await agent.waitFor(
    (message) => message.type === 'refresh_contacts' && message.commandId !== autoRequest.commandId,
  );
  agent.socket.send(JSON.stringify(envelope('command_result', {
    commandId: request.commandId,
    ok: false,
    error: 'contacts_sync_busy',
  })));
  await assert.rejects(p, /contacts_sync_busy/);
  assert.equal(JSON.stringify(idMap.listContacts()), before);
});

test('不合法快照（字段类型/非法 talker）不能删除旧数据', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'feagle-contacts-'));
  const { client, idMap } = makeClient(directory);
  await client.start();
  t.after(() => {
    client.shutdown();
    idMap.close();
  });

  idMap.syncContacts(snapshot({ groups: [groupEntry('keep@chatroom')] }));
  const before = JSON.stringify(idMap.listContacts());

  const agent = await connectAgent(client.server.address().port);
  t.after(() => agent.socket.close());
  const autoRequest = await connectAndSettleAutoSync(client, agent);
  // 自动同步应答需保留预置行（否则完整快照会合法清空）
  agent.socket.send(JSON.stringify(envelope('contacts_snapshot', {
    commandId: autoRequest.commandId,
    full: true,
    generatedAt: new Date().toISOString(),
    groups: [groupEntry('keep@chatroom')],
    privateContacts: [],
  })));
  await waitForCondition(() => client.contactsSyncing === null);
  assert.deepEqual(
    idMap.listContacts().map((row) => row.talker),
    ['keep@chatroom'],
  );

  // 非法 talker（系统账号）→ 校验失败 → 整次同步拒绝
  const p = client.refreshContacts();
  const request = await agent.waitFor(
    (message) => message.type === 'refresh_contacts' && message.commandId !== autoRequest.commandId,
  );
  agent.socket.send(JSON.stringify(envelope('contacts_snapshot', {
    commandId: request.commandId,
    full: true,
    generatedAt: new Date().toISOString(),
    groups: [],
    privateContacts: [privateEntry('filehelper')],
  })));
  await assert.rejects(p, /talker 非法/);
  assert.deepEqual(
    idMap.listContacts().map((row) => row.talker),
    ['keep@chatroom'],
    '非法快照不得增删改任何联系人行',
  );
});

test('未认证/未连接时 refreshContacts 立即返回明确错误', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'feagle-contacts-'));
  const { client, idMap } = makeClient(directory);
  await client.start();
  t.after(() => {
    client.shutdown();
    idMap.close();
  });
  await assert.rejects(
    client.refreshContacts(),
    /Android WeChat Agent is not connected/,
  );
});
