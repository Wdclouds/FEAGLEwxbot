import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { WECHAT_ADMIN_MODES } from './control-state.js';
import { AndroidPairingStore } from './android-pairing-store.js';

const PROTOCOL = 'feagle.android.v1';
const TERMINAL_RECEIPT_STATUSES = new Set(['FORWARDED', 'DROPPED', 'BLOCKED']);

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function secureEqual(left, right) {
  const actual = Buffer.from(String(left || ''));
  const expected = Buffer.from(String(right || ''));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function bearerToken(header) {
  const match = /^Bearer\s+(.+)$/i.exec(String(header || '').trim());
  return match?.[1] || '';
}

function validIdentifier(value, maxLength = 256) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && /^[A-Za-z0-9._:-]+$/.test(value);
}

function validPrivateTalker(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    return false;
  }
  const lower = value.toLocaleLowerCase();
  const notificationConversation = /^notify:[0-9a-f]{32}$/.test(lower);
  return !lower.endsWith('@chatroom')
    && !lower.endsWith('@openim')
    && !lower.startsWith('gh_')
    && !['filehelper', 'newsapp', 'fmessage', 'weixin'].includes(lower)
    && (!lower.includes(':') || notificationConversation);
}

function displayName(value) {
  const normalized = String(value || '').trim();
  if (
    normalized.length === 0
    || Array.from(normalized).length > 256
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    return 'WeChat contact';
  }
  return normalized;
}

function normalizeTimestamp(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return Date.now();
  return timestamp < 10_000_000_000 ? timestamp * 1_000 : timestamp;
}

export class AndroidWechatClient {
  constructor({
    state,
    idMap,
    isSleeping,
    messageGuard,
    onPrivateText,
    host = process.env.ANDROID_WS_HOST || '0.0.0.0',
    port = positiveInteger(process.env.ANDROID_WS_PORT, 6191),
    path = process.env.ANDROID_WS_PATH || '/android',
    token = process.env.ANDROID_BRIDGE_TOKEN || '',
    deviceId = process.env.ANDROID_DEVICE_ID || '',
    initialAdminMode = WECHAT_ADMIN_MODES.RUNNING,
    heartbeatTimeoutMs = positiveInteger(
      process.env.ANDROID_HEARTBEAT_TIMEOUT_MS,
      75_000,
    ),
    commandTimeoutMs = positiveInteger(
      process.env.ANDROID_COMMAND_TIMEOUT_MS,
      30_000,
    ),
    pairingStore = null,
    pairingDbPath = process.env.ANDROID_PAIRING_DB_PATH
      || '/app/data/android/pairing.sqlite',
    pairingAttemptLimit = positiveInteger(
      process.env.ANDROID_PAIRING_ATTEMPT_LIMIT,
      10,
    ),
    pairingAttemptWindowMs = positiveInteger(
      process.env.ANDROID_PAIRING_ATTEMPT_WINDOW_MS,
      5 * 60_000,
    ),
  }) {
    this.state = state;
    this.idMap = idMap;
    this.isSleeping = isSleeping;
    this.messageGuard = messageGuard;
    this.onPrivateText = onPrivateText;
    this.host = host;
    this.port = port;
    this.path = path.startsWith('/') ? path : `/${path}`;
    this.token = String(token).trim();
    this.allowedDeviceId = String(deviceId).trim();
    this.adminMode = initialAdminMode;
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
    this.commandTimeoutMs = commandTimeoutMs;
    this.pairingStore = pairingStore;
    this.ownsPairingStore = !pairingStore;
    this.pairingDbPath = pairingDbPath;
    this.pairingAttemptLimit = pairingAttemptLimit;
    this.pairingAttemptWindowMs = pairingAttemptWindowMs;
    this.pairingAttempts = new Map();
    this.server = null;
    this.socket = null;
    this.deviceId = '';
    this.selfId = null;
    this.loggedIn = false;
    this.stopping = false;
    this.processingEvents = new Set();
    this.pendingCommands = new Map();
    this.watchdog = null;
  }

