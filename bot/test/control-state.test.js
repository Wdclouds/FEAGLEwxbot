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

test('control state defaults to running when no file exists', () => {
  const directory = mkdtempSync(join(tmpdir(), 'feagle-control-'));
  const store = new PersistentControlState({
    path: join(directory, 'control-state.json'),
  });

  assert.deepEqual(store.load(), {
    wechatAdminMode: WECHAT_ADMIN_MODES.RUNNING,
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
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).version, 1);
});

test('invalid control values normalize safely but cannot be saved', () => {
  assert.equal(normalizeWechatAdminMode('unknown'), WECHAT_ADMIN_MODES.RUNNING);
  const directory = mkdtempSync(join(tmpdir(), 'feagle-control-'));
  const store = new PersistentControlState({
    path: join(directory, 'control-state.json'),
  });
  assert.throws(() => store.save('unknown'), /Unsupported WeChat admin mode/);
});
