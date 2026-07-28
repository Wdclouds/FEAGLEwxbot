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
