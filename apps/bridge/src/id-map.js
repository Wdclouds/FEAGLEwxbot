import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveDataPath } from './paths.js';

const ID_FLOOR = 1_000_000_000;

export class IdMap {
  constructor(path = resolveDataPath('wechat/mapping.sqlite')) {
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
      CREATE INDEX IF NOT EXISTS idx_messages_wechat_id
        ON messages(wechat_message_id);
      CREATE TABLE IF NOT EXISTS message_receipts (
        wechat_message_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_message_receipts_created
        ON message_receipts(created_at);
      CREATE TABLE IF NOT EXISTS contacts (
        talker TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('group','private')),
        name TEXT NOT NULL,
        avatar_base64 TEXT NOT NULL DEFAULT '',
        member_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
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

  /** 列出已知群实体（Dashboard 重启后恢复群列表用，group 实体已持久化）。 */
  listGroups() {
    const rows = this.db.prepare(`
      SELECT onebot_id, protocol_id, nickname, last_seen_at
      FROM entities WHERE kind = ?
      ORDER BY last_seen_at DESC
    `).all('group');
    return rows.map((row) => ({
      groupId: String(row.onebot_id),
      protocolId: String(row.protocol_id),
      name: String(row.nickname || '微信群').slice(0, 80),
      lastSeenAt: String(row.last_seen_at || ''),
    }));
  }

  contacts(kind = 'user') {
    return this.db.prepare(`
      SELECT onebot_id, protocol_id, nickname
      FROM entities WHERE kind = ?
      ORDER BY nickname, onebot_id
    `).all(kind);
  }

  /**
   * 静默联系人同步（2026-08-13）：以 Agent 的完整快照为唯一事实源，
   * 一次事务内完成 插入/更新/物理删除，全部成功才 COMMIT，否则 ROLLBACK。
   *
   * 快照必须是完整快照（full === true 才执行删除；否则只做 upsert）。
   * 快照校验失败、解析失败、事务失败时抛错，contacts 表保持原状——
   * 不触碰 entities（OneBot 数字 ID 映射）、messages、message_receipts，
   * 避免旧消息引用失效。
   *
   * @param {object} snapshot { generatedAt, groups, privates, full }
   * @param {{afterStage?: () => void}} [options] afterStage 仅在事务内
   *   staged 完成后、COMMIT 前调用（测试注入事务失败用）。
   * @returns {{inserted: number, updated: number, deleted: number}}
   */
  syncContacts(snapshot, { afterStage } = {}) {
    const { groups, privates, full } = normalizeContactsSnapshot(snapshot);
    const rows = [
      ...groups.map((row) => ({ ...row, kind: 'group' })),
      ...privates.map((row) => ({ ...row, kind: 'private' })),
    ];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let inserted = 0;
      let updated = 0;
      const exists = this.db.prepare(
        'SELECT 1 AS one FROM contacts WHERE talker = ?',
      );
      const upsert = this.db.prepare(`
        INSERT INTO contacts (talker, kind, name, avatar_base64, member_count, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(talker) DO UPDATE SET
          kind = excluded.kind,
          name = excluded.name,
          avatar_base64 = excluded.avatar_base64,
          member_count = excluded.member_count,
          updated_at = excluded.updated_at
      `);
      const now = new Date().toISOString();
      for (const row of rows) {
        const previous = exists.get(row.talker);
        upsert.run(
          row.talker,
          row.kind,
          row.name,
          row.avatarBase64,
          row.memberCount,
          now,
        );
        if (previous) updated += 1;
        else inserted += 1;
      }
      let deleted = 0;
      if (full) {
        const keep = new Set(rows.map((row) => row.talker));
        const existing = this.db.prepare(
          'SELECT talker FROM contacts',
        ).all();
        const remove = this.db.prepare(
          'DELETE FROM contacts WHERE talker = ?',
        );
        for (const row of existing) {
          const talker = String(row.talker);
          if (keep.has(talker)) continue;
          deleted += Number(remove.run(talker).changes);
        }
      }
      if (typeof afterStage === 'function') afterStage();
      this.db.exec('COMMIT');
      return { inserted, updated, deleted };
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // 事务可能已被 SQLite 自动回滚，忽略
      }
      throw error;
    }
  }

  /** 列出联系人展示表全部行（talker 稳定主键；不用于身份映射）。 */
  listContacts() {
    return this.db.prepare(`
      SELECT talker, kind, name, avatar_base64, member_count, updated_at
      FROM contacts
      ORDER BY kind, name, talker
    `).all().map((row) => ({
      talker: String(row.talker),
      kind: String(row.kind),
      name: String(row.name),
      avatarBase64: String(row.avatar_base64 || ''),
      memberCount: Number(row.member_count || 0),
      updatedAt: String(row.updated_at || ''),
    }));
  }

