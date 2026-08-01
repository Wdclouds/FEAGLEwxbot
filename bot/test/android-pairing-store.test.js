import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AndroidPairingStore } from '../src/android-pairing-store.js';

const SECRET = 'pairing-test-secret-with-at-least-24-characters';

function fixture({ now = 1_000, code = 12345678 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'feagle-android-pairing-'));
  let clock = now;
  let tokenIndex = 0;
  const store = new AndroidPairingStore({
    path: join(directory, 'pairing.sqlite'),
    secret: SECRET,
    now: () => clock,
    randomCode: () => code,
    randomToken: () => `device-token-${String(++tokenIndex).padStart(32, '0')}`,
  });
  return {
    store,
    advance(milliseconds) {
      clock += milliseconds;
    },
  };
}

test('pairing code is single-use and stores only token authentication state', (t) => {
  const { store } = fixture();
  t.after(() => store.close());
  const pairing = store.createCode();
  assert.equal(pairing.code, '12345678');

  const redeemed = store.redeemCode(pairing.code, 'device-one');
  assert.equal(redeemed.deviceId, 'device-one');
  assert.ok(redeemed.token.length >= 32);
  assert.equal(store.authenticateToken(redeemed.token), 'device-one');
  assert.equal(store.redeemCode(pairing.code, 'device-two'), null);
  assert.equal(store.devices()[0].deviceId, 'device-one');
});

test('creating a new code invalidates previous unused codes', (t) => {
  let nextCode = 11111111;
  const directory = mkdtempSync(join(tmpdir(), 'feagle-android-pairing-'));
  const store = new AndroidPairingStore({
    path: join(directory, 'pairing.sqlite'),
    secret: SECRET,
    randomCode: () => nextCode,
  });
  t.after(() => store.close());
  const first = store.createCode();
  nextCode = 22222222;
  const second = store.createCode();
  assert.equal(store.redeemCode(first.code, 'device-one'), null);
  assert.ok(store.redeemCode(second.code, 'device-one'));
});

test('expired codes fail closed and device tokens can be revoked', (t) => {
  const fixtureState = fixture();
  const { store } = fixtureState;
  t.after(() => store.close());
  const expired = store.createCode(60_000);
  fixtureState.advance(60_001);
  assert.equal(store.redeemCode(expired.code, 'device-one'), null);

  const active = store.createCode();
  const redeemed = store.redeemCode(active.code, 'device-one');
  assert.equal(store.authenticateToken(redeemed.token), 'device-one');
  assert.equal(store.revokeDevice('device-one'), true);
  assert.equal(store.authenticateToken(redeemed.token), null);
});

test('rotating one device token invalidates its previous token', (t) => {
  let nextCode = 33333333;
  const directory = mkdtempSync(join(tmpdir(), 'feagle-android-pairing-'));
  let tokenIndex = 0;
  const store = new AndroidPairingStore({
    path: join(directory, 'pairing.sqlite'),
    secret: SECRET,
    randomCode: () => nextCode,
    randomToken: () => `rotated-token-${String(++tokenIndex).padStart(32, '0')}`,
  });
  t.after(() => store.close());
  const firstCode = store.createCode();
  const first = store.redeemCode(firstCode.code, 'device-one');
  nextCode = 44444444;
  const secondCode = store.createCode();
  const second = store.redeemCode(secondCode.code, 'device-one');
  assert.equal(store.authenticateToken(first.token), null);
  assert.equal(store.authenticateToken(second.token), 'device-one');
});
