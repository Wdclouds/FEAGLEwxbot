const FEISHU_API = 'https://open.feishu.cn/open-apis';
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_QR_COOLDOWN_MS = 10 * 60_000;
const VALID_RECEIVE_ID_TYPES = new Set([
  'open_id',
  'user_id',
  'union_id',
  'email',
  'chat_id',
]);

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function responseJson(response) {
  try {
    return await response.json();
  } catch {
    throw new Error(`Feishu API returned invalid JSON (HTTP ${response.status})`);
  }
}

function apiError(action, response, payload) {
  const code = payload?.code ?? response.status;
  const message = String(payload?.msg || response.statusText || 'unknown error').slice(0, 200);
  const error = new Error(`${action} failed (${code}): ${message}`);
  error.code = 'FEISHU_API_ERROR';
  error.feishuCode = payload?.code;
  error.httpStatus = response.status;
  return error;
}

export function decodeImageDataUrl(dataUrl) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=\s]+)$/.exec(
    String(dataUrl || ''),
  );
  if (!match) throw new TypeError('Invalid QR image data URL');
  const bytes = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  if (!bytes.length) throw new TypeError('QR image is empty');
  return { mimeType: match[1], bytes };
}

export class FeishuNotifier {
  constructor({
    state,
    appId = process.env.FEISHU_APP_ID,
    appSecret = process.env.FEISHU_APP_SECRET,
    receiveId = process.env.FEISHU_RECEIVE_ID,
    receiveIdType = process.env.FEISHU_RECEIVE_ID_TYPE || 'email',
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    requestTimeoutMs = positiveInteger(process.env.FEISHU_REQUEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    qrCooldownMs = positiveInteger(process.env.FEISHU_QR_COOLDOWN_MS, DEFAULT_QR_COOLDOWN_MS),
  }) {
    this.state = state;
    this.appId = String(appId || '').trim();
    this.appSecret = String(appSecret || '').trim();
    this.receiveId = String(receiveId || '').trim();
    this.receiveIdType = String(receiveIdType || '').trim();
    this.fetch = fetchImpl;
    this.now = now;
    this.requestTimeoutMs = requestTimeoutMs;
    this.qrCooldownMs = qrCooldownMs;
    this.credentialsConfigured = Boolean(this.appId && this.appSecret);
    this.enabled = Boolean(
      this.credentialsConfigured
      && this.receiveId
      && VALID_RECEIVE_ID_TYPES.has(this.receiveIdType),
    );
    this.token = '';
    this.tokenExpiresAt = 0;
    this.queue = Promise.resolve();
    this.started = false;
    this.incidentActive = false;
    this.previousWechatStatus = null;
    this.previousProtocolHealth = null;
    this.lastQrCreatedAt = '';
    this.lastQrNotifiedAt = 0;
    this.qrNotificationSentForIncident = false;
    this.manualReloginActive = false;
    this.onSnapshot = (snapshot) => this.observe(snapshot);
  }

  start() {
    if (this.started) return;
    this.started = true;
    if (!this.credentialsConfigured) {
      this.state.patch('notifications', {
        status: 'DISABLED',
        detail: '飞书 App 凭证配置不完整',
      });
      return;
    }

    const snapshot = this.state.snapshot();
    this.previousWechatStatus = snapshot.wechat.status;
    this.previousProtocolHealth = snapshot.wechat.protocolHealth;
    this.state.on('snapshot', this.onSnapshot);
    this.state.patch('notifications', {
      status: this.enabled ? 'READY' : 'WAITING_BIND',
      bindingStatus: this.enabled ? 'BOUND' : 'UNBOUND',
      detail: this.enabled
        ? `飞书私聊通知已启用（${this.receiveIdType}）`
        : '等待在飞书私聊发送“绑定”',
    });
    if (
      this.enabled
      && snapshot.wechat.adminMode !== 'MANUAL_OFFLINE'
      && snapshot.wechat.qrDataUrl
      && snapshot.wechat.qrCreatedAt
    ) {
      this.queueQrNotification(snapshot);
    }
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    this.state.off('snapshot', this.onSnapshot);
  }

  setRecipient(receiveIdType, receiveId) {
    const normalizedType = String(receiveIdType || '').trim();
    const normalizedId = String(receiveId || '').trim();
    if (!VALID_RECEIVE_ID_TYPES.has(normalizedType) || !normalizedId) {
      throw new TypeError('Invalid Feishu recipient');
    }
    this.receiveIdType = normalizedType;
    this.receiveId = normalizedId;
    this.enabled = this.credentialsConfigured;
    if (this.started) {
      this.state.patch('notifications', {
        status: 'READY',
        bindingStatus: 'BOUND',
        detail: `飞书私聊通知已绑定（${normalizedType}）`,
      });
      const snapshot = this.state.snapshot();
      if (
        snapshot.wechat.adminMode !== 'MANUAL_OFFLINE'
        && snapshot.wechat.qrDataUrl
        && snapshot.wechat.qrCreatedAt
      ) {
        this.queueQrNotification(snapshot);
      }
    }
  }

  observe(snapshot) {
    if (!this.enabled || !this.started) return;
    const {
      status,
      protocolHealth,
      qrDataUrl,
      qrCreatedAt,
      adminMode,
    } = snapshot.wechat;

    if (adminMode === 'MANUAL_OFFLINE') {
      this.incidentActive = false;
      this.manualReloginActive = false;
      this.lastQrCreatedAt = '';
      this.lastQrNotifiedAt = 0;
      this.qrNotificationSentForIncident = false;
      this.previousWechatStatus = status;
      this.previousProtocolHealth = protocolHealth;
      return;
    }

    const newlyUnavailable = (
      ['DEGRADED', 'ERROR', 'LOGGED_OUT'].includes(status)
      && status !== this.previousWechatStatus
    ) || (
      this.previousProtocolHealth === 'HEALTHY'
      && ['STALE', 'RECOVERING', 'FAILED'].includes(protocolHealth)
    );

    if (newlyUnavailable && !this.incidentActive && !this.manualReloginActive) {
      this.incidentActive = true;
      this.qrNotificationSentForIncident = false;
      void this.enqueue('ALERT', () => this.sendText(
        `⚠️ Feagle WxBot 微信连接异常\n状态：${status} / ${protocolHealth}\n系统正在自动恢复；若 Session 失效，稍后会发送登录二维码。`,
      )).catch(() => {});
    }

    if (
      qrDataUrl
      && qrCreatedAt
      && qrCreatedAt !== this.lastQrCreatedAt
    ) {
      this.queueQrNotification(snapshot);
    }

    if (
      protocolHealth === 'HEALTHY'
      && this.previousProtocolHealth !== 'HEALTHY'
      && this.incidentActive
      && !this.manualReloginActive
    ) {
      this.incidentActive = false;
      this.qrNotificationSentForIncident = false;
      void this.enqueue('RECOVERED', () => this.sendText(
        '✅ Feagle WxBot 微信连接已恢复，协议同步正常。',
      )).catch(() => {});
    }

    this.previousWechatStatus = status;
    this.previousProtocolHealth = protocolHealth;
  }

  queueQrNotification(snapshot) {
    if (snapshot.wechat.adminMode === 'MANUAL_OFFLINE') return;
    this.lastQrCreatedAt = snapshot.wechat.qrCreatedAt;
    if (this.qrNotificationSentForIncident) return;
    if (
      this.lastQrNotifiedAt
      && this.now() - this.lastQrNotifiedAt < this.qrCooldownMs
    ) return;
    this.lastQrNotifiedAt = this.now();
    this.qrNotificationSentForIncident = true;
    this.incidentActive = true;
    const qrDataUrl = snapshot.wechat.qrDataUrl;
    void this.enqueue('LOGIN_QR', async () => {
      await this.sendText(
        '🔐 Feagle WxBot 微信登录已失效，需要重新扫码。下面的二维码约 2 分钟内有效。',
      );
      await this.sendImage(qrDataUrl);
    }).catch(() => {
      this.lastQrNotifiedAt = 0;
      this.qrNotificationSentForIncident = false;
    });
  }

  enqueue(type, task) {
    const run = async () => {
      this.state.patch('notifications', {
        status: 'SENDING',
        detail: `正在发送 ${type}`,
      });
      try {
        await task();
        this.state.patch('notifications', {
          status: 'READY',
          lastSentAt: new Date(this.now()).toISOString(),
          lastType: type,
          detail: `${type} 已发送到飞书私聊`,
        });
        return this.state.snapshot();
      } catch (error) {
        this.state.patch('notifications', {
          status: 'ERROR',
          failures: this.state.notifications.failures + 1,
          detail: String(error?.message || error).slice(0, 200),
        });
        this.state.addError('feishu-notifier', error);
        throw error;
      }
    };
    const pending = this.queue.then(run, run);
    this.queue = pending.catch(() => {});
    return pending;
  }

  async sendTest() {
    if (!this.enabled) {
      throw new Error('Feishu notification configuration is incomplete');
    }
    const snapshot = this.state.snapshot();
    return this.enqueue('TEST', async () => {
      await this.sendText(
        `✅ Feagle WxBot 飞书通知测试成功\n微信：${snapshot.wechat.status} / ${snapshot.wechat.protocolHealth}\nAstrBot：${snapshot.astrbot.status}\nOneBot：${snapshot.onebot.status}`,
      );
      if (snapshot.wechat.qrDataUrl) await this.sendImage(snapshot.wechat.qrDataUrl);
    });
  }

  async sendGroupFuseAlert({
    groupId,
    groupName = '微信群',
    reason = 'PIPELINE_FAILURE',
    untilAt = '',
  }) {
    if (!this.enabled) return this.state.snapshot();
    const reasonText = reason === 'RATE_ANOMALY'
      ? '短时间频率异常'
      : '连续处理或发送失败';
    return this.enqueue('GROUP_FUSE', () => this.sendText(
      `🧯 Feagle WxBot 群聊自动熔断\n群聊：${groupName}（${groupId}）\n原因：${reasonText}\n暂停回复至：${untilAt || '冷却结束'}\n微信私聊与其他群不受影响。`,
    ));
  }

  beginReloginTest() {
    if (!this.enabled) {
      throw new Error('Feishu notification configuration is incomplete');
    }
    if (this.manualReloginActive) {
      throw new Error('A relogin notification test is already running');
    }
    this.manualReloginActive = true;
    this.incidentActive = true;
    this.lastQrCreatedAt = '';
    this.lastQrNotifiedAt = 0;
    this.qrNotificationSentForIncident = false;
  }

  cancelReloginTest() {
    this.manualReloginActive = false;
    this.incidentActive = false;
    this.qrNotificationSentForIncident = false;
  }

  finishReloginTest({ success, account = '', detail = '' }) {
    if (!this.manualReloginActive) return Promise.resolve(this.state.snapshot());
    this.manualReloginActive = false;
    this.incidentActive = !success;
    const type = success ? 'LOGIN_SUCCESS' : 'LOGIN_FAILED';
    const text = success
      ? `✅ Feagle WxBot 强制重登录测试成功\n微信账号：${account || 'WeChat'}\n协议同步：HEALTHY`
      : `❌ Feagle WxBot 强制重登录测试失败\n原因：${detail || '未知错误'}\n系统会继续等待登录；同一轮登录不会重复推送二维码。`;
    return this.enqueue(type, () => this.sendText(text));
  }

  async getToken(forceRefresh = false) {
    if (
      !forceRefresh
      && this.token
      && this.tokenExpiresAt - TOKEN_REFRESH_MARGIN_MS > this.now()
    ) {
      return this.token;
    }

    const response = await this.fetch(`${FEISHU_API}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        app_id: this.appId,
        app_secret: this.appSecret,
      }),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    const payload = await responseJson(response);
    if (!response.ok || payload.code !== 0 || !payload.tenant_access_token) {
      throw apiError('Feishu authentication', response, payload);
    }
    this.token = payload.tenant_access_token;
    this.tokenExpiresAt = this.now() + positiveInteger(payload.expire, 7_200) * 1_000;
    return this.token;
  }

  async authorizedRequest(path, options) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.getToken(attempt > 0);
      const response = await this.fetch(`${FEISHU_API}${path}`, {
        ...options,
        headers: {
          ...options.headers,
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      const payload = await responseJson(response);
      const tokenRejected = response.status === 401
        || [99991663, 99991664, 99991668].includes(payload?.code);
      if (tokenRejected && attempt === 0) continue;
      if (!response.ok || payload.code !== 0) {
        throw apiError('Feishu request', response, payload);
      }
      return payload;
    }
    throw new Error('Feishu authentication retry exhausted');
  }

  async sendText(text) {
    const query = new URLSearchParams({ receive_id_type: this.receiveIdType });
    await this.authorizedRequest(`/im/v1/messages?${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        receive_id: this.receiveId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      }),
    });
  }

  async sendImage(dataUrl) {
    const { mimeType, bytes } = decodeImageDataUrl(dataUrl);
    const form = new FormData();
    form.append('image_type', 'message');
    form.append('image', new Blob([bytes], { type: mimeType }), 'wechat-login.png');
    const uploaded = await this.authorizedRequest('/im/v1/images', {
      method: 'POST',
      body: form,
    });
    const imageKey = uploaded?.data?.image_key;
    if (!imageKey) throw new Error('Feishu image upload returned no image_key');

    const query = new URLSearchParams({ receive_id_type: this.receiveIdType });
    await this.authorizedRequest(`/im/v1/messages?${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        receive_id: this.receiveId,
        msg_type: 'image',
        content: JSON.stringify({ image_key: imageKey }),
      }),
    });
  }
}
