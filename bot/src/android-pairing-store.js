import {
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_TTL_MS = 5 * 60_000;

function validDeviceId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 128
    && /^[A-Za-z0-9._:-]+$/.test(value);
}

export class AndroidPairingStore {
  constructor({
    path = '/app/data/android/pairing.sqlite',
    secret,
    now = () => Date.now(),
    randomCode = () => randomInt(0, 100_000_000),
    randomToken = () => randomBytes(32).toString('base64url'),
  } = {}) {
    this.secret = String(secret || '');
    if (this.secret.length < 24) {
      throw new Error('Android pairing secret must contain at least 24 characters');
    }
    this.now = now;
    this.randomCode = randomCode;
    this.randomToken = randomToken;
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS android_pairing_codes (
        code_hash TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS android_paired_devices (
        device_id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        rotated_at INTEGER NOT NULL,
        last_seen_at INTEGER,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_android_pairing_expiry
        ON android_pairing_codes(expires_at);
      CREATE INDEX IF NOT EXISTS idx_android_device_token
        ON android_paired_devices(token_hash);
    `);
  }

  digest(kind, value) {
    return createHmac('sha256', this.secret)
      .update(`${kind}\u0000${String(value || '')}`)
      .digest('hex');
  }

  createCode(ttlMs = DEFAULT_TTL_MS) {
    const lifetime = Math.max(60_000, Math.min(Number(ttlMs), 15 * 60_000));
    const now = this.now();
    const code = String(this.randomCode()).padStart(8, '0');
    if (!/^\d{8}$/.test(code)) {
      throw new Error('Pairing code generator returned an invalid value');
    }
    const expiresAt = now + lifetime;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Only one pairing window may be active. Removing old rows also avoids
      // retaining short-code metadata after it is no longer useful.
      this.db.exec('DELETE FROM android_pairing_codes');
      this.db.prepare(`
        INSERT INTO android_pairing_codes
          (code_hash, created_at, expires_at, consumed_at)
        VALUES (?, ?, ?, NULL)
      `).run(this.digest('code', code), now, expiresAt);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { code, expiresAt };
  }

  redeemCode(codeValue, deviceIdValue) {
    const code = String(codeValue || '').trim();
    const deviceId = String(deviceIdValue || '').trim();
    if (!/^\d{8}$/.test(code) || !validDeviceId(deviceId)) return null;

    const now = this.now();
    const codeHash = this.digest('code', code);
    const token = this.randomToken();
    if (typeof token !== 'string' || token.length < 32) {
      throw new Error('Device token generator returned an invalid value');
    }
    const tokenHash = this.digest('token', token);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const codeRow = this.db.prepare(`
        SELECT expires_at, consumed_at
        FROM android_pairing_codes
        WHERE code_hash = ?
      `).get(codeHash);
      if (
        !codeRow
        || codeRow.consumed_at !== null
        || Number(codeRow.expires_at) < now
      ) {
        this.db.exec('ROLLBACK');
        return null;
      }

      const consumed = this.db.prepare(`
        UPDATE android_pairing_codes
        SET consumed_at = ?
        WHERE code_hash = ? AND consumed_at IS NULL AND expires_at >= ?
      `).run(now, codeHash, now);
      if (Number(consumed.changes) !== 1) {
        this.db.exec('ROLLBACK');
        return null;
      }

      this.db.prepare(`
        INSERT INTO android_paired_devices
          (device_id, token_hash, created_at, rotated_at, last_seen_at, revoked_at)
        VALUES (?, ?, ?, ?, NULL, NULL)
        ON CONFLICT(device_id) DO UPDATE SET
          token_hash = excluded.token_hash,
          rotated_at = excluded.rotated_at,
          revoked_at = NULL
      `).run(deviceId, tokenHash, now, now);
      this.db.exec('COMMIT');
      return { deviceId, token };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  authenticateToken(tokenValue) {
    const token = String(tokenValue || '').trim();
    if (token.length < 32) return null;
    const suppliedHash = this.digest('token', token);
    const row = this.db.prepare(`
      SELECT device_id, token_hash
      FROM android_paired_devices
      WHERE token_hash = ? AND revoked_at IS NULL
    `).get(suppliedHash);
    if (!row) return null;
    const actual = Buffer.from(suppliedHash);
    const expected = Buffer.from(String(row.token_hash));
    if (
      actual.length !== expected.length
      || !timingSafeEqual(actual, expected)
    ) return null;
    return String(row.device_id);
  }

  touchDevice(deviceIdValue) {
    const deviceId = String(deviceIdValue || '').trim();
    if (!validDeviceId(deviceId)) return false;
    return Number(this.db.prepare(`
      UPDATE android_paired_devices
      SET last_seen_at = ?
      WHERE device_id = ? AND revoked_at IS NULL
    `).run(this.now(), deviceId).changes) === 1;
  }

  revokeDevice(deviceIdValue) {
    const deviceId = String(deviceIdValue || '').trim();
    if (!validDeviceId(deviceId)) return false;
    return Number(this.db.prepare(`
      UPDATE android_paired_devices
      SET revoked_at = ?
      WHERE device_id = ? AND revoked_at IS NULL
    `).run(this.now(), deviceId).changes) === 1;
  }

  devices() {
    return this.db.prepare(`
      SELECT device_id, created_at, rotated_at, last_seen_at, revoked_at
      FROM android_paired_devices
      ORDER BY created_at
    `).all().map((row) => ({
      deviceId: String(row.device_id),
      createdAt: Number(row.created_at),
      rotatedAt: Number(row.rotated_at),
      lastSeenAt: row.last_seen_at === null ? null : Number(row.last_seen_at),
      revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
    }));
  }

  close() {
    this.db.close();
  }
}
