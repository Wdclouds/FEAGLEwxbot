import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

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
        changedAt: '',
      };
    }
    const stored = JSON.parse(readFileSync(this.path, 'utf8'));
    return {
      wechatAdminMode: normalizeWechatAdminMode(stored?.wechatAdminMode),
      changedAt: String(stored?.changedAt || ''),
    };
  }

  save(wechatAdminMode) {
    const mode = normalizeWechatAdminMode(wechatAdminMode);
    if (mode !== wechatAdminMode) {
      throw new TypeError(`Unsupported WeChat admin mode: ${wechatAdminMode}`);
    }
    const snapshot = {
      version: 1,
      wechatAdminMode: mode,
      changedAt: new Date(this.now()).toISOString(),
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
