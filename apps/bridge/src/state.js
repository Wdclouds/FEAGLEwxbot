import { EventEmitter } from 'node:events';

const MAX_MESSAGES = 50;
const MAX_ERRORS = 20;

export class RuntimeState extends EventEmitter {
  constructor() {
    super();
    this.startedAt = new Date().toISOString();
    this.wechat = {
      status: 'STARTING',
      adminMode: 'RUNNING',
      adminModeChangedAt: '',
      account: '',
      detail: '正在初始化 Wechat4u',
      qrDataUrl: '',
      qrCreatedAt: '',
      protocolHealth: 'UNKNOWN',
      lastSyncAt: '',
      syncAgeMs: null,
      syncErrors: 0,
      consecutiveSyncErrors: 0,
      recoveryAttempts: 0,
      lastRecoveryAt: '',
      lastDisconnectAt: '',
      lastDisconnectReason: '',
      reloginTestStatus: 'IDLE',
      reloginTestStartedAt: '',
      reloginTestCompletedAt: '',
      reloginTestDetail: '',
      degradedAfterMs: 90_000,
      fatalAfterMs: 600_000,
    };
    this.transport = {
      active: 'wechat4u',
      requested: 'wechat4u',
      switching: false,
      restartRequired: false,
      detail: 'Web protocol transport',
    };
    this.android = {
      serverStatus: 'DISABLED',
      endpoint: '',
      deviceStatus: 'DISCONNECTED',
      hookConnected: false,
      deviceIdMasked: '',
      lastHeartbeatAt: '',
      heartbeatAgeMs: null,
      pendingCommands: 0,
      heartbeatTimeoutMs: 75_000,
    };
    this.astrbot = {
      status: 'STARTING',
      pid: null,
      restarts: 0,
      detail: '等待启动',
    };
    this.onebot = {
      status: 'DISCONNECTED',
      reconnects: 0,
      lastHeartbeatAt: '',
      inFlight: 0,
      detail: '等待 AstrBot',
    };
    this.groupChat = {
      mode: 'OFF',
      allowlist: [],
      blockedTerms: [],
      groupModes: {},
      discovered: [],
      fuses: [],
      jitterMinMs: 1_000,
      jitterMaxMs: 3_000,
      observed: 0,
      forwarded: 0,
      replied: 0,
      blocked: 0,
      policyBlocked: 0,
      rateLimited: 0,
      fused: 0,
      lastMessageAt: '',
    };
    this.schedule = {
      mode: 'ACTIVE',
      testMode: false,
      timezone: process.env.BOT_TIMEZONE || 'Asia/Shanghai',
      quietHours: process.env.BOT_QUIET_HOURS || '00:00-07:00',
    };
    this.notifications = {
      provider: 'FEISHU',
      status: 'DISABLED',
      lastSentAt: '',
      lastType: '',
      failures: 0,
      connection: 'DISCONNECTED',
      bindingStatus: 'UNBOUND',
      detail: '飞书通知尚未配置',
    };
    this.counters = {
      received: 0,
      forwarded: 0,
      replied: 0,
      dropped: 0,
      blocked: 0,
      failed: 0,
    };
    this.messages = [];
    this.errors = [];
  }

  patch(section, values) {
    this[section] = { ...this[section], ...values };
    this.broadcast();
  }

  setSchedule(values) {
    const next = { ...this.schedule, ...values };
    if (
      this.schedule.mode === next.mode
      && this.schedule.testMode === next.testMode
    ) return;
    this.schedule = next;
    this.broadcast();
  }

  increment(name) {
    this.counters[name] = (this.counters[name] || 0) + 1;
    this.broadcast();
  }

  incrementGroup(name) {
    this.groupChat[name] = (this.groupChat[name] || 0) + 1;
    this.broadcast();
  }

  upsertGroup(group) {
    const normalized = {
      groupId: String(group?.groupId || ''),
      name: String(group?.name || '微信群').slice(0, 80),
      memberCount: Number(group?.memberCount || 0),
      lastSeenAt: new Date().toISOString(),
      mode: this.groupChat.groupModes[String(group?.groupId || '')] || this.groupChat.mode,
    };
    if (!normalized.groupId) return;
    const discovered = this.groupChat.discovered
      .filter((item) => item.groupId !== normalized.groupId);
    discovered.unshift(normalized);
    this.groupChat.discovered = discovered.slice(0, 50);
    this.groupChat.lastMessageAt = normalized.lastSeenAt;
    this.broadcast();
  }

  /** 切换单个群的接收模式（MENTION_ONLY / OBSERVE / OFF），缺省跟随全局 mode */
  setGroupMode(groupId, mode) {
    const gid = String(groupId || '');
    if (!gid) return;
    this.groupChat.groupModes[gid] = mode;
    this.groupChat.discovered = this.groupChat.discovered.map((group) => (
      group.groupId === gid ? { ...group, mode } : group
    ));
    this.broadcast();
  }

  addMessage({ direction, peer, text, status }) {
    this.messages.unshift({
      time: new Date().toISOString(),
      direction,
      peer: String(peer || 'unknown').slice(0, 80),
      text: String(text || '').replace(/\s+/g, ' ').slice(0, 80),
      status,
    });
    this.messages.length = Math.min(this.messages.length, MAX_MESSAGES);
    this.broadcast();
  }

  addError(source, error) {
    const candidates = [
      error?.tips,
      error?.message,
      error?.code,
      error?.response?.data?.BaseResponse?.ErrMsg,
      error?.response?.statusText,
    ];
    let message = candidates.find((value) => String(value || '').trim());
    if (!message && error !== null && error !== undefined) {
      const fallback = String(error).trim();
      if (fallback && !['[object Object]', 'Error'].includes(fallback)) message = fallback;
    }
    message = String(message || '未提供错误详情');
    this.errors.unshift({
      time: new Date().toISOString(),
      source,
      message: message.slice(0, 300),
    });
    this.errors.length = Math.min(this.errors.length, MAX_ERRORS);
    this.increment('failed');
  }

  snapshot() {
    return {
      startedAt: this.startedAt,
      now: new Date().toISOString(),
      wechat: this.wechat,
      transport: this.transport,
      android: this.android,
      astrbot: this.astrbot,
      onebot: this.onebot,
      groupChat: this.groupChat,
      schedule: this.schedule,
      notifications: this.notifications,
      counters: this.counters,
      messages: this.messages,
      errors: this.errors,
    };
  }

  broadcast() {
    this.emit('snapshot', this.snapshot());
  }
}
