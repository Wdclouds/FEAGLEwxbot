import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeState } from '../src/state.js';

test('blank Wechat4u errors receive a readable fallback', () => {
  const state = new RuntimeState();

  state.addError('wechat', new Error(''));

  assert.equal(state.errors[0].message, '未提供错误详情');
});

test('Wechat4u tips are preferred over empty error messages', () => {
  const state = new RuntimeState();
  const error = new Error('');
  error.tips = '同步暂时失败';

  state.addError('wechat', error);

  assert.equal(state.errors[0].message, '同步暂时失败');
});
