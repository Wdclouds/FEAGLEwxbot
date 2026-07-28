import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ID_FLOOR = 1_000_000_000;

export class IdMap {
  constructor(path = '/app/data/wechat/mapping.sqlite') {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS entities (
        onebot_id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        protocol_id TEXT NOT NULL,
        stable_key TEXT,
        nickname TEXT,
        last_seen_at TEXT NOT NULL,
        UNIQUE(kind, protocol_id)
      );
      CREATE INDEX IF NOT EXISTS idx_entities_stable
        ON entities(kind, stable_key);
      CREATE TABLE IF NOT EXISTS messages (
        onebot_message_id INTEGER PRIMARY KEY AUTOINCREMENT,
        wechat_message_id TEXT NOT NULL,
        event_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS message_receipts (
        wechat_message_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_message_receipts_created
        ON message_receipts(created_at);
    `);
  }

  entity(kind, protocolId, stableKey = '', nickname = '') {
    const now = new Date().toISOString();
    let row = this.db.prepare(
      'SELECT onebot_id FROM entities WHERE kind = ? AND protocol_id = ?',
    ).get(kind, protocolId);

    if (!row && stableKey) {
      row = this.db.prepare(
        'SELECT onebot_id FROM entities WHERE kind = ? AND stable_key = ?',
      ).get(kind, stableKey);
    }

    if (row) {
      this.db.prepare(`
        UPDATE entities
        SET protocol_id = ?, stable_key = ?, nickname = ?, last_seen_at = ?
        WHERE onebot_id = ?
      `).run(protocolId, stableKey || null, nickname || null, now, row.onebot_id);
      return Number(row.onebot_id);
    }

    const maxRow = this.db.prepare(
      'SELECT COALESCE(MAX(onebot_id), ?) AS max_id FROM entities',
    ).get(ID_FLOOR);
    const onebotId = Number(maxRow.max_id) + 1;
    this.db.prepare(`
      INSERT INTO entities
        (onebot_id, kind, protocol_id, stable_key, nickname, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      onebotId,
      kind,
      protocolId,
      stableKey || null,
      nickname || null,
      now,
    );
    return onebotId;
  }

  protocolId(onebotId, kind = 'user') {
    const row = this.db.prepare(
      'SELECT protocol_id FROM entities WHERE onebot_id = ? AND kind = ?',
    ).get(Number(onebotId), kind);
    return row?.protocol_id || null;
  }

  contact(onebotId) {
    return this.db.prepare(`
      SELECT onebot_id, protocol_id, nickname
      FROM entities WHERE onebot_id = ?
    `).get(Number(onebotId)) || null;
  }

  contacts(kind = 'user') {
    return this.db.prepare(`
      SELECT onebot_id, protocol_id, nickname
      FROM entities WHERE kind = ?
      ORDER BY nickname, onebot_id
    `).all(kind);
  }

  storeMessage(wechatMessageId, event) {
    const result = this.db.prepare(`
      INSERT INTO messages (wechat_message_id, event_json, created_at)
      VALUES (?, ?, ?)
    `).run(
      String(wechatMessageId || ''),
      JSON.stringify(event),
      new Date().toISOString(),
    );
    return Number(result.lastInsertRowid);
  }

  updateMessage(onebotMessageId, event) {
    this.db.prepare(
      'UPDATE messages SET event_json = ? WHERE onebot_message_id = ?',
    ).run(JSON.stringify(event), Number(onebotMessageId));
  }

  message(onebotMessageId) {
    const row = this.db.prepare(
      'SELECT event_json FROM messages WHERE onebot_message_id = ?',
    ).get(Number(onebotMessageId));
    return row ? JSON.parse(row.event_json) : null;
  }

  claimMessage(wechatMessageId, kind = 'private') {
    const messageId = String(wechatMessageId || '').trim();
    if (!messageId) return true;
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO message_receipts
        (wechat_message_id, kind, status, created_at, updated_at)
      VALUES (?, ?, 'RECEIVED', ?, ?)
    `).run(messageId, kind, now, now);
    return Number(result.changes) === 1;
  }

  updateMessageReceipt(wechatMessageId, status) {
    const messageId = String(wechatMessageId || '').trim();
    if (!messageId) return;
    this.db.prepare(`
      UPDATE message_receipts
      SET status = ?, updated_at = ?
      WHERE wechat_message_id = ?
    `).run(String(status || 'UNKNOWN'), new Date().toISOString(), messageId);
  }

  pruneMessageReceipts(retentionMs = 7 * 24 * 60 * 60_000) {
    const cutoff = new Date(Date.now() - retentionMs).toISOString();
    return Number(this.db.prepare(
      'DELETE FROM message_receipts WHERE created_at < ?',
    ).run(cutoff).changes);
  }

  close() {
    this.db.close();
  }
}