  async start() {
    if (this.token.length < 24) {
      throw new Error(
        'ANDROID_BRIDGE_TOKEN is required and must contain at least 24 characters',
      );
    }
    if (!this.pairingStore) {
      this.pairingStore = new AndroidPairingStore({
        path: this.pairingDbPath,
        secret: this.token,
      });
    }
    this.state.patch('wechat', {
      status: 'WAITING_AGENT',
      account: 'Android Hook',
      detail: '等待 Android Agent 连接',
      protocolHealth: 'UNKNOWN',
      qrDataUrl: '',
    });

    this.server = new WebSocketServer({
      host: this.host,
      port: this.port,
      path: this.path,
      maxPayload: 64 * 1024,
      verifyClient: ({ req }, done) => {
        const url = new URL(req.url || this.path, 'ws://localhost');
        if (url.searchParams.get('mode') === 'pair') {
          req.feagleAuth = { pairingOnly: true, deviceId: '' };
          done(true);
          return;
        }
        const supplied = bearerToken(req.headers.authorization);
        if (secureEqual(supplied, this.token)) {
          req.feagleAuth = { pairingOnly: false, deviceId: '' };
          done(true);
          return;
        }
        const authenticatedDeviceId = this.pairingStore.authenticateToken(supplied);
        if (authenticatedDeviceId) {
          req.feagleAuth = {
            pairingOnly: false,
            deviceId: authenticatedDeviceId,
          };
          done(true);
          return;
        }
        done(false, 401, 'Unauthorized');
      },
    });
    this.server.on('connection', (socket, request) => (
      this.handleConnection(socket, request)
    ));
    this.server.on('error', (error) => this.state.addError('android-wss', error));

    await new Promise((resolve, reject) => {
      this.server.once('listening', resolve);
      this.server.once('error', reject);
    });
    this.watchdog = setInterval(() => this.checkHeartbeat(), 15_000);
    this.watchdog.unref();
    console.log(`[Android] Agent WebSocket listening on ${this.host}:${this.port}${this.path}`);
  }

  handleConnection(socket, request) {
    if (this.stopping) {
      socket.close(1012, 'Server stopping');
      return;
    }
    socket.feagle = {
      deviceId: '',
      hookConnected: false,
      lastSeenAt: Date.now(),
      pairingOnly: request?.feagleAuth?.pairingOnly === true,
      authenticatedDeviceId: String(request?.feagleAuth?.deviceId || ''),
      remoteAddress: String(request?.socket?.remoteAddress || 'unknown'),
      pairingTimer: null,
    };
    if (socket.feagle.pairingOnly) {
      socket.feagle.pairingTimer = setTimeout(
        () => socket.close(1008, 'Pairing timeout'),
        30_000,
      );
      socket.feagle.pairingTimer.unref();
    }
    socket.on('message', (raw) => {
      void this.handleMessage(socket, raw);
    });
    socket.on('close', () => {
      if (socket.feagle.pairingTimer) clearTimeout(socket.feagle.pairingTimer);
      this.handleClose(socket);
    });
    socket.on('error', (error) => {
      if (socket === this.socket) this.state.addError('android-agent', error);
    });
  }

  async handleMessage(socket, raw) {
    socket.feagle.lastSeenAt = Date.now();
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      socket.close(1007, 'Invalid JSON');
      return;
    }
    if (message?.protocol !== PROTOCOL || typeof message.type !== 'string') {
      socket.close(1008, 'Invalid protocol');
      return;
    }

    if (socket.feagle.pairingOnly) {
      this.handlePairRequest(socket, message);
      return;
    }

    if (message.type === 'hello') {
      this.handleHello(socket, message);
      return;
    }
    if (!socket.feagle.deviceId || message.deviceId !== socket.feagle.deviceId) {
      socket.close(1008, 'Hello required');
      return;
    }