  storeMessage(wechatMessageId, event) {
    const normalizedMessageId = String(wechatMessageId || '');
    if (normalizedMessageId) {
      const existing = this.db.prepare(
        'SELECT onebot_message_id FROM messages WHERE wechat_message_id = ? ORDER BY onebot_message_id LIMIT 1',
      ).get(normalizedMessageId);
      if (existing) {
        this.updateMessage(existing.onebot_message_id, event);
        return Number(existing.onebot_message_id);
      }
    }
    const result = this.db.prepare(`
      INSERT INTO messages (wechat_message_id, event_json, created_at)
      VALUES (?, ?, ?)
    `).run(
      normalizedMessageId,
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

  messageReceipt(wechatMessageId) {
    const messageId = String(wechatMessageId || '').trim();
    if (!messageId) return null;
    return this.db.prepare(`
      SELECT wechat_message_id, kind, status, created_at, updated_at
      FROM message_receipts
      WHERE wechat_message_id = ?
    `).get(messageId) || null;
  }

  releaseMessageReceipt(wechatMessageId) {
    const messageId = String(wechatMessageId || '').trim();
    if (!messageId) return false;
    const result = this.db.prepare(`
      DELETE FROM message_receipts
      WHERE wechat_message_id = ? AND status = 'RECEIVED'
    `).run(messageId);
    return Number(result.changes) === 1;
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

const CONTACT_NAME_MAX = 80;
const CONTACT_AVATAR_MAX = 512_000;

function normalizeContactsSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new TypeError('contacts_snapshot 必须是对象');
  }
  const generatedAt = typeof snapshot.generatedAt === 'string'
    ? snapshot.generatedAt.trim()
    : '';
  if (!generatedAt || Number.isNaN(Date.parse(generatedAt))) {
    throw new Error('contacts_snapshot 缺少有效的 generatedAt');
  }
  if (!Array.isArray(snapshot.groups)) {
    throw new Error('contacts_snapshot 缺少 groups 数组');
  }
  // 通讯录定义：privateContacts（rcontact 个人联系人）；legacy privates 兼容
  const privateEntries = Array.isArray(snapshot.privateContacts)
    ? snapshot.privateContacts
    : (Array.isArray(snapshot.privates) ? snapshot.privates : null);
  if (privateEntries === null) {
    throw new Error('contacts_snapshot 缺少 privateContacts 数组');
  }
  return {
    generatedAt,
    groups: normalizeContactRows(snapshot.groups, 'group'),
    privates: normalizeContactRows(privateEntries, 'private'),
    full: snapshot.full === true,
  };
}

function normalizeContactRows(entries, kind) {
  const seen = new Set();
  const rows = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      throw new TypeError(`contacts_snapshot ${kind} 行必须是对象`);
    }
    const talker = String(entry.talker || '').trim();
    if (!validSnapshotTalker(talker, kind)) {
      throw new Error(`contacts_snapshot ${kind} talker 非法: ${preview(talker)}`);
    }
    if (seen.has(talker)) continue; // 去重，保留首个
    seen.add(talker);
    const name = String(entry.name ?? '').replace(/\s+/g, ' ').trim()
      .slice(0, CONTACT_NAME_MAX) || (kind === 'group' ? '微信群' : '联系人');
    const avatarBase64 = typeof entry.avatarBase64 === 'string'
      ? entry.avatarBase64.slice(0, CONTACT_AVATAR_MAX)
      : '';
    const memberCount = Number(entry.memberCount);
    rows.push({
      talker,
      name,
      avatarBase64,
      memberCount: Number.isInteger(memberCount) && memberCount >= 0
        ? memberCount
        : 0,
    });
  }
  return rows;
}

function validSnapshotTalker(talker, kind) {
  if (typeof talker !== 'string' || talker.length === 0 || talker.length > 256) {
    return false;
  }
  const lower = talker.toLocaleLowerCase();
  if (kind === 'group') {
    return lower.endsWith('@chatroom') && !lower.includes(':');
  }
  return !lower.endsWith('@chatroom')
    && !lower.endsWith('@openim')
    && !lower.startsWith('gh_')
    && !['filehelper', 'newsapp', 'fmessage', 'weixin'].includes(lower)
    && !lower.includes(':');
}

function preview(value) {
  const text = String(value || '');
  return text.length > 24 ? `${text.slice(0, 24)}...` : text;
}
