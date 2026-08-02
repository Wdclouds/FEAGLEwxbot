import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
  GROUP_CHAT_MODES,
  normalizeGroupAllowlist,
  normalizeGroupChatMode,
} from './group-chat.js';
import { normalizeBlockedTerms } from './group-safety.js';

export const WECHAT_ADMIN_MODES = Object.freeze({
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  MANUAL_OFFLINE: 'MANUAL_OFFLINE',
});

const VALID_MODES = new Set(Object.values(WECHAT_ADMIN_MODES));

export function normalizeWechatAdminMode(value) {
  const mode = String(value || '').trim().toUpperCase();
  return VALID_MODES.has(mode) ? mode : WECHAT_ADMIN_MODES.RUNNING;
}

export class PersistentControlState {
  constructor({
    path = '/app/data/control-state.json',
    now = () => Date.now(),
  } = {}) {
    this.path = path;
    this.now = now;
  }

  load() {
    if (!existsSync(this.path)) {
      return {
        wechatAdminMode: WECHAT_ADMIN_MODES.RUNNING,
        groupChatMode: GROUP_CHAT_MODES.OFF,
        groupAllowlist: [],
        groupBlockedTerms: [],
        changedAt: '',
      };
    }
    const stored = JSON.parse(readFileSync(this.path, 'utf8'));
    return {
      wechatAdminMode: normalizeWechatAdminMode(stored?.wechatAdminMode),
      groupChatMode: normalizeGroupChatMode(stored?.groupChatMode),
      groupAllowlist: normalizeGroupAllowlist(stored?.groupAllowlist),
      groupBlockedTerms: normalizeBlockedTerms(stored?.groupBlockedTerms),
      changedAt: String(stored?.changedAt || ''),
    };
  }

  save(wechatAdminMode) {
    const mode = normalizeWechatAdminMode(wechatAdminMode);
    if (mode !== wechatAdminMode) {
      throw new TypeError(`Unsupported WeChat admin mode: ${wechatAdminMode}`);
    }
    const current = this.load();
    return this.write({
      ...current,
      wechatAdminMode: mode,
      changedAt: new Date(this.now()).toISOString(),
    });
  }

  saveGroupChatConfig(groupChatMode, groupAllowlist, groupBlockedTerms = []) {
    const mode = normalizeGroupChatMode(groupChatMode);
    const allowlist = normalizeGroupAllowlist(groupAllowlist);
    const blockedTerms = normalizeBlockedTerms(groupBlockedTerms);
    if (mode !== groupChatMode) {
      throw new TypeError(`Unsupported group chat mode: ${groupChatMode}`);
    }
    const current = this.load();
    return this.write({
      ...current,
      groupChatMode: mode,
      groupAllowlist: allowlist,
      groupBlockedTerms: blockedTerms,
      changedAt: new Date(this.now()).toISOString(),
    });
  }

  write(values) {
    const snapshot = {
      version: 3,
      wechatAdminMode: normalizeWechatAdminMode(values.wechatAdminMode),
      groupChatMode: normalizeGroupChatMode(values.groupChatMode),
      groupAllowlist: normalizeGroupAllowlist(values.groupAllowlist),
      groupBlockedTerms: normalizeBlockedTerms(values.groupBlockedTerms),
      changedAt: String(values.changedAt || new Date(this.now()).toISOString()),
    };
    mkdirSync(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(tempPath, this.path);
    return snapshot;
  }
}
