import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Wechat = require('wechat4u');
const { getDeviceID } = require('wechat4u/lib/util/global');

const NETWORK_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
]);

export class SessionInvalidError extends Error {
  constructor(message = '微信 Session 已失效') {
    super(message);
    this.name = 'SessionInvalidError';
    this.code = 'WECHAT_SESSION_INVALID';
  }
}

function responseRetcode(error) {
  const data = error?.response?.data;
  if (data && typeof data === 'object') {
    const value = data.BaseResponse?.Ret ?? data.retcode ?? data.Ret;
    if (value !== undefined) return Number(value);
  }
  if (typeof data === 'string') {
    const match = data.match(/retcode\s*:\s*["']?(\d+)["']?/i);
    if (match) return Number(match[1]);
  }
  return null;
}

export function isSessionInvalidError(error) {
  return error instanceof SessionInvalidError
    || error?.name === 'AlreadyLogoutError'
    || error?.constructor?.name === 'AlreadyLogoutError'
    || error?.code === 'WECHAT_SESSION_INVALID'
    || responseRetcode(error) === 1101;
}

export function isTransientWechatError(error) {
  const status = Number(error?.response?.status || 0);
  return NETWORK_ERROR_CODES.has(error?.code)
    || error?.code === 'WECHAT_SYNC_PARSE'
    || status === 408
    || status === 429
    || status >= 500;
}

export function parseSyncCheckResponse(value) {
  const raw = String(value ?? '').trim();
  const envelope = raw.match(/^window\.synccheck\s*=\s*\{([^}]+)\}\s*;?$/i);
  const payload = envelope?.[1] || '';
  const retcodeMatch = payload.match(/retcode\s*:\s*["']?(\d+)["']?/i);
  const selectorMatch = payload.match(/selector\s*:\s*["']?(\d+)["']?/i);
  if (!retcodeMatch || !selectorMatch) {
    const error = new Error('无法严格解析微信同步响应');
    error.code = 'WECHAT_SYNC_PARSE';
    throw error;
  }

  const retcode = Number(retcodeMatch[1]);
  const selector = Number(selectorMatch[1]);
  if (retcode === 1101) throw new SessionInvalidError();
  if (retcode !== 0) {
    const error = new Error(`微信同步返回异常状态 ${retcode}`);
    error.code = `WECHAT_SYNC_RETCODE_${retcode}`;
    error.protocolRetcode = retcode;
    throw error;
  }
  return selector;
}

export class ManagedWechat extends Wechat {
  constructor(data) {
    super(data);
    this.managedSyncErrorCount = 0;
    this.destroyed = false;
    const configuredQrTtl = Number(process.env.WECHAT_QR_TTL_MS);
    this.loginTimeoutMs = Number.isInteger(configuredQrTtl) && configuredQrTtl > 0
      ? configuredQrTtl
      : 120_000;
  }

  async start() {
    const uuid = await this.getUUID();
    if (this.destroyed) return;
    this.emit('uuid', uuid);
    this.state = this.CONF.STATE.uuid;

    const deadline = Date.now() + this.loginTimeoutMs;
    let loginConfirmed = false;
    while (!this.destroyed && Date.now() < deadline) {
      const result = await this.checkLogin();
      if (this.destroyed) return;
      if (result.code === 201 && result.userAvatar) {
        this.emit('user-avatar', result.userAvatar);
      }
      if (result.code === 200) {
        await this.login();
        loginConfirmed = true;
        break;
      }
    }
    if (this.destroyed) return;
    if (!loginConfirmed) {
      const error = new Error('微信登录二维码已过期');
      error.code = 'WECHAT_QR_EXPIRED';
      throw error;
    }
    await this._init();
    return true;
  }

  async restart() {
    return this._init();
  }

  async _init() {
    const data = await this.init();
    if (this.destroyed) {
      const error = new Error('Wechat4u 实例已被本地销毁');
      error.code = 'WECHAT_INSTANCE_DESTROYED';
      throw error;
    }

    this.updateContacts(data.ContactList);
    this.notifyMobile().catch((error) => this.emit('maintenance-error', error));
    this._getContact().then((contacts) => {
      if (!this.destroyed) this.updateContacts(contacts);
    });
    this.emit('init', data);
    this.state = this.CONF.STATE.login;
    this.lastSyncTime = Date.now();
    void this.syncPolling();
    this.checkPolling();
    this.emit('login');
    return data;
  }

  async syncCheck() {
    try {
      const response = await this.request({
        method: 'GET',
        url: this.CONF.API_synccheck,
        params: {
          r: Date.now(),
          sid: this.PROP.sid,
          uin: this.PROP.uin,
          skey: this.PROP.skey,
          deviceid: getDeviceID(),
          synckey: this.PROP.formatedSyncKey,
        },
      });
      return parseSyncCheckResponse(response.data);
    } catch (error) {
      error.tips ||= '同步失败';
      throw error;
    }
  }

  async syncPolling(id = ++this.syncPollingId) {
    if (this.state !== this.CONF.STATE.login || this.syncPollingId !== id) return;

    try {
      const selector = await this.syncCheck();
      if (this.state !== this.CONF.STATE.login || this.syncPollingId !== id) return;
      if (selector !== this.CONF.SYNCCHECK_SELECTOR_NORMAL) {
        const data = await this.sync();
        if (this.state !== this.CONF.STATE.login || this.syncPollingId !== id) return;
        this.handleSync(data);
      }

      this.lastSyncTime = Date.now();
      this.managedSyncErrorCount = 0;
      this.emit('protocol-sync', {
        at: this.lastSyncTime,
        selector,
      });
      void this.syncPolling(id);
    } catch (error) {
      if (this.state !== this.CONF.STATE.login || this.syncPollingId !== id) return;
      if (isSessionInvalidError(error)) {
        this.managedLocalStop();
        this.emit('session-invalid', error);
        return;
      }

      this.managedSyncErrorCount += 1;
      error.managedProtocolError = true;
      this.emit('protocol-sync-error', {
        error,
        count: this.managedSyncErrorCount,
        at: Date.now(),
      });
      this.emit('error', error);

      const delay = Math.min(2_000 * this.managedSyncErrorCount, 30_000);
      clearTimeout(this.retryPollingId);
      this.retryPollingId = setTimeout(() => {
        void this.syncPolling(id);
      }, delay);
      this.retryPollingId.unref();
    }
  }

  checkPolling() {
    if (this.state !== this.CONF.STATE.login) return;
    clearTimeout(this.checkPollingId);
    this.checkPollingId = setTimeout(async () => {
      if (this.state !== this.CONF.STATE.login) return;
      try {
        await this.notifyMobile();
      } catch (error) {
        this.emit('maintenance-error', error);
      }
      this.checkPolling();
    }, 4 * 60_000);
    this.checkPollingId.unref();
  }

  managedLocalStop() {
    this.syncPollingId += 1;
    clearTimeout(this.retryPollingId);
    clearTimeout(this.checkPollingId);
    this.state = this.CONF.STATE.logout;
  }

  destroyLocal() {
    this.destroyed = true;
    this.managedLocalStop();
    this.removeAllListeners();
    this.on('error', () => {});
  }

  stop() {
    this.managedLocalStop();
  }
}