    switch (message.type) {
      case 'heartbeat':
        this.send(socket, { type: 'pong', timestamp: Date.now() });
        this.markHealthy(socket);
        break;
      case 'hook_status':
        socket.feagle.hookConnected = message.connected === true;
        this.markHealthy(socket);
        break;
      case 'private_text':
        await this.handlePrivateText(socket, message);
        break;
      case 'command_result':
        this.handleCommandResult(message);
        break;
      default:
        socket.close(1008, 'Unsupported message type');
    }
  }

  handleHello(socket, message) {
    const deviceId = String(message.deviceId || '').trim();
    if (!validIdentifier(deviceId, 128)) {
      socket.close(1008, 'Invalid device ID');
      return;
    }
    if (
      socket.feagle.authenticatedDeviceId
      && deviceId !== socket.feagle.authenticatedDeviceId
    ) {
      socket.close(1008, 'Device token mismatch');
      return;
    }
    if (this.allowedDeviceId && deviceId !== this.allowedDeviceId) {
      socket.close(1008, 'Device not allowed');
      return;
    }
    if (this.adminMode === WECHAT_ADMIN_MODES.MANUAL_OFFLINE) {
      socket.close(4001, 'Bridge is manually offline');
      return;
    }
    if (this.socket && this.socket !== socket) {
      this.socket.close(4002, 'Replaced by a newer Agent connection');
    }

    socket.feagle.deviceId = deviceId;
    socket.feagle.hookConnected = message.hookConnected === true;
    this.socket = socket;
    this.deviceId = deviceId;
    if (socket.feagle.authenticatedDeviceId) {
      this.pairingStore.touchDevice(deviceId);
    }
    this.selfId = this.idMap.entity(
      'self',
      `android:${deviceId}`,
      deviceId,
      'Android WeChat',
    );
    this.markHealthy(socket);
    this.send(socket, {
      type: 'hello_ack',
      accepted: true,
      heartbeatTimeoutMs: this.heartbeatTimeoutMs,
    });
  }

  markHealthy(socket) {
    if (socket !== this.socket) return;
    this.loggedIn = socket.feagle.hookConnected;
    this.state.patch('wechat', {
      status: this.loggedIn ? 'ONLINE' : 'WAITING_HOOK',
      account: 'Android Hook',
      detail: this.loggedIn
        ? 'Android Agent 与 Hook 已连接'
        : 'Android Agent 已连接，等待 Hook',
      protocolHealth: 'HEALTHY',
      lastSyncAt: new Date(socket.feagle.lastSeenAt).toISOString(),
      syncAgeMs: 0,
    });
  }

  handlePairRequest(socket, message) {
    if (message.type !== 'pair_request') {
      socket.close(1008, 'Pairing request required');
      return;
    }
    const now = Date.now();
    const key = socket.feagle.remoteAddress;
    if (this.pairingAttempts.size > 1_024) {
      for (const [address, attempts] of this.pairingAttempts) {
        if (!attempts.some(
          (timestamp) => now - timestamp < this.pairingAttemptWindowMs
        )) this.pairingAttempts.delete(address);
      }
    }
    const recent = (this.pairingAttempts.get(key) || [])
      .filter((timestamp) => now - timestamp < this.pairingAttemptWindowMs);
    if (recent.length >= this.pairingAttemptLimit) {
      this.pairingAttempts.set(key, recent);
      this.send(socket, {
        type: 'pair_rejected',
        reason: 'rate_limited',
        retryAfterMs: this.pairingAttemptWindowMs,
      });
      socket.close(1008, 'Too many pairing attempts');
      return;
    }
    recent.push(now);
    this.pairingAttempts.set(key, recent);

    const result = this.pairingStore.redeemCode(
      message.pairingCode,
      message.deviceId,
    );
    if (!result) {
      this.send(socket, {
        type: 'pair_rejected',
        reason: 'invalid_or_expired_code',
      });
      return;
    }
    this.pairingAttempts.delete(key);
    this.send(socket, {
      type: 'pair_ack',
      deviceId: result.deviceId,
      token: result.token,
    }, () => socket.close(1000, 'Pairing complete'));
  }

  async handlePrivateText(socket, message) {
    const eventId = String(message.eventId || '').trim();
    const talker = String(message.talker || '').trim();
    const nickname = displayName(message.displayName);
    const content = typeof message.content === 'string' ? message.content : '';
    if (
      !validIdentifier(eventId)
      || !validPrivateTalker(talker)
      || content.length === 0
      || Array.from(content).length > 2_000
    ) {
      socket.close(1008, 'Invalid event');
      return;
    }

    const receiptId = `android:${socket.feagle.deviceId}:${eventId}`;
    const receipt = this.idMap.messageReceipt(receiptId);
    if (TERMINAL_RECEIPT_STATUSES.has(receipt?.status)) {
      this.ack(socket, eventId);
      return;
    }
    if (this.processingEvents.has(receiptId)) {
      this.nack(socket, eventId, 2_000, 'event_in_progress');
      return;
    }

    if (!receipt) this.idMap.claimMessage(receiptId, 'android-private');
    this.processingEvents.add(receiptId);
    this.state.increment('received');

    let guard;
    try {
      if (
        this.adminMode !== WECHAT_ADMIN_MODES.RUNNING
        || this.isSleeping()
      ) {
        this.idMap.updateMessageReceipt(receiptId, 'DROPPED');
        this.state.increment('dropped');
        this.ack(socket, eventId);
        return;
      }

      const userId = this.idMap.entity(
        'user',
        talker,
        talker,
        nickname,
      );
      guard = this.messageGuard?.check({
        userId,
        text: content,
        wechatMessageId: receiptId,
      });
      if (guard && !guard.allowed) {
        this.idMap.updateMessageReceipt(receiptId, 'BLOCKED');
        this.state.increment('blocked');
        this.ack(socket, eventId);
        return;
      }

      this.state.addMessage({
        direction: 'IN',
        peer: `Android contact ${userId}`,
        text: content,
        status: 'RECEIVED',
      });
      await this.onPrivateText({
        userId,
        nickname,
        text: content,
        wechatMessageId: receiptId,
        createTime: normalizeTimestamp(message.createTime),
      });
      this.idMap.updateMessageReceipt(receiptId, 'FORWARDED');
      this.ack(socket, eventId);
    } catch (error) {
      this.messageGuard?.rollback(guard);
      this.idMap.releaseMessageReceipt(receiptId);
      this.state.addError('android-private-forward', error);
      this.nack(
        socket,
        eventId,
        error?.code === 'UPSTREAM_BUSY' ? 5_000 : 3_000,
        error?.code || 'forward_failed',
      );
    } finally {
      this.processingEvents.delete(receiptId);
    }
  }

  ack(socket, eventId) {
    this.send(socket, { type: 'event_ack', eventId });
  }

  nack(socket, eventId, retryAfterMs, reason) {
    this.send(socket, {
      type: 'event_nack',
      eventId,
      retryAfterMs,
      reason,
    });
  }

  async sendText(onebotUserId, text) {
    if (!this.loggedIn || this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error('Android WeChat Agent is not connected');
    }
    if (this.adminMode !== WECHAT_ADMIN_MODES.RUNNING) {
      throw new Error('管理员已暂停机器人回复');
    }
    if (this.isSleeping()) throw new Error('机器人处于定时休眠时段');
    const talker = this.idMap.protocolId(onebotUserId, 'user');
    if (!talker) throw new Error(`未找到 OneBot 用户映射: ${onebotUserId}`);
    const content = String(text || '');
    if (!content || Array.from(content).length > 2_000) {
      throw new Error('首期仅支持 1-2000 字的私聊文本消息');
    }

    const commandId = randomUUID();
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(commandId);
        reject(new Error('Android send_text command timed out'));
      }, this.commandTimeoutMs);
      timer.unref();
      this.pendingCommands.set(commandId, { resolve, reject, timer });
    });
    const sent = this.send(this.socket, {
      type: 'send_text',
      commandId,
      talker,
      content,
    });
    if (!sent) {
      const pending = this.pendingCommands.get(commandId);
      clearTimeout(pending?.timer);
      this.pendingCommands.delete(commandId);
      throw new Error('Android Agent disconnected before send_text was sent');
    }
    await response;
    this.state.increment('replied');
    return { MsgID: commandId };
  }

  sendGroupText() {
    throw new Error('Android transport 首期不支持群聊发送');
  }

  handleCommandResult(message) {
    const pending = this.pendingCommands.get(String(message.commandId || ''));
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingCommands.delete(String(message.commandId));
    if (message.ok === true) pending.resolve();
    else pending.reject(new Error(String(message.error || 'send_text_failed')));
  }

  handleClose(socket) {
    if (socket !== this.socket) return;
    this.socket = null;
    this.loggedIn = false;
    this.rejectPendingCommands('Android Agent disconnected');
    if (this.stopping) return;
    this.state.patch('wechat', {
      status: this.adminMode === WECHAT_ADMIN_MODES.MANUAL_OFFLINE
        ? 'MANUAL_OFFLINE'
        : 'WAITING_AGENT',
      detail: this.adminMode === WECHAT_ADMIN_MODES.MANUAL_OFFLINE
        ? '管理员已手动离线'
        : 'Android Agent 已断开，等待重连',
      protocolHealth: 'UNHEALTHY',
      lastDisconnectAt: new Date().toISOString(),
      lastDisconnectReason: 'Android Agent disconnected',
    });
  }

  checkHeartbeat() {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const age = Date.now() - socket.feagle.lastSeenAt;
    this.state.patch('wechat', { syncAgeMs: age });
    if (age > this.heartbeatTimeoutMs) {
      socket.close(4000, 'Heartbeat timeout');
    }
  }

  async setAdminMode(mode) {
    if (!Object.values(WECHAT_ADMIN_MODES).includes(mode)) {
      throw new TypeError(`Unsupported WeChat admin mode: ${mode}`);
    }
    this.adminMode = mode;
    this.state.patch('wechat', {
      adminMode: mode,
      adminModeChangedAt: new Date().toISOString(),
    });
    if (mode === WECHAT_ADMIN_MODES.MANUAL_OFFLINE && this.socket) {
      this.socket.close(4001, 'Bridge is manually offline');
    }
    return this.state.snapshot();
  }

  setGroupChatConfig() {
    return this.state.snapshot();
  }

  forceReloginTest() {
    const error = new Error('Android transport 不使用扫码重登测试');
    error.code = 'WECHAT_ADMIN_MODE_CONFLICT';
    throw error;
  }

  send(socket, message, callback) {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({ protocol: PROTOCOL, ...message }), callback);
    return true;
  }

  rejectPendingCommands(reason) {
    for (const pending of this.pendingCommands.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pendingCommands.clear();
  }

  shutdown() {
    this.stopping = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.rejectPendingCommands('Android transport stopped');
    if (this.socket) this.socket.close(1001, 'Server shutdown');
    this.socket = null;
    this.loggedIn = false;
    this.server?.close();
    this.server = null;
    this.pairingAttempts.clear();
    if (this.ownsPairingStore) this.pairingStore?.close();
    this.pairingStore = null;
  }
}
