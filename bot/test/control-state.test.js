import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PersistentControlState,
  WECHAT_ADMIN_MODES,
  normalizeWechatAdminMode,
} from '../src/control-state.js';
import { GROUP_CHAT_MODES } from '../src/group-chat.js';

test('control state defaults to running when no file exists', () => {
  const directory = mkdtempSync(join(tmpdir(), 'feagle-control-'));
  const store = new PersistentControlState({
    path: join(directory, 'control-state.json'),
  });

  assert.deepEqual(store.load(), {
    wechatAdminMode: WECHAT_ADMIN_MODES.RUNNING,
    groupChatMode: GROUP_CHAT_MODES.OFF,
    groupAllowlist: [],
    changedAt: '',
  });
});

test('control state persists a manual-offline mode across restarts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'feagle-control-'));
  const path = join(directory, 'control-state.json');
  const changedAt = Date.parse('2026-07-28T12:00:00.000Z');
  const store = new PersistentControlState({ path, now: () => changedAt });

  store.save(WECHAT_ADMIN_MODES.MANUAL_OFFLINE);

  assert.equal(store.load().wechatAdminMode, WECHAT_ADMIN_MODES.MANUAL_OFFLINE);
  assert.equal(store.load().changedAt, '2026-07-28T12:00:00.000Z');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).version, 2);
});

test('control state persists fail-closed group chat configuration', () => {
  const directory = mkdtempSync(join(tmpdir(), 'feagle-control-'));
  const path = join(directory, 'control-state.json');
  const store = new PersistentControlState({ path });

  store.saveGroupChatConfig(GROUP_CHAT_MODES.MENTION_ONLY, ['123', '123', 'bad', 456]);

  const loaded = store.load();
  assert.equal(loaded.wechatAdminMode, WECHAT_ADMIN_MODES.RUNNING);
  assert.equal(loaded.groupChatMode, GROUP_CHAT_MODES.MENTION_ONLY);
  assert.deepEqual(loaded.groupAllowlist, ['123', '456']);
});

test('invalid control values normalize safely but cannot be saved', () => {
  assert.equal(normalizeWechatAdminMode('unknown'), WECHAT_ADMIN_MODES.RUNNING);
  const directory = mkdtempSync(join(tmpdir(), 'feagle-control-'));
  const store = new PersistentControlState({
    path: join(directory, 'control-state.json'),
  });
  assert.throws(() => store.save('unknown'), /Unsupported WeChat admin mode/);
});
