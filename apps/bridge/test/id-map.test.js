import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IdMap } from '../src/id-map.js';

test('message receipts survive in SQLite and reject replayed WeChat IDs', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'feagle-id-map-'));
  const path = join(directory, 'mapping.sqlite');
  const first = new IdMap(path);

  assert.equal(first.claimMessage('wechat-1', 'private'), true);
  assert.equal(first.claimMessage('wechat-1', 'private'), false);

  first.close();
  const reopened = new IdMap(path);
  t.after(() => reopened.close());
  assert.equal(reopened.claimMessage('wechat-1', 'private'), false);
});

test('message receipts can be retried before forwarding but not after forwarding', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'feagle-id-map-retry-'));
  const map = new IdMap(join(directory, 'mapping.sqlite'));
  t.after(() => map.close());

  assert.equal(map.claimMessage('android:event-1', 'android-private'), true);
  assert.equal(map.messageReceipt('android:event-1').status, 'RECEIVED');
  assert.equal(map.releaseMessageReceipt('android:event-1'), true);
  assert.equal(map.messageReceipt('android:event-1'), null);

  assert.equal(map.claimMessage('android:event-1', 'android-private'), true);
  map.updateMessageReceipt('android:event-1', 'FORWARDED');
  assert.equal(map.releaseMessageReceipt('android:event-1'), false);
  assert.equal(map.messageReceipt('android:event-1').status, 'FORWARDED');
});

test('OneBot message IDs remain stable when the same transport event is replayed', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'feagle-id-map-message-'));
  const map = new IdMap(join(directory, 'mapping.sqlite'));
  t.after(() => map.close());

  const first = map.storeMessage('android:event-2', { raw_message: 'first' });
  const second = map.storeMessage('android:event-2', { raw_message: 'replayed' });

  assert.equal(second, first);
  assert.equal(map.message(first).raw_message, 'replayed');
});
