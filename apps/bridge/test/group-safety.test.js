import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GROUP_SAFETY_STATUS,
  GroupSafetyGate,
  normalizeBlockedTerms,
} from '../src/group-safety.js';

test('blocked terms are local literal matches with safe normalization', () => {
  assert.deepEqual(
    normalizeBlockedTerms([' Risk ', 'risk', '', 'SPAM']),
    ['risk', 'spam'],
  );
  const gate = new GroupSafetyGate({ blockedTerms: ['Risk'] });
  assert.equal(gate.checkInbound({
    groupId: 1,
    userId: 2,
    text: 'contains RISK text',
  }).status, GROUP_SAFETY_STATUS.POLICY_BLOCKED);
  assert.equal(gate.checkOutbound({
    groupId: 1,
    text: 'safe text',
  }).allowed, true);
});

test('group safety applies independent member and group rate limits', () => {
  let now = 1_000;
  const gate = new GroupSafetyGate({
    now: () => now,
    memberLimit: 2,
    memberWindowMs: 60_000,
    groupLimit: 3,
    groupWindowMs: 60_000,
    fuseAnomalyThreshold: 99,
  });

  assert.equal(gate.checkInbound({ groupId: 1, userId: 10, text: '1' }).allowed, true);
  assert.equal(gate.checkInbound({ groupId: 1, userId: 10, text: '2' }).allowed, true);
  assert.equal(
    gate.checkInbound({ groupId: 1, userId: 10, text: '3' }).status,
    GROUP_SAFETY_STATUS.MEMBER_RATE_LIMITED,
  );
  assert.equal(gate.checkInbound({ groupId: 1, userId: 11, text: '4' }).allowed, true);
  assert.equal(
    gate.checkInbound({ groupId: 1, userId: 12, text: '5' }).status,
    GROUP_SAFETY_STATUS.GROUP_RATE_LIMITED,
  );
  now += 60_001;
  assert.equal(gate.checkInbound({ groupId: 1, userId: 10, text: 'new' }).allowed, true);
});

test('repeated failures trip one per-group fuse and it auto-recovers', () => {
  let now = Date.parse('2026-07-29T00:00:00.000Z');
  const alerts = [];
  const gate = new GroupSafetyGate({
    now: () => now,
    fuseFailureThreshold: 3,
    fuseFailureWindowMs: 60_000,
    fuseDurationMs: 15 * 60_000,
    onFuse: (fuse) => alerts.push(fuse),
  });

  gate.recordFailure(1001);
  gate.recordFailure(1001);
  assert.equal(gate.checkOutbound({ groupId: 1001, text: 'reply' }).allowed, true);
  gate.recordFailure(1001);
  assert.equal(alerts.length, 1);
  assert.equal(
    gate.checkOutbound({ groupId: 1001, text: 'reply' }).status,
    GROUP_SAFETY_STATUS.FUSED,
  );

  now += 15 * 60_000 + 1;
  assert.equal(gate.checkOutbound({ groupId: 1001, text: 'reply' }).allowed, true);
  assert.deepEqual(gate.activeFuses(), []);
});
