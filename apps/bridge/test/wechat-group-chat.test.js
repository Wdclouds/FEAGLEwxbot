import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeState } from '../src/state.js';
import { WechatClient } from '../src/wechat-client.js';
import { GROUP_CHAT_MODES } from '../src/group-chat.js';
import { GroupSafetyGate } from '../src/group-safety.js';

function fixture({
  mode,
  allowlist = [],
  blockedTerms = [],
  onGroupText = async () => {},
}) {
  const state = new RuntimeState();
  const ids = {
    group: 1_000_000_101,
    group_member: 1_000_000_102,
  };
  const idMap = {
    entity: (kind) => ids[kind] || 1_000_000_001,
    claimMessage: () => true,
    updateMessageReceipt: () => {},
    protocolId: (id, kind) => (
      kind === 'group' && String(id) === String(ids.group) ? '@@group' : null
    ),
    contact: () => ({ nickname: 'Test Group' }),
  };
  const client = new WechatClient({
    state,
    idMap,
    isSleeping: () => false,
    onPrivateText: async () => {},
    onGroupText,
    initialGroupChatMode: mode,
    initialGroupAllowlist: allowlist,
    initialGroupBlockedTerms: blockedTerms,
    groupSafety: new GroupSafetyGate({
      blockedTerms,
      fuseAnomalyThreshold: 99,
    }),
    groupReplyCooldownMs: 5_000,
    groupJitterMinMs: 0,
    groupJitterMaxMs: 0,
    delay: async () => {},
  });
  client.loggedIn = true;
  client.selfId = 1_000_000_000;
  client.bot = {
    user: { UserName: '@self', NickName: 'Bot' },
    CONF: { MSGTYPE_TEXT: 1 },
    contacts: {
      '@@group': {
        UserName: '@@group',
        NickName: 'Test Group',
        MemberCount: 2,
        MemberList: [
          { UserName: '@self', NickName: 'Bot', DisplayName: 'Bot' },
          { UserName: '@member', NickName: 'Alice', DisplayName: 'Alice' },
        ],
      },
    },
    sendText: async (text, protocolId) => ({ text, protocolId, MsgID: 'sent-1' }),
  };
  return { state, client, groupId: ids.group };
}

function groupMessage(text = '@Bot\u2005hello') {
  return {
    FromUserName: '@@group',
    MsgType: 1,
    MsgId: 'group-message-1',
    ActualUserName: '@member',
    OriginalContent: `@member:<br/>${text}`,
    Content: `Alice:\n${text}`,
  };
}

test('observe mode records group text without forwarding to AstrBot', async () => {
  let calls = 0;
  const { state, client } = fixture({
    mode: GROUP_CHAT_MODES.OBSERVE,
    onGroupText: async () => { calls += 1; },
  });

  await client.handleMessage(groupMessage());

  assert.equal(calls, 0);
  assert.equal(state.groupChat.observed, 1);
  assert.equal(state.messages[0].status, 'GROUP-OBSERVED');
});

test('mention-only mode requires the mapped group ID in the allowlist', async () => {
  let calls = 0;
  const { state, client } = fixture({
    mode: GROUP_CHAT_MODES.MENTION_ONLY,
    onGroupText: async () => { calls += 1; },
  });

  await client.handleMessage(groupMessage());

  assert.equal(calls, 0);
  assert.equal(state.messages[0].status, 'GROUP-NOT-ALLOWED');
});

test('an explicit mention from an allowlisted group is forwarded with numeric IDs', async () => {
  let forwarded;
  const groupId = 1_000_000_101;
  const { state, client } = fixture({
    mode: GROUP_CHAT_MODES.MENTION_ONLY,
    allowlist: [groupId],
    onGroupText: async (message) => { forwarded = message; },
  });

  await client.handleMessage(groupMessage());

  assert.equal(forwarded.groupId, groupId);
  assert.equal(forwarded.userId, 1_000_000_102);
  assert.equal(forwarded.text, 'hello');
  assert.equal(state.groupChat.forwarded, 1);
});

test('group replies are allowlisted and protected by a per-group cooldown', async () => {
  let now = 100_000;
  const groupId = 1_000_000_101;
  const { client } = fixture({
    mode: GROUP_CHAT_MODES.MENTION_ONLY,
    allowlist: [groupId],
  });
  client.now = () => now;

  const sent = await client.sendGroupText(groupId, 'reply');
  assert.equal(sent.protocolId, '@@group');
  await assert.rejects(
    client.sendGroupText(groupId, 'too soon'),
    (error) => error.code === 'GROUP_REPLY_COOLDOWN',
  );
  now += 5_001;
  await client.sendGroupText(groupId, 'later');
});

test('local text policy blocks both inbound prompts and outbound replies', async () => {
  let calls = 0;
  const groupId = 1_000_000_101;
  const { state, client } = fixture({
    mode: GROUP_CHAT_MODES.MENTION_ONLY,
    allowlist: [groupId],
    blockedTerms: ['blocked phrase'],
    onGroupText: async () => { calls += 1; },
  });

  await client.handleMessage(groupMessage('@Bot\u2005contains blocked phrase'));
  assert.equal(calls, 0);
  assert.equal(state.messages[0].status, 'GROUP-POLICY-BLOCKED');
  await assert.rejects(
    client.sendGroupText(groupId, 'model says blocked phrase'),
    (error) => error.code === 'GROUP-POLICY-BLOCKED',
  );
});

test('group replies use configurable jitter before sending', async () => {
  const groupId = 1_000_000_101;
  const delays = [];
  const { client } = fixture({
    mode: GROUP_CHAT_MODES.MENTION_ONLY,
    allowlist: [groupId],
  });
  client.groupJitterMinMs = 1_000;
  client.groupJitterMaxMs = 3_000;
  client.random = () => 0.5;
  client.delay = async (milliseconds) => delays.push(milliseconds);

  await client.sendGroupText(groupId, 'reply');

  assert.deepEqual(delays, [2_000]);
});
