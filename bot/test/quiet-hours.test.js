import test from 'node:test';
import assert from 'node:assert/strict';
import { isQuietTime, parseQuietHours } from '../src/quiet-hours.js';
import { extractPlainText } from '../src/onebot-client.js';

const range = parseQuietHours('00:00-07:00');

test('quiet hours include midnight and exclude 07:00', () => {
  assert.equal(isQuietTime(new Date('2026-07-27T16:00:00Z'), range), true);
  assert.equal(isQuietTime(new Date('2026-07-27T22:59:00Z'), range), true);
  assert.equal(isQuietTime(new Date('2026-07-27T23:00:00Z'), range), false);
});

test('equal quiet-hour boundaries disable the quiet window', () => {
  const disabled = parseQuietHours('00:00-00:00');
  assert.equal(isQuietTime(new Date('2026-07-27T18:00:00Z'), disabled), false);
});

test('extracts text from OneBot message segments', () => {
  assert.equal(extractPlainText([
    { type: 'text', data: { text: 'hello ' } },
    { type: 'image', data: { file: 'ignored' } },
    { type: 'text', data: { text: 'world' } },
  ]), 'hello world');
});
