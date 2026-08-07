import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { WECHAT_ADMIN_MODES } from './control-state.js';
import { AndroidPairingStore } from './android-pairing-store.js';
import {
  GROUP_CHAT_MODES,
  normalizeGroupAllowlist,
  normalizeGroupChatMode,
} from './group-chat.js';

const PROTOCOL = 'feagle.android.v1';
const TERMINAL_RECEIPT_STATUSES = new Set(['FORWARDED', 'DROPPED', 'BLOCKED']);

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
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

function validGroupTalker(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    return false;
  }
  const lower = value.toLocaleLowerCase();
  return lower.endsWith('@chatroom') && !lower.includes(':');
}

function validGroupSender(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && !value.toLocaleLowerCase().endsWith('@chatroom')
    && !value.includes(':');
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
    onGroupText = async () => {},
    onPrivateImage = async () => {},
    onGroupImage = async () => {},
    host = process.env.ANDROID_WS_HOST || '0.0.0.0',
    port = positiveInteger(process.env.ANDROID_WS_PORT, 6191),
    path = process.env.ANDROID_WS_PATH || '/android',
    token = process.env.ANDROID_BRIDGE_TOKEN || '',
    deviceId = process.env.ANDROID_DEVICE_ID || '',
    initialAdminMode = WECHAT_ADMIN_MODES.RUNNING,
    initialGroupChatMode = GROUP_CHAT_MODES.OFF,
    initialGroupAllowlist = [],
    initialGroupBlockedTerms = [],
    initialGroupModes = {},
    groupSafety = null,
    groupReplyCooldownMs = positiveInteger(
      process.env.BOT_GROUP_REPLY_COOLDOWN_MS,
      5_000,
    ),
    groupReplyMaxChars = positiveInteger(process.env.BOT_MAX_GROUP_REPLY_CHARS, 1_000),
    groupJitterMinMs = nonNegativeInteger(process.env.BOT_GROUP_JITTER_MIN_MS, 1_000),
    groupJitterMaxMs = nonNegativeInteger(process.env.BOT_GROUP_JITTER_MAX_MS, 3_000),
    now = () => Date.now(),
    random = Math.random,
    delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
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
    this.onGroupText = onGroupText;
    this.onPrivateImage = onPrivateImage;
    this.onGroupImage = onGroupImage;
    this.host = host;
    this.port = port;
    this.path = path.startsWith('/') ? path : `/${path}`;
    this.token = String(token).trim();
    this.allowedDeviceId = String(deviceId).trim();
    this.adminMode = initialAdminMode;
    this.groupChatMode = normalizeGroupChatMode(initialGroupChatMode);
    this.groupAllowlist = new Set(normalizeGroupAllowlist(initialGroupAllowlist));
    this.groupModes = {};
    for (const [groupId, mode] of Object.entries(initialGroupModes || {})) {
      this.groupModes[String(groupId)] = normalizeGroupChatMode(mode);
    }
    this.groupSafety = groupSafety;
    this.groupSafety?.setBlockedTerms(initialGroupBlockedTerms);
    this.groupReplyCooldownMs = groupReplyCooldownMs;
    this.groupReplyMaxChars = groupReplyMaxChars;
    this.groupJitterMinMs = Math.min(groupJitterMinMs, groupJitterMaxMs);
    this.groupJitterMaxMs = Math.max(groupJitterMinMs, groupJitterMaxMs);
    this.now = now;
    this.random = random;
    this.delay = delay;
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
    // 引用图片缓存：msgSvrId → imageBase64（引用文字到达时组合多模态）
    this.groupImageCache = new Map();
    this.pendingCommands = new Map();
    this.lastGroupReplyAt = new Map();
    this.groupSendQueues = new Map();
    this.watchdog = null;
    this.state.patch('groupChat', {
      mode: this.groupChatMode,
      allowlist: [...this.groupAllowlist],
      blockedTerms: this.groupSafety?.blockedTerms || [],
      jitterMinMs: this.groupJitterMinMs,
      jitterMaxMs: this.groupJitterMaxMs,
    });
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
    this.state.patch('android', {
      serverStatus: 'STARTING',
      endpoint: `${this.host}:${this.port}${this.path}`,
      deviceStatus: 'WAITING',
      hookConnected: false,
      deviceIdMasked: '',
      lastHeartbeatAt: '',
      heartbeatAgeMs: null,
      pendingCommands: 0,
      heartbeatTimeoutMs: this.heartbeatTimeoutMs,
    });

    this.server = new WebSocketServer({
      host: this.host,
      port: this.port,
      path: this.path,
      maxPayload: 10 * 1024 * 1024,
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
    this.state.patch('android', { serverStatus: 'LISTENING' });
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
      case 'group_text':
        await this.handleGroupText(socket, message);
        break;
      case 'private_image':
        await this.handlePrivateImage(socket, message);
        break;
      case 'group_image':
        await this.handleGroupImage(socket, message);
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
    this.state.patch('android', {
      serverStatus: 'LISTENING',
      deviceStatus: 'CONNECTED',
      hookConnected: socket.feagle.hookConnected,
      deviceIdMasked: this.maskDeviceId(socket.feagle.deviceId),
      lastHeartbeatAt: new Date(socket.feagle.lastSeenAt).toISOString(),
      heartbeatAgeMs: 0,
      pendingCommands: this.pendingCommands.size,
    });
  }

  maskDeviceId(deviceId) {
    const normalized = String(deviceId || '');
    if (normalized.length <= 4) return normalized ? '****' : '';
    return `${normalized.slice(0, 2)}***${normalized.slice(-2)}`;
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
    });
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

  async handlePrivateImage(socket, message) {
    const eventId = String(message.eventId || '').trim();
    const talker = String(message.talker || '').trim();
    const nickname = displayName(message.displayName);
    const imageBase64 = typeof message.imageBase64 === 'string'
      ? message.imageBase64
      : '';
    const b64Len = imageBase64.length;
    if (
      !validIdentifier(eventId)
      || !validPrivateTalker(talker)
      || b64Len === 0
      || b64Len > 7 * 1024 * 1024 // base64 上限 ~7MB（对应 ~5MB 二进制）
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

    if (!receipt) this.idMap.claimMessage(receiptId, 'android-private-image');
    this.processingEvents.add(receiptId);
    this.state.increment('received');

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
      this.state.addMessage({
        direction: 'IN',
        peer: `Android contact ${userId}`,
        text: '[图片]',
        status: 'RECEIVED',
      });
      await this.onPrivateImage({
        userId,
        nickname,
        imageBase64,
        wechatMessageId: receiptId,
        createTime: normalizeTimestamp(message.createTime),
      });
      this.idMap.updateMessageReceipt(receiptId, 'FORWARDED');
      this.ack(socket, eventId);
    } catch (error) {
      this.idMap.releaseMessageReceipt(receiptId);
      this.state.addError('android-private-image-forward', error);
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

  /** 引用图片 LRU 缓存：msgSvrId → imageBase64，5 分钟过期，最多 50 张。 */
  cacheGroupImage(msgSvrId, imageBase64) {
    this.groupImageCache.set(msgSvrId, imageBase64);
    if (this.groupImageCache.size > 50) {
      const oldest = this.groupImageCache.keys().next().value;
      this.groupImageCache.delete(oldest);
    }
    setTimeout(() => {
      this.groupImageCache.delete(msgSvrId);
    }, 5 * 60 * 1000);
  }

  /** 等待引用图片：图可能还在压缩/传输路上，轮询缓存最多 timeoutMs。 */
  async waitForGroupImage(quoteSvrId, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const img = this.groupImageCache.get(quoteSvrId) || '';
      if (img) {
        this.groupImageCache.delete(quoteSvrId);
        return img;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return '';
  }

  async handleGroupImage(socket, message) {
    // TODO(2026-08-04): 群聊图片策略未定（MENTION_ONLY 下群图是否响应需产品决策）。
    // 探测阶段 Agent 不会发 group_image。先做最小校验 + 转发，正式实现时
    // 对齐 handleGroupText 的 groupChatMode/白名单/@ 判定。
    const eventId = String(message.eventId || '').trim();
    const talker = String(message.talker || '').trim();
    const sender = String(message.sender || '').trim();
    const imageBase64 = typeof message.imageBase64 === 'string'
      ? message.imageBase64
      : '';
    if (
      !validIdentifier(eventId)
      || !validGroupTalker(talker)
      || !validIdentifier(sender)
      || imageBase64.length === 0
      || imageBase64.length > 7 * 1024 * 1024
    ) {
      socket.close(1008, 'Invalid event');
      return;
    }
    const receiptId = `android:${socket.feagle.deviceId}:${eventId}`;
    if (this.processingEvents.has(receiptId)) {
      this.nack(socket, eventId, 2_000, 'event_in_progress');
      return;
    }
    this.processingEvents.add(receiptId);
    try {
      // 引用图片缓存：msgSvrId → imageBase64（引用文字到达时组合）
      const msgSvrId = Number(message.msgSvrId || 0);
      if (msgSvrId > 0) {
        this.cacheGroupImage(msgSvrId, imageBase64);
        console.log(`[quote-cache] svrid=${msgSvrId} cached (${imageBase64.length} b64)`);
      }
      const groupId = this.idMap.entity(
        'group',
        talker,
        talker,
        'Android group',
      );
      const userId = this.idMap.entity(
        'group_member',
        sender,
        sender,
        sender,
      );
      this.state.addMessage({
        direction: 'IN',
        peer: `Group ${groupId}`,
        text: '[图片]',
        status: 'RECEIVED',
      });
      await this.onGroupImage({
        groupId,
        groupName: 'Android group',
        userId,
        nickname: sender,
        imageBase64,
        wechatMessageId: receiptId,
        createTime: normalizeTimestamp(message.createTime),
      });
      this.ack(socket, eventId);
    } catch (error) {
      this.state.addError('android-group-image-forward', error);
      this.nack(socket, eventId, 3_000, error?.code || 'forward_failed');
    } finally {
      this.processingEvents.delete(receiptId);
    }
  }

  /** 逐群接收模式：groupModes[gid] 优先，缺省跟随全局 mode */
  groupModeFor(groupId) {
    return this.groupModes[String(groupId)] || this.groupChatMode;
  }

  /** 更新单个群的接收模式（Dashboard /api/group-chat/status 调用） */
  setGroupMode(groupId, mode) {
    const gid = String(groupId || '');
    if (!gid) return;
    this.groupModes[gid] = normalizeGroupChatMode(mode);
  }

  async handleGroupText(socket, message) {
    const eventId = String(message.eventId || '').trim();
    const talker = String(message.talker || '').trim();
    const sender = String(message.sender || '').trim();
    const groupName = displayName(message.groupName || 'Android group');
    const nickname = displayName(message.displayName || 'Group member');
    const content = typeof message.content === 'string' ? message.content.trim() : '';
    if (
      !validIdentifier(eventId)
      || !validGroupTalker(talker)
      || !validGroupSender(sender)
      || content.length === 0
      || Array.from(content).length > 2_000
    ) {
      socket.close(1008, 'Invalid group event');
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

    if (!receipt) this.idMap.claimMessage(receiptId, 'android-group');
    this.processingEvents.add(receiptId);
    this.state.increment('received');
    const groupId = this.idMap.entity('group', talker, talker, groupName);
    const userId = this.idMap.entity('group_member', sender, sender, nickname);
    const peer = `${groupName} / ${nickname}`;
    this.state.upsertGroup({ groupId, name: groupName, memberCount: 0 });

    let guard;
    try {
      const groupMode = this.groupModeFor(groupId);
      if (groupMode === GROUP_CHAT_MODES.OFF) {
        this.idMap.updateMessageReceipt(receiptId, 'DROPPED');
        this.state.increment('dropped');
        this.state.incrementGroup('blocked');
        this.state.addMessage({ direction: 'IN', peer, text: content, status: 'GROUP-OFF' });
        this.ack(socket, eventId);
        return;
      }

      this.state.incrementGroup('observed');
      if (groupMode === GROUP_CHAT_MODES.OBSERVE) {
        this.idMap.updateMessageReceipt(receiptId, 'DROPPED');
        this.state.addMessage({
          direction: 'IN',
          peer,
          text: content,
          status: 'GROUP-OBSERVED',
        });
        this.ack(socket, eventId);
        return;
      }

      const allowed = this.groupAllowlist.has(String(groupId));
      if (!allowed || message.mentioned !== true) {
        this.idMap.updateMessageReceipt(receiptId, 'DROPPED');
        this.state.increment('dropped');
        this.state.incrementGroup('blocked');
        this.state.addMessage({
          direction: 'IN',
          peer,
          text: content,
          status: allowed ? 'GROUP-NOT-MENTIONED' : 'GROUP-NOT-ALLOWED',
        });
        this.ack(socket, eventId);
        return;
      }

      if (this.adminMode !== WECHAT_ADMIN_MODES.RUNNING || this.isSleeping()) {
        this.idMap.updateMessageReceipt(receiptId, 'DROPPED');
        this.state.increment('dropped');
        this.state.incrementGroup('blocked');
        this.state.addMessage({
          direction: 'IN',
          peer,
          text: content,
          status: this.isSleeping() ? 'SLEEP-DROP' : 'ADMIN-PAUSED',
        });
        this.ack(socket, eventId);
        return;
      }

      const safety = this.groupSafety?.checkInbound({ groupId, userId, text: content });
      if (safety && !safety.allowed) {
        this.idMap.updateMessageReceipt(receiptId, 'BLOCKED');
        this.state.increment('blocked');
        this.state.incrementGroup('blocked');
        if (safety.status === 'GROUP-POLICY-BLOCKED') {
          this.state.incrementGroup('policyBlocked');
        } else if (safety.status.includes('RATE-LIMITED')) {
          this.state.incrementGroup('rateLimited');
        }
        this.state.addMessage({ direction: 'IN', peer, text: content, status: safety.status });
        this.ack(socket, eventId);
        return;
      }

      guard = this.messageGuard?.check({
        userId: `group:${groupId}:user:${userId}`,
        text: content,
        wechatMessageId: receiptId,
      });
      if (guard && !guard.allowed) {
        this.idMap.updateMessageReceipt(receiptId, 'BLOCKED');
        this.state.increment('blocked');
        this.state.incrementGroup('blocked');
        this.state.addMessage({ direction: 'IN', peer, text: content, status: guard.status });
        this.ack(socket, eventId);
        return;
      }

      this.state.addMessage({ direction: 'IN', peer, text: content, status: 'GROUP-MENTION' });
      // 引用图片组合：Agent 带 quoteSvrId（被引用图 msgSvrId）→ 查缓存
      const quoteSvrId = Number(message.quoteSvrId || 0);
      let quoteImage = '';
      if (quoteSvrId > 0) {
        quoteImage = this.groupImageCache.get(quoteSvrId) || '';
        if (quoteImage) {
          this.groupImageCache.delete(quoteSvrId);
        } else {
          // 图可能还在压缩/传输路上（文字先到），等待最多 15 秒
          // （大图/慢传输场景 5 秒可能不够，实测正常 3 秒内到）
          quoteImage = await this.waitForGroupImage(quoteSvrId, 15_000);
        }
        console.log(
          `[quote] svrid=${quoteSvrId} `
          + (quoteImage ? `combined (${quoteImage.length} b64)` : 'NO IMAGE (15s)'),
        );
      }
      await this.onGroupText({
        groupId,
        groupName,
        userId,
        nickname,
        text: content,
        rawText: content,
        mentioned: true,
        wechatMessageId: receiptId,
        createTime: normalizeTimestamp(message.createTime),
        imageBase64: quoteImage || undefined,
      });
      this.idMap.updateMessageReceipt(receiptId, 'FORWARDED');
      this.state.incrementGroup('forwarded');
      this.ack(socket, eventId);
    } catch (error) {
      this.messageGuard?.rollback(guard);
      this.groupSafety?.recordFailure(groupId);
      this.idMap.releaseMessageReceipt(receiptId);
      this.state.incrementGroup('blocked');
      this.state.addError('android-group-forward', error);
      this.state.addMessage({
        direction: 'IN',
        peer,
        text: content,
        status: error?.code === 'UPSTREAM_BUSY' ? 'UPSTREAM-BUSY' : 'FORWARD-FAILED',
      });
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

    const commandId = await this.sendAgentText('private', talker, content);
    this.state.increment('replied');
    this.state.addMessage({
      direction: 'OUT',
      peer: this.idMap.contact(onebotUserId)?.nickname || onebotUserId,
      text: content,
      status: 'SENT',
    });
    return { MsgID: commandId };
  }

  async sendAgentText(chatType, talker, content) {
    const commandId = randomUUID();
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(commandId);
        this.state.patch('android', { pendingCommands: this.pendingCommands.size });
        reject(new Error('Android send_text command timed out'));
      }, this.commandTimeoutMs);
      timer.unref();
      this.pendingCommands.set(commandId, { resolve, reject, timer });
      this.state.patch('android', { pendingCommands: this.pendingCommands.size });
    });
    const sent = this.send(this.socket, {
      type: 'send_text',
      commandId,
      chatType,
      talker,
      content,
    });
    if (!sent) {
      const pending = this.pendingCommands.get(commandId);
      clearTimeout(pending?.timer);
      this.pendingCommands.delete(commandId);
      this.state.patch('android', { pendingCommands: this.pendingCommands.size });
      throw new Error('Android Agent disconnected before send_text was sent');
    }
    await response;
    return commandId;
  }

  async sendGroupText(onebotGroupId, text) {
    const groupId = String(onebotGroupId);
    const previous = this.groupSendQueues.get(groupId) || Promise.resolve();
    const pending = previous
      .catch(() => {})
      .then(() => this.sendGroupTextQueued(groupId, text));
    this.groupSendQueues.set(groupId, pending);
    return pending.finally(() => {
      if (this.groupSendQueues.get(groupId) === pending) {
        this.groupSendQueues.delete(groupId);
      }
    });
  }

  async sendGroupTextQueued(groupId, text) {
    if (!this.loggedIn || this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error('Android WeChat Agent is not connected');
    }
    if (this.adminMode !== WECHAT_ADMIN_MODES.RUNNING) {
      throw new Error('管理员已暂停机器人回复');
    }
    if (this.isSleeping()) throw new Error('机器人处于定时休眠时段');
    if (this.groupModeFor(groupId) !== GROUP_CHAT_MODES.MENTION_ONLY) {
      throw new Error('该群未启用回复模式');
    }
    if (!this.groupAllowlist.has(groupId)) throw new Error('该群不在回复白名单中');

    const content = String(text || '');
    if (!content || Array.from(content).length > this.groupReplyMaxChars) {
      const error = new Error(`群聊回复必须为 1-${this.groupReplyMaxChars} 字的文本`);
      error.code = 'GROUP_REPLY_TOO_LONG';
      this.state.increment('blocked');
      this.state.incrementGroup('blocked');
      throw error;
    }
    const safety = this.groupSafety?.checkOutbound({ groupId, text: content });
    if (safety && !safety.allowed) {
      const error = new Error('群聊回复被安全策略或熔断器拦截');
      error.code = safety.status;
      this.state.increment('blocked');
      this.state.incrementGroup('blocked');
      if (safety.status === 'GROUP-POLICY-BLOCKED') {
        this.state.incrementGroup('policyBlocked');
      }
      throw error;
    }
    const lastReplyAt = this.lastGroupReplyAt.get(groupId) || 0;
    if (lastReplyAt && this.now() - lastReplyAt < this.groupReplyCooldownMs) {
      const error = new Error('群聊回复冷却中，请稍后再试');
      error.code = 'GROUP_REPLY_COOLDOWN';
      this.state.increment('blocked');
      this.state.incrementGroup('blocked');
      this.state.incrementGroup('rateLimited');
      this.groupSafety?.recordAnomaly(groupId);
      throw error;
    }
    const jitterMs = this.groupJitterMinMs + Math.floor(
      this.random() * (this.groupJitterMaxMs - this.groupJitterMinMs + 1),
    );
    this.state.patch('groupChat', { lastJitterMs: jitterMs });
    if (jitterMs > 0) await this.delay(jitterMs);
    if (!this.loggedIn || this.adminMode !== WECHAT_ADMIN_MODES.RUNNING || this.isSleeping()) {
      throw new Error('回复等待期间机器人状态已变化');
    }
    const safetyAfterDelay = this.groupSafety?.checkOutbound({ groupId, text: content });
    if (safetyAfterDelay && !safetyAfterDelay.allowed) {
      const error = new Error('回复等待期间群聊安全状态已变化');
      error.code = safetyAfterDelay.status;
      throw error;
    }
    const talker = this.idMap.protocolId(groupId, 'group');
    if (!talker || !validGroupTalker(talker)) {
      throw new Error(`未找到 OneBot 群映射: ${groupId}`);
    }
    let commandId;
    try {
      commandId = await this.sendAgentText('group', talker, content);
    } catch (error) {
      this.groupSafety?.recordFailure(groupId);
      throw error;
    }
    this.lastGroupReplyAt.set(groupId, this.now());
    this.groupSafety?.recordSuccess(groupId);
    this.state.increment('replied');
    this.state.incrementGroup('replied');
    this.state.addMessage({
      direction: 'OUT',
      peer: this.idMap.contact(groupId)?.nickname || groupId,
      text: content,
      status: 'GROUP-SENT',
    });
    return { MsgID: commandId };
  }

  handleCommandResult(message) {
    const pending = this.pendingCommands.get(String(message.commandId || ''));
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingCommands.delete(String(message.commandId));
    this.state.patch('android', { pendingCommands: this.pendingCommands.size });
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
    this.state.patch('android', {
      deviceStatus: this.adminMode === WECHAT_ADMIN_MODES.MANUAL_OFFLINE
        ? 'MANUAL_OFFLINE'
        : 'DISCONNECTED',
      hookConnected: false,
      heartbeatAgeMs: null,
      pendingCommands: 0,
    });
  }

  checkHeartbeat() {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const age = Date.now() - socket.feagle.lastSeenAt;
    this.state.patch('wechat', { syncAgeMs: age });
    this.state.patch('android', { heartbeatAgeMs: age });
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

  setGroupChatConfig(mode, allowlist, blockedTerms = []) {
    const normalizedMode = normalizeGroupChatMode(mode);
    if (normalizedMode !== mode) {
      throw new TypeError(`Unsupported group chat mode: ${mode}`);
    }
    this.groupChatMode = normalizedMode;
    this.groupAllowlist = new Set(normalizeGroupAllowlist(allowlist));
    const normalizedTerms = this.groupSafety?.setBlockedTerms(blockedTerms) || [];
    this.state.patch('groupChat', {
      mode: this.groupChatMode,
      allowlist: [...this.groupAllowlist],
      blockedTerms: normalizedTerms,
    });
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
    this.state.patch('android', { pendingCommands: 0 });
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
    this.state.patch('android', {
      serverStatus: 'STOPPED',
      deviceStatus: 'DISCONNECTED',
      hookConnected: false,
      heartbeatAgeMs: null,
      pendingCommands: 0,
    });
    this.pairingAttempts.clear();
    if (this.ownsPairingStore) this.pairingStore?.close();
    this.pairingStore = null;
  }
}
