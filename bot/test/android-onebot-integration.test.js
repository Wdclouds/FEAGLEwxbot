import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { AndroidWechatClient } from '../src/android-client.js';
import { IdMap } from '../src/id-map.js';
import { MessageGuard } from '../src/message-guard.js';
import { OneBotClient } from '../src/onebot-client.js';
import { RuntimeState } from '../src/state.js';

const TOKEN = 'android-integration-token-with-24-characters';
const DEVICE_ID = 'integration-device';

function waitForListening(server) {
  return new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
}

function messageInbox(socket) {
  const queued = [];
  const waiters = [];
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    const index = waiters.findIndex(({ predicate }) => predicate(message));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      waiter.resolve(message);
    } else {
      queued.push(message);
    }
  });
  return (predicate) => {
    const index = queued.findIndex(predicate);
    if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Timed out waiting for WebSocket message')),
        3_000,
      );
      waiters.push({
        predicate,
        resolve(message) {
          clearTimeout(timer);
          resolve(message);
        },
      });
    });
  };
}

function connectAgent(port) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/android`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

test('Android event reaches AstrBot as a OneBot v11 private message before ACK', async (t) => {
  const astrbotServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await waitForListening(astrbotServer);
  const astrbotConnection = new Promise((resolve) => {
    astrbotServer.once('connection', resolve);
  });

  const previousOneBotUrl = process.env.ONEBOT_WS_URL;
  process.env.ONEBOT_WS_URL =
    `ws://127.0.0.1:${astrbotServer.address().port}/ws`;

  const directory = mkdtempSync(join(tmpdir(), 'feagle-android-onebot-'));
  const idMap = new IdMap(join(directory, 'mapping.sqlite'));
  const state = new RuntimeState();
  let onebot;
  const android = new AndroidWechatClient({
    state,
    idMap,
    isSleeping: () => false,
    messageGuard: new MessageGuard(),
    onPrivateText: (message) => onebot.sendPrivateText(message),
    onGroupText: (message) => onebot.sendGroupText(message),
    groupJitterMinMs: 0,
    groupJitterMaxMs: 0,
    groupReplyCooldownMs: 0,
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    pairingDbPath: join(directory, 'pairing.sqlite'),
  });
  await android.start();

  const agent = await connectAgent(android.server.address().port);
  const waitForAgent = messageInbox(agent);
  agent.send(JSON.stringify({
    type: 'hello',
    protocol: 'feagle.android.v1',
    deviceId: DEVICE_ID,
    hookConnected: true,
  }));
  await waitForAgent((message) => message.type === 'hello_ack');

  const bridgeSelfId = idMap.entity(
    'self',
    'feagle:bridge',
    'feagle:bridge',
    'FEAGLE WxBot',
  );
  onebot = new OneBotClient({
    state,
    idMap,
    wechat: android,
    selfId: bridgeSelfId,
    isSleeping: () => false,
    connectionWaitMs: 3_000,
  });
  onebot.start();
  const astrbot = await astrbotConnection;
  const waitForAstrBot = messageInbox(astrbot);
  await waitForAstrBot(
    (message) => message.post_type === 'meta_event'
      && message.meta_event_type === 'lifecycle',
  );

  agent.send(JSON.stringify({
    type: 'private_text',
    protocol: 'feagle.android.v1',
    deviceId: DEVICE_ID,
    eventId: 'wxsvr:integration-1',
    talker: 'notify:abcdef0123456789abcdef0123456789',
    displayName: 'Integration contact',
    content: 'integration hello',
    createTime: Date.now(),
    msgId: 101,
    msgSvrId: 1001,
  }));

  const onebotEvent = await waitForAstrBot(
    (message) => message.post_type === 'message',
  );
  assert.equal(onebotEvent.message_type, 'private');
  assert.equal(onebotEvent.raw_message, 'integration hello');
  assert.equal(onebotEvent.message[0].type, 'text');
  assert.equal(onebotEvent.message[0].data.text, 'integration hello');
  assert.ok(Number.isSafeInteger(onebotEvent.user_id));
  assert.ok(Number.isSafeInteger(onebotEvent.message_id));
  assert.equal(onebotEvent.sender.nickname, 'Integration contact');
  assert.equal(onebotEvent.self_id, bridgeSelfId);
  assert.notEqual(onebotEvent.self_id, android.selfId);

  const ack = await waitForAgent((message) => message.type === 'event_ack');
  assert.equal(ack.eventId, 'wxsvr:integration-1');

  const groupTalker = 'integration-group@chatroom';
  const groupId = idMap.entity('group', groupTalker, groupTalker, 'Integration group');
  android.setGroupChatConfig('MENTION_ONLY', [String(groupId)], []);
  agent.send(JSON.stringify({
    type: 'group_text',
    protocol: 'feagle.android.v1',
    deviceId: DEVICE_ID,
    eventId: 'wxsvr:integration-group-1',
    talker: groupTalker,
    sender: 'wxid_integration_member',
    groupName: 'Integration group',
    displayName: 'Integration member',
    content: '@FEAGLE group hello',
    mentioned: true,
    createTime: Date.now(),
  }));
  const groupEvent = await waitForAstrBot(
    (message) => message.post_type === 'message' && message.message_type === 'group',
  );
  assert.equal(groupEvent.group_id, groupId);
  assert.equal(groupEvent.self_id, bridgeSelfId);
  assert.equal(groupEvent.message[0].type, 'at');
  assert.equal(groupEvent.message[0].data.qq, String(bridgeSelfId));
  assert.equal(
    (await waitForAgent((message) => message.type === 'event_ack')).eventId,
    'wxsvr:integration-group-1',
  );

  astrbot.send(JSON.stringify({
    action: 'send_group_msg',
    params: { group_id: groupId, message: 'group response' },
    echo: 'android-group-response',
  }));
  const groupCommand = await waitForAgent(
    (message) => message.type === 'send_text' && message.chatType === 'group',
  );
  assert.equal(groupCommand.talker, groupTalker);
  assert.equal(groupCommand.content, 'group response');
  agent.send(JSON.stringify({
    type: 'command_result',
    protocol: 'feagle.android.v1',
    deviceId: DEVICE_ID,
    commandId: groupCommand.commandId,
    ok: true,
  }));
  const actionResponse = await waitForAstrBot(
    (message) => message.echo === 'android-group-response',
  );
  assert.equal(actionResponse.status, 'ok');

  t.after(() => {
    onebot.stop();
    android.shutdown();
    agent.close();
    astrbot.close();
    astrbotServer.close();
    idMap.close();
    if (previousOneBotUrl === undefined) delete process.env.ONEBOT_WS_URL;
    else process.env.ONEBOT_WS_URL = previousOneBotUrl;
  });
});
