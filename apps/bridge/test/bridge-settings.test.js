import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BridgeSettingsStore,
  normalizeBridgeSettings,
  settingsDefaults,
} from '../src/bridge-settings.js';

test('bridge settings persist only validated non-secret values', () => {
  const directory = mkdtempSync(join(tmpdir(), 'feagle-settings-'));
  const path = join(directory, 'bridge-settings.json');
  const defaults = settingsDefaults({});
  const store = new BridgeSettingsStore({ path, defaults });
  assert.equal(store.load().transport, 'wechat4u');
  const saved = store.save({
    transport: 'android',
    quietHours: '01:00-06:30',
    timezone: 'Asia/Shanghai',
    maxInFlight: 5,
    maxInFlightPerUser: 2,
  });
  assert.equal(saved.transport, 'android');
  assert.equal(saved.maxInFlight, 5);

  const reloaded = new BridgeSettingsStore({ path, defaults }).load();
  assert.deepEqual(reloaded, saved);
  assert.throws(() => store.save({ API_KEY: 'must-not-be-accepted' }), /Unsupported setting/);
});

test('bridge settings reject unsafe ranges and inconsistent jitter', () => {
  assert.throws(
    () => normalizeBridgeSettings({ quietHours: '25:00-07:00' }),
    /时间无效/,
  );
  assert.throws(
    () => normalizeBridgeSettings({ groupJitterMinMs: 4_000, groupJitterMaxMs: 2_000 }),
    /cannot exceed/,
  );
  assert.throws(
    () => normalizeBridgeSettings({ transport: 'unknown' }),
    /wechat4u or android/,
  );
});
