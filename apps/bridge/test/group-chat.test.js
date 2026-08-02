import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GROUP_CHAT_MODES,
  normalizeGroupAllowlist,
  normalizeGroupChatMode,
  parseWechatGroupText,
} from '../src/group-chat.js';

const group = {
  UserName: '@@group',
  NickName: '测试群',
  MemberCount: 2,
  MemberList: [
    { UserName: '@self', NickName: '机器人', DisplayName: '小鹰' },
    { UserName: '@member', NickName: '群友', Alias: 'friend-alias' },
  ],
};

test('group mode and allowlist normalization fail closed', () => {
  assert.equal(normalizeGroupChatMode('mention_only'), GROUP_CHAT_MODES.MENTION_ONLY);
  assert.equal(normalizeGroupChatMode('anything'), GROUP_CHAT_MODES.OFF);
  assert.deepEqual(normalizeGroupAllowlist(['1001', 1002, 'bad', '1001']), ['1001', '1002']);
});

test('parses Wechat4u group sender, text and an explicit mention', () => {
  const parsed = parseWechatGroupText({
    message: {
      FromUserName: '@@group',
      OriginalContent: '@member:<br/>@小鹰\u2005 你好',
      Content: '群友:\n@小鹰\u2005 你好',
    },
    group,
    selfUserName: '@self',
    selfNickName: '机器人',
  });

  assert.equal(parsed.groupProtocolId, '@@group');
  assert.equal(parsed.groupName, '测试群');
  assert.equal(parsed.senderProtocolId, '@member');
  assert.equal(parsed.senderStableKey, 'friend-alias');
  assert.equal(parsed.senderNickname, '群友');
  assert.equal(parsed.mentioned, true);
  assert.equal(parsed.text, '你好');
  assert.equal(parsed.isSelf, false);
});

test('keeps a normal group message as observation-only text', () => {
  const parsed = parseWechatGroupText({
    message: {
      FromUserName: '@@group',
      OriginalContent: '@member:<br/>大家晚上好',
      Content: '群友:\n大家晚上好',
    },
    group,
    selfUserName: '@self',
  });

  assert.equal(parsed.mentioned, false);
  assert.equal(parsed.text, '大家晚上好');
});

test('detects a message sent by the logged-in account inside a group', () => {
  const parsed = parseWechatGroupText({
    message: {
      FromUserName: '@@group',
      OriginalContent: '@self:<br/>机器人发出的消息',
      Content: '小鹰:\n机器人发出的消息',
    },
    group,
    selfUserName: '@self',
  });

  assert.equal(parsed.isSelf, true);
});
