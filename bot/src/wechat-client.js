import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import QRCode from 'qrcode';
import {
  ManagedWechat,
  isSessionInvalidError,
  isTransientWechatError,
} from './managed-wechat.js';
import {
  WECHAT_ADMIN_MODES,
  normalizeWechatAdminMode,
} from './control-state.js';
import {
  GROUP_CHAT_MODES,
  isWechatGroupMessage,
  normalizeGroupAllowlist,
  normalizeGroupChatMode,
  parseWechatGroupText,
} from './group-chat.js';

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(message);
      error.code = 'WECHAT_RECOVERY_TIMEOUT';
      reject(error);
    }, timeoutMs);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class WechatClient {
  constructor({
    state,
    idMap,
    isSleeping,
    onPrivateText,
    onGroupText = async () => {},
    messageGuard = null,
    onFatal = () => {},
    onReloginOutcome = () => {},
    initialAdminMode = WECHAT_ADMIN_MODES.RUNNING,
    initialGroupChatMode = GROUP_CHAT_MODES.OFF,
    initialGroupAllowlist = [],
    sessionPath = '/app/data/wechat/session.json',
    now = () => Date.now(),
    watchdogIntervalMs = positiveInteger(process.env.WECHAT_WATCHDOG_INTERVAL_MS, 15_000),
    startupGraceMs = positiveInteger(process.env.WECHAT_STARTUP_GRACE_MS, 90_000),
    degradedAfterMs = positiveInteger(process.env.WECHAT_SYNC_DEGRADED_MS, 90_000),
    recoverAfterMs = positiveInteger(process.env.WECHAT_SYNC_RECOVER_MS, 180_000),
    recoveryTimeoutMs = positiveInteger(process.env.WECHAT_RECOVERY_TIMEOUT_MS, 75_000),
    recoveryBaseDelayMs = positiveInteger(process.env.WECHAT_RECOVERY_BASE_DELAY_MS, 15_000),
    maxRecoveryFailures = positiveInteger(process.env.WECHAT_MAX_RECOVERY_FAILURES, 3),
    fatalAfterMs = positiveInteger(process.env.WECHAT_FATAL_AFTER_MS, 10 * 60_000),
    maxMessageAgeMs = positiveInteger(process.env.BOT_MAX_MESSAGE_AGE_MS, 10 * 60_000),
    groupReplyCooldownMs = positiveInteger(
      process.env.BOT_GROUP_REPLY_COOLDOWN_MS,
      5_000,
    ),
  }) {
    this.state = state;
    this.idMap = idMap;
    this.isSleeping = isSleeping;
    this.onPrivateText = onPrivateText;
    this.onGroupText = onGroupText;
    this.messageGuard = messageGuard;
    this.onFatal = onFatal;
    this.onReloginOutcome = onReloginOutcome;
    this.adminMode = normalizeWechatAdminMode(initialAdminMode);
    this.groupChatMode = normalizeGroupChatMode(initialGroupChatMode);
    this.groupAllowlist = new Set(normalizeGroupAllowlist(initialGroupAllowlist));
    this.sessionPath = sessionPath;
    this.now = now;
    this.watchdogIntervalMs = watchdogIntervalMs;
    this.startupGraceMs = startupGraceMs;
    this.degradedAfterMs = degradedAfterMs;
    this.recoverAfterMs = Math.max(recoverAfterMs, degradedAfterMs);
    this.recoveryTimeoutMs = recoveryTimeoutMs;
    this.recoveryBaseDelayMs = recoveryBaseDelayMs;
    this.maxRecoveryFailures = maxRecoveryFailures;
    this.fatalAfterMs = fatalAfterMs;
    this.maxMessageAgeMs = maxMessageAgeMs;
    this.groupReplyCooldownMs = groupReplyCooldownMs;
    this.bot = null;
    this.selfId = null;
    this.loggedIn = false;
    this.stopping = false;
    this.loginRetryTimer = null;
    this.watchdogTimer = null;
    this.recoveryInFlight = false;
    this.recoveryFailures = 0;
    this.nextRecoveryAt = 0;
    this.lastValidatedSyncTime = 0;
    this.loginStartedAt = 0;
    this.recoveryWindowStartedAt = 0;
    this.lastProtocolError = '';
    this.sessionUsable = false;
    this.watchSession = false;
    this.loginRetryFailures = 0;
    this.firstSyncErrorAt = 0;
    this.manualReloginInFlight = false;
    this.lastAuxiliaryErrorAt = new Map();
    this.lastGroupReplyAt = new Map();
    this.state.patch('groupChat', {
      mode: this.groupChatMode,
      allowlist: [...this.groupAllowlist],
    });
  }

  async start() {
    this.startWatchdog();
    mkdirSync(dirname(this.sessionPath), { recursive: true });
    if (this.adminMode === WECHAT_ADMIN_MODES.MANUAL_OFFLINE) {
      this.state.patch('wechat', {
        status: 'MANUAL_OFFLINE',
        adminMode: this.adminMode,
        detail: '管理员已紧急离线，微信协议不会自动连接',
        qrDataUrl: '',
        qrCreatedAt: '',
        protocolHealth: 'OFFLINE',
        syncAgeMs: null,
      });
      return;
    }
    this.state.patch('wechat', { adminMode: this.adminMode });
    let session = null;
    if (existsSync(this.sessionPath)) {
      try {
        session = JSON.parse(readFileSync(this.sessionPath, 'utf8'));
      } catch (error) {
        this.state.addError('wechat-session', error);
      }
    }

    this.createBot(session);
    if (session && this.bot.PROP?.uin && this.bot.PROP?.sid) {
      this.state.patch('wechat', {
        status: 'RESTORING',
        detail: '正在恢复历史登录态',
        protocolHealth: 'STARTING',
      });
      void this.restoreSession(this.bot);
      return;
    }
    void this.startFreshLogin(this.bot);
  }

  createBot(session) {
    this.bot = new ManagedWechat(session || undefined);
    const restorable = Boolean(session && this.bot.PROP?.uin && this.bot.PROP?.sid);
    this.sessionUsable = restorable;
    this.watchSession = restorable;
    this.lastValidatedSyncTime = 0;
    this.loginStartedAt = 0;
    this.bindEvents();
  }

  async restoreSession(bot) {
    try {
      await bot.restart();
    } catch (error) {
      if (this.bot !== bot || this.stopping) return;
      if (isSessionInvalidError(error)) {
        this.handleInvalidSession(bot, error);
        return;
      }
      this.lastProtocolError = error?.message || String(error);
      this.state.addError('wechat-restore', error);
      this.state.patch('wechat', {
        status: 'DEGRADED',
        detail: '历史登录态恢复失败，等待受控自愈',
        protocolHealth: 'STALE',
      });
      this.loginStartedAt = this.now();
      this.loggedIn = false;
      this.watchSession = true;
    }
  }

  async startFreshLogin(bot) {
    try {
      await bot.start();
    } catch (error) {
      if (this.bot !== bot || this.stopping) return;
      if (isSessionInvalidError(error)) {
        this.handleInvalidSession(bot, error);
        return;
      }
      if (bot.PROP?.uin && bot.PROP?.sid && bot.botData) {
        const session = JSON.parse(JSON.stringify(bot.botData));
        bot.destroyLocal();
        this.createBot(session);
        this.loginStartedAt = this.now();
        this.state.patch('wechat', {
          status: 'RESTORING',
          detail: '扫码已完成，正在恢复刚建立的 Session',
          protocolHealth: 'STARTING',
        });
        void this.restoreSession(this.bot);
        return;
      }
      this.lastProtocolError = error?.message || String(error);
      this.state.addError('wechat-login', error);
      this.state.patch('wechat', {
        status: 'ERROR',
        detail: '微信登录流程失败，稍后重试',
        protocolHealth: 'FAILED',
      });
      this.finishReloginTest(false, error?.message || '微信登录流程失败');
      this.scheduleFreshLogin();
    }
  }

  bindEvents() {
    const bot = this.bot;

    bot.on('uuid', async (uuid) => {
      if (
        this.bot !== bot
        || this.adminMode === WECHAT_ADMIN_MODES.MANUAL_OFFLINE
      ) return;
      const loginUrl = `https://login.weixin.qq.com/l/${uuid}`;
      try {
        const qrDataUrl = await QRCode.toDataURL(loginUrl, {
          errorCorrectionLevel: 'M',
          margin: 2,
          width: 360,
        });
        if (
          this.bot !== bot
          || this.stopping
          || this.adminMode === WECHAT_ADMIN_MODES.MANUAL_OFFLINE
        ) return;
        this.state.patch('wechat', {
          status: 'WAITING_SCAN',
          detail: '请使用微信扫描二维码',
          qrDataUrl,
          qrCreatedAt: new Date().toISOString(),
          protocolHealth: 'OFFLINE',
          syncAgeMs: null,
        });
      } catch (error) {
        this.state.addError('wechat-qrcode', error);
        this.finishReloginTest(false, error?.message || '二维码生成失败');
      }
    });

    bot.on('user-avatar', () => {
      if (
        this.bot !== bot
        || this.adminMode === WECHAT_ADMIN_MODES.MANUAL_OFFLINE
      ) return;
      this.state.patch('wechat', {
        status: 'SCANNED',
        detail: '已扫码，请在手机确认登录',
      });
    });

    bot.on('login', () => {
      if (
        this.bot !== bot
        || this.adminMode === WECHAT_ADMIN_MODES.MANUAL_OFFLINE
      ) return;
      this.loggedIn = true;
      this.watchSession = true;
      this.loginStartedAt = this.now();
      this.sessionUsable = true;
      this.loginRetryFailures = 0;
      const user = bot.user || {};
      this.selfId = this.idMap.entity(
        'self',
        user.UserName || `uin:${bot.PROP?.uin || 'wechat'}`,
        user.Alias || String(bot.PROP?.uin || ''),
        user.NickName || 'WeChat',
      );
      this.saveSession();
      this.state.patch('wechat', {
        status: 'ONLINE',
        account: user.NickName || user.Alias || 'WeChat',
        detail: '微信已登录，等待首次协议同步',
        qrDataUrl: '',
        qrCreatedAt: '',
        protocolHealth: 'STARTING',
        lastSyncAt: '',
        syncAgeMs: 0,
      });
      this.syncDiscoveredGroups();
    });

    bot.on('protocol-sync', ({ at }) => {
      if (
        this.bot !== bot
        || this.stopping
        || this.adminMode === WECHAT_ADMIN_MODES.MANUAL_OFFLINE
      ) return;
      const recovered = this.state.wechat.protocolHealth !== 'HEALTHY';
      this.loggedIn = true;
      this.watchSession = true;
      this.sessionUsable = true;
      if (!this.selfId) {
        const user = bot.user || {};
        this.selfId = this.idMap.entity(
          'self',
          user.UserName || `uin:${bot.PROP?.uin || 'wechat'}`,
          user.Alias || String(bot.PROP?.uin || ''),
          user.NickName || 'WeChat',
        );
      }
      this.lastValidatedSyncTime = Number(at) || this.now();
      this.recoveryFailures = 0;
      this.recoveryWindowStartedAt = 0;
      this.nextRecoveryAt = 0;
      this.firstSyncErrorAt = 0;
      this.saveSession();
      this.state.patch('wechat', {
        status: 'ONLINE',
        account: this.state.wechat.account || bot.user?.NickName || bot.user?.Alias || 'WeChat',
        detail: recovered ? '微信协议同步已恢复' : '微信协议同步正常',
        protocolHealth: 'HEALTHY',
        lastSyncAt: new Date(this.lastValidatedSyncTime).toISOString(),
        syncAgeMs: Math.max(0, this.now() - this.lastValidatedSyncTime),
        consecutiveSyncErrors: 0,
      });
      this.finishReloginTest(true, `微信账号 ${bot.user?.NickName || 'WeChat'} 已登录且协议同步正常`);
    });

    bot.on('protocol-sync-error', ({ error, count, at }) => {
      if (this.bot !== bot || this.stopping) return;
      const detail = error?.tips || error?.message || '微信同步错误';
      this.lastProtocolError = detail;
      if (!this.firstSyncErrorAt) this.firstSyncErrorAt = Number(at) || this.now();
      this.state.patch('wechat', {
        detail,
        syncErrors: this.state.wechat.syncErrors + 1,
        consecutiveSyncErrors: count,
      });
    });

    bot.on('session-invalid', (error) => {
      if (this.bot !== bot || this.stopping) return;
      this.handleInvalidSession(bot, error);
    });

    bot.on('maintenance-error', (error) => {
      if (this.bot !== bot || this.stopping) return;
      this.state.addError('wechat-maintenance', error);
    });

    bot.on('contacts-updated', () => {
      if (this.bot !== bot) return;
      this.syncDiscoveredGroups();
      if (this.loggedIn) this.saveSession();
    });

    bot.on('message', (message) => {
      if (this.bot !== bot) return;
      void this.handleMessage(message);
    });

    bot.on('logout', () => {
      if (
        this.bot !== bot
        || this.stopping
        || this.adminMode === WECHAT_ADMIN_MODES.MANUAL_OFFLINE
      ) return;
      this.lastProtocolError = 'Wechat4u 触发了未验证的 logout，已保留 Session';
      this.state.patch('wechat', {
        status: 'DEGRADED',
        detail: this.lastProtocolError,
        protocolHealth: 'STALE',
        lastDisconnectAt: new Date(this.now()).toISOString(),
        lastDisconnectReason: this.lastProtocolError,
      });
    });

    bot.on('error', (error) => {
      if (this.bot !== bot || this.stopping) return;
      const detail = error?.tips || error?.message || 'Wechat4u 错误';
      this.lastProtocolError = detail;
      if (error?.managedProtocolError) return;
      if (/联系人|contact/i.test(detail)) {
        const previousAt = this.lastAuxiliaryErrorAt.get(detail) || 0;
        if (this.now() - previousAt >= 5 * 60_000) {
          this.lastAuxiliaryErrorAt.set(detail, this.now());
          this.state.addError('wechat-contact', detail);
        }
        return;
      }
      this.state.addError('wechat', error);
      this.state.patch('wechat', {
        status: this.loggedIn ? 'DEGRADED' : 'ERROR',
        detail,
        protocolHealth: this.loggedIn ? 'STALE' : 'FAILED',
      });
    });
  }

  handleInvalidSession(bot, error) {
    if (
      this.bot !== bot
      || this.stopping
      || this.adminMode === WECHAT_ADMIN_MODES.MANUAL_OFFLINE
    ) return;
    if (!this.sessionUsable && this.state.wechat.status === 'LOGGED_OUT') return;
    this.loggedIn = false;
    this.watchSession = false;
    this.selfId = null;
    this.lastValidatedSyncTime = 0;
    this.lastProtocolError = error?.message || '微信 Session 已失效';
    this.sessionUsable = false;
    bot.destroyLocal();
    this.clearSession();
    this.state.patch('wechat', {
      status: 'LOGGED_OUT',
      detail: '微信 Session 已确认失效，等待重新扫码',
      qrDataUrl: '',
      protocolHealth: 'FAILED',
      syncAgeMs: null,
      lastDisconnectAt: new Date(this.now()).toISOString(),
      lastDisconnectReason: this.lastProtocolError,
    });
    this.scheduleFreshLogin();
  }

  startWatchdog() {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = setInterval(() => {
      void this.inspectProtocolHealth();
    }, this.watchdogIntervalMs);
    this.watchdogTimer.unref();
  }

  async inspectProtocolHealth() {
    if (
      this.stopping
      || this.adminMode === WECHAT_ADMIN_MODES.MANUAL_OFFLINE
      || !this.watchSession
      || !this.bot
    ) return;

    const now = this.now();
    const referenceTime = this.lastValidatedSyncTime || this.loginStartedAt;
    const syncAgeMs = referenceTime
      ? Math.max(0, now - referenceTime)
      : Number.POSITIVE_INFINITY;
    const waitingForFirstSync = !this.lastValidatedSyncTime
      && this.loginStartedAt
      && syncAgeMs < this.startupGraceMs;
    const sustainedSyncErrors = this.state.wechat.consecutiveSyncErrors >= 3
      && this.firstSyncErrorAt
      && now - this.firstSyncErrorAt >= 45_000;

    if (waitingForFirstSync) {
      this.state.patch('wechat', {
        status: 'ONLINE',
        detail: '等待首次严格协议同步',
        protocolHealth: 'STARTING',
        syncAgeMs,
      });
      return;
    }

    if (
      this.lastValidatedSyncTime
      && syncAgeMs < this.degradedAfterMs
      && !sustainedSyncErrors
    ) {
      this.state.patch('wechat', {
        status: 'ONLINE',
        detail: '微信协议同步正常',
        protocolHealth: 'HEALTHY',
        lastSyncAt: new Date(this.lastValidatedSyncTime).toISOString(),
        syncAgeMs,
      });
      return;
    }

    this.state.patch('wechat', {
      status: this.recoveryInFlight ? 'RECOVERING' : 'DEGRADED',
      detail: `微信协议已 ${Math.round(syncAgeMs / 1000)} 秒未同步`,
      protocolHealth: this.recoveryInFlight ? 'RECOVERING' : 'STALE',
      lastSyncAt: this.lastValidatedSyncTime
        ? new Date(this.lastValidatedSyncTime).toISOString()
        : '',
      syncAgeMs: Number.isFinite(syncAgeMs) ? syncAgeMs : null,
    });

    if (
      (syncAgeMs < this.recoverAfterMs && !sustainedSyncErrors)
      || this.recoveryInFlight
      || now < this.nextRecoveryAt
    ) return;
    await this.recoverProtocol(this.bot);
  }

  async recoverProtocol(targetBot) {
    if (
      this.recoveryInFlight
      || this.stopping
      || this.adminMode === WECHAT_ADMIN_MODES.MANUAL_OFFLINE
      || targetBot !== this.bot
    ) return;
    this.recoveryInFlight = true;
    if (!this.recoveryWindowStartedAt) this.recoveryWindowStartedAt = this.now();
    const attempt = this.state.wechat.recoveryAttempts + 1;
    const attemptedAt = new Date(this.now()).toISOString();
    this.state.patch('wechat', {
      status: 'RECOVERING',
      detail: `正在执行第 ${attempt} 次协议自愈`,
      protocolHealth: 'RECOVERING',
      recoveryAttempts: attempt,
      lastRecoveryAt: attemptedAt,
    });

    try {
      const session = JSON.parse(JSON.stringify(targetBot.botData || {}));
      targetBot.destroyLocal();
      this.loggedIn = false;
      this.watchSession = true;
      this.selfId = null;
      this.createBot(session);
      const replacement = this.bot;
      const firstSync = new Promise((resolve, reject) => {
        replacement.once('protocol-sync', resolve);
        replacement.once('session-invalid', reject);
      });
      await withTimeout(
        Promise.all([
          replacement.restart(),
          firstSync,
        ]),
        this.recoveryTimeoutMs,
        `Wechat4u 自愈超过 ${Math.round(this.recoveryTimeoutMs / 1000)} 秒`,
      );

      if (
        replacement !== this.bot
        || !this.loggedIn
        || !this.lastValidatedSyncTime
        || this.now() - this.lastValidatedSyncTime >= this.degradedAfterMs
      ) {
        throw new Error('Wechat4u 自愈后仍未恢复协议同步');
      }

      this.recoveryFailures = 0;
      this.recoveryWindowStartedAt = 0;
      this.nextRecoveryAt = 0;
      this.state.patch('wechat', {
        status: 'ONLINE',
        detail: '微信协议自愈成功',
        protocolHealth: 'HEALTHY',
        lastSyncAt: new Date(this.lastValidatedSyncTime).toISOString(),
        syncAgeMs: Math.max(0, this.now() - this.lastValidatedSyncTime),
      });
    } catch (error) {
      if (this.stopping) return;
      if (isSessionInvalidError(error)) {
        this.handleInvalidSession(this.bot, error);
        return;
      }
      this.recoveryFailures += 1;
      const delay = Math.min(
        this.recoveryBaseDelayMs * (2 ** (this.recoveryFailures - 1)),
        5 * 60_000,
      );
      this.nextRecoveryAt = this.now() + delay;
      this.state.addError('wechat-watchdog', error);
      const recoveryExhausted = this.recoveryFailures >= this.maxRecoveryFailures;
      const fatalWindowElapsed = this.now() - this.recoveryWindowStartedAt >= this.fatalAfterMs;
      const shouldRestartContainer = recoveryExhausted
        && fatalWindowElapsed
        && !isTransientWechatError(error);
      this.state.patch('wechat', {
        status: recoveryExhausted ? 'ERROR' : 'DEGRADED',
        detail: shouldRestartContainer
          ? '微信协议长时间自愈失败，准备重启机器人容器'
          : `协议自愈失败，${Math.round(delay / 1000)} 秒后重试`,
        protocolHealth: recoveryExhausted ? 'FAILED' : 'STALE',
      });
      if (shouldRestartContainer) {
        this.onFatal(error);
      } else {
        this.loggedIn = false;
        this.watchSession = true;
        if (!this.loginStartedAt) this.loginStartedAt = this.now();
      }
    } finally {
      this.recoveryInFlight = false;
    }
  }

  scheduleFreshLogin() {
    if (
      this.stopping
      || this.adminMode === WECHAT_ADMIN_MODES.MANUAL_OFFLINE
      || this.loginRetryTimer
    ) return;
    this.loginRetryFailures += 1;
    const delay = Math.min(2_000 * (2 ** (this.loginRetryFailures - 1)), 60_000);
    this.state.patch('wechat', {
      detail: `登录流程将在 ${Math.round(delay / 1000)} 秒后重试`,
    });
    this.loginRetryTimer = setTimeout(() => {
      this.loginRetryTimer = null;
      if (
        this.stopping
        || this.adminMode === WECHAT_ADMIN_MODES.MANUAL_OFFLINE
      ) return;
      this.bot?.destroyLocal?.();
      this.createBot(null);
      void this.startFreshLogin(this.bot);
    }, delay);
    this.loginRetryTimer.unref();
  }

  async forceReloginTest() {
    if (this.stopping) throw new Error('机器人正在停止，无法执行重登录测试');
    if (this.adminMode !== WECHAT_ADMIN_MODES.RUNNING) {
      const error = new Error('请先将机器人恢复为正常运行，再执行强制重登录测试');
      error.code = 'WECHAT_ADMIN_MODE_CONFLICT';
      throw error;
    }
    if (this.manualReloginInFlight) {
      const error = new Error('强制重登录测试正在进行中');
      error.code = 'WECHAT_RELOGIN_IN_PROGRESS';
      throw error;
    }
    if (
      !this.bot
      || !this.loggedIn
      || this.state.wechat.status !== 'ONLINE'
      || this.state.wechat.protocolHealth !== 'HEALTHY'
    ) {
      const error = new Error('微信当前不是健康在线状态，不能执行强制下线测试');
      error.code = 'WECHAT_NOT_HEALTHY';
      throw error;
    }

    this.manualReloginInFlight = true;
    const startedAt = new Date(this.now()).toISOString();
    const targetBot = this.bot;
    if (this.loginRetryTimer) {
      clearTimeout(this.loginRetryTimer);
      this.loginRetryTimer = null;
    }
    this.state.patch('wechat', {
      status: 'LOGGING_OUT',
      detail: '正在执行强制下线测试',
      protocolHealth: 'OFFLINE',
      reloginTestStatus: 'RUNNING',
      reloginTestStartedAt: startedAt,
      reloginTestCompletedAt: '',
      reloginTestDetail: '正在注销当前微信 Session',
    });

    try {
      if (typeof targetBot.logout === 'function') {
        await withTimeout(
          Promise.resolve(targetBot.logout()),
          10_000,
          '微信注销接口 10 秒内未响应',
        );
      }
    } catch (error) {
      this.state.addError('wechat-force-logout', error);
    }

    if (this.stopping || this.bot !== targetBot) {
      this.finishReloginTest(false, '微信实例已变化，测试已终止');
      throw new Error('微信实例已变化，强制重登录测试已终止');
    }

    targetBot.destroyLocal();
    this.loggedIn = false;
    this.watchSession = false;
    this.sessionUsable = false;
    this.selfId = null;
    this.lastValidatedSyncTime = 0;
    this.loginStartedAt = 0;
    this.recoveryInFlight = false;
    this.recoveryFailures = 0;
    this.recoveryWindowStartedAt = 0;
    this.nextRecoveryAt = 0;
    this.firstSyncErrorAt = 0;
    this.clearSession();
    this.createBot(null);
    this.state.patch('wechat', {
      status: 'LOGGED_OUT',
      detail: '强制下线完成，正在生成新的登录二维码',
      qrDataUrl: '',
      qrCreatedAt: '',
      protocolHealth: 'FAILED',
      lastSyncAt: '',
      syncAgeMs: null,
      consecutiveSyncErrors: 0,
      lastDisconnectAt: new Date(this.now()).toISOString(),
      lastDisconnectReason: 'Dashboard 强制下线测试',
      reloginTestDetail: '等待新二维码',
    });
    void this.startFreshLogin(this.bot);
    return this.state.snapshot();
  }

  async setAdminMode(mode) {
    const nextMode = normalizeWechatAdminMode(mode);
    if (nextMode !== mode) {
      throw new TypeError(`Unsupported WeChat admin mode: ${mode}`);
    }
    if (this.stopping) throw new Error('机器人正在停止，无法切换运行状态');
    if (nextMode === this.adminMode) return this.state.snapshot();

    const previousMode = this.adminMode;
    this.adminMode = nextMode;
    const changedAt = new Date(this.now()).toISOString();

    if (nextMode === WECHAT_ADMIN_MODES.MANUAL_OFFLINE) {
      return this.enterManualOffline(changedAt);
    }

    this.state.patch('wechat', {
      adminMode: nextMode,
      adminModeChangedAt: changedAt,
    });

    if (previousMode === WECHAT_ADMIN_MODES.MANUAL_OFFLINE) {
      this.resetConnectionFlags();
      this.state.patch('wechat', {
        status: 'STARTING',
        detail: '管理员已恢复运行，正在生成微信登录二维码',
        qrDataUrl: '',
        qrCreatedAt: '',
        protocolHealth: 'STARTING',
        lastSyncAt: '',
        syncAgeMs: null,
      });
      this.createBot(null);
      void this.startFreshLogin(this.bot);
      return this.state.snapshot();
    }

    this.state.patch('wechat', {
      detail: nextMode === WECHAT_ADMIN_MODES.PAUSED
        ? '微信保持连接，管理员已暂停消息回复'
        : '管理员已恢复消息处理',
    });
    return this.state.snapshot();
  }

  async enterManualOffline(changedAt = new Date(this.now()).toISOString()) {
    if (this.loginRetryTimer) {
      clearTimeout(this.loginRetryTimer);
      this.loginRetryTimer = null;
    }
    const targetBot = this.bot;
    this.manualReloginInFlight = false;
    this.watchSession = false;
    this.state.patch('wechat', {
      status: 'LOGGING_OUT',
      adminMode: WECHAT_ADMIN_MODES.MANUAL_OFFLINE,
      adminModeChangedAt: changedAt,
      detail: '正在执行管理员紧急离线',
      qrDataUrl: '',
      qrCreatedAt: '',
      protocolHealth: 'OFFLINE',
      syncAgeMs: null,
      reloginTestStatus: 'IDLE',
      reloginTestDetail: '',
    });

    if (targetBot && typeof targetBot.logout === 'function') {
      try {
        await withTimeout(
          Promise.resolve(targetBot.logout()),
          10_000,
          '微信注销接口 10 秒内未响应',
        );
      } catch (error) {
        this.state.addError('wechat-manual-offline', error);
      }
    }

    targetBot?.destroyLocal?.();
    if (this.bot === targetBot) this.bot = null;
    this.resetConnectionFlags();
    this.clearSession();
    this.state.patch('wechat', {
      status: 'MANUAL_OFFLINE',
      adminMode: WECHAT_ADMIN_MODES.MANUAL_OFFLINE,
      adminModeChangedAt: changedAt,
      detail: '管理员已紧急离线；自动重连和二维码通知均已暂停',
      qrDataUrl: '',
      qrCreatedAt: '',
      protocolHealth: 'OFFLINE',
      lastSyncAt: '',
      syncAgeMs: null,
      consecutiveSyncErrors: 0,
      lastDisconnectAt: changedAt,
      lastDisconnectReason: 'Dashboard 管理员紧急离线',
    });
    return this.state.snapshot();
  }

  resetConnectionFlags() {
    this.loggedIn = false;
    this.watchSession = false;
    this.sessionUsable = false;
    this.selfId = null;
    this.lastValidatedSyncTime = 0;
    this.loginStartedAt = 0;
    this.recoveryInFlight = false;
    this.recoveryFailures = 0;
    this.recoveryWindowStartedAt = 0;
    this.nextRecoveryAt = 0;
    this.firstSyncErrorAt = 0;
    this.loginRetryFailures = 0;
  }

  finishReloginTest(success, detail) {
    if (!this.manualReloginInFlight) return;
    this.manualReloginInFlight = false;
    const outcome = {
      success: Boolean(success),
      account: this.state.wechat.account || '',
      detail: String(detail || (success ? '登录成功' : '登录失败')).slice(0, 200),
    };
    this.state.patch('wechat', {
      reloginTestStatus: success ? 'SUCCESS' : 'FAILED',
      reloginTestCompletedAt: new Date(this.now()).toISOString(),
      reloginTestDetail: outcome.detail,
    });
    Promise.resolve(this.onReloginOutcome(outcome)).catch((error) => {
      this.state.addError('wechat-relogin-notification', error);
    });
  }

  setGroupChatConfig(mode, allowlist) {
    const normalizedMode = normalizeGroupChatMode(mode);
    if (normalizedMode !== mode) {
      throw new TypeError(`Unsupported group chat mode: ${mode}`);
    }
    this.groupChatMode = normalizedMode;
    this.groupAllowlist = new Set(normalizeGroupAllowlist(allowlist));
    this.state.patch('groupChat', {
      mode: this.groupChatMode,
      allowlist: [...this.groupAllowlist],
    });
    this.syncDiscoveredGroups();
    return this.state.snapshot();
  }

  syncDiscoveredGroups() {
    for (const contact of Object.values(this.bot?.contacts || {})) {
      if (!String(contact?.UserName || '').startsWith('@@')) continue;
      const groupId = this.idMap.entity(
        'group',
        contact.UserName,
        contact.EncryChatRoomId || '',
        contact.RemarkName || contact.NickName || '微信群',
      );
      this.state.upsertGroup({
        groupId,
        name: contact.RemarkName || contact.NickName || '微信群',
        memberCount: contact.MemberCount || contact.MemberList?.length || 0,
      });
    }
  }

  messageIsFresh(message) {
    const createTime = Number(message?.CreateTime || 0);
    if (!createTime) return true;
    const createdAt = createTime < 10_000_000_000 ? createTime * 1_000 : createTime;
    return this.now() - createdAt <= this.maxMessageAgeMs;
  }

  claimMessage(message, kind) {
    const messageId = message.MsgId || message.MsgID || message.NewMsgId || '';
    if (!this.messageIsFresh(message)) return { claimed: false, messageId, status: 'STALE-REPLAY' };
    const claimed = this.idMap.claimMessage
      ? this.idMap.claimMessage(messageId, kind)
      : true;
    return {
      claimed,
      messageId,
      status: claimed ? 'RECEIVED' : 'DUPLICATE-REPLAY',
    };
  }

  async handleMessage(message) {
    if (!this.loggedIn || !this.selfId) return;
    if (message.MsgType !== this.bot.CONF.MSGTYPE_TEXT) return;
    if (!message.FromUserName) return;
    if (isWechatGroupMessage(message)) {
      await this.handleGroupMessage(message);
      return;
    }
    if (message.FromUserName === this.bot.user?.UserName) return;
    if (['filehelper', 'newsapp', 'fmessage'].includes(message.FromUserName)) return;

    const text = String(message.Content || '').trim();
    if (!text) return;

    const contact = this.bot.contacts?.[message.FromUserName] || {};
    const nickname = contact.RemarkName || contact.NickName || '微信用户';
    const userId = this.idMap.entity(
      'user',
      message.FromUserName,
      contact.Alias || '',
      nickname,
    );

    this.state.increment('received');
    const receipt = this.claimMessage(message, 'private');
    if (!receipt.claimed) {
      this.state.increment('blocked');
      this.state.addMessage({
        direction: 'IN',
        peer: nickname,
        text,
        status: receipt.status,
      });
      return;
    }
    if (this.adminMode === WECHAT_ADMIN_MODES.PAUSED) {
      this.state.increment('dropped');
      this.state.addMessage({
        direction: 'IN',
        peer: nickname,
        text,
        status: 'ADMIN-PAUSED',
      });
      return;
    }
    if (this.isSleeping()) {
      this.state.increment('dropped');
      this.state.addMessage({
        direction: 'IN',
        peer: nickname,
        text,
        status: 'SLEEP-DROP',
      });
      return;
    }

    const wechatMessageId = receipt.messageId;
    const guard = this.messageGuard?.check({
      userId,
      text,
      wechatMessageId,
    });
    if (guard && !guard.allowed) {
      this.state.increment('blocked');
      this.state.addMessage({
        direction: 'IN',
        peer: nickname,
        text,
        status: guard.status,
      });
      return;
    }

    this.state.addMessage({
      direction: 'IN',
      peer: nickname,
      text,
      status: 'RECEIVED',
    });
    try {
      await this.onPrivateText({
        userId,
        nickname,
        text,
        wechatMessageId,
      });
      this.idMap.updateMessageReceipt?.(wechatMessageId, 'FORWARDED');
    } catch (error) {
      this.messageGuard?.rollback(guard);
      if (error?.code === 'UPSTREAM_BUSY') this.state.increment('blocked');
      this.state.addError('private-message-forward', error);
      this.state.addMessage({
        direction: 'IN',
        peer: nickname,
        text,
        status: error?.code === 'UPSTREAM_BUSY' ? 'UPSTREAM-BUSY' : 'FORWARD-FAILED',
      });
    }
  }

  async handleGroupMessage(message) {
    const group = this.bot.contacts?.[message.FromUserName] || {};
    const parsed = parseWechatGroupText({
      message,
      group,
      selfUserName: this.bot.user?.UserName || '',
      selfNickName: this.bot.user?.NickName || '',
    });
    if (!parsed || parsed.isSelf || !parsed.rawText) return;

    const groupId = this.idMap.entity(
      'group',
      parsed.groupProtocolId,
      group.EncryChatRoomId || '',
      parsed.groupName,
    );
    const userId = this.idMap.entity(
      'group_member',
      parsed.senderProtocolId,
      parsed.senderStableKey,
      parsed.senderNickname,
    );
    this.state.increment('received');
    this.state.upsertGroup({
      groupId,
      name: parsed.groupName,
      memberCount: parsed.memberCount,
    });
    const receipt = this.claimMessage(message, 'group');
    if (!receipt.claimed) {
      this.state.increment('blocked');
      this.state.incrementGroup('blocked');
      this.state.addMessage({
        direction: 'IN',
        peer: `${parsed.groupName} · ${parsed.senderNickname}`,
        text: parsed.rawText,
        status: receipt.status,
      });
      return;
    }

    if (this.groupChatMode === GROUP_CHAT_MODES.OFF) {
      this.state.increment('dropped');
      this.state.incrementGroup('blocked');
      this.state.addMessage({
        direction: 'IN',
        peer: `${parsed.groupName} · ${parsed.senderNickname}`,
        text: parsed.rawText,
        status: 'GROUP-OFF',
      });
      return;
    }

    this.state.incrementGroup('observed');
    if (this.groupChatMode === GROUP_CHAT_MODES.OBSERVE) {
      this.state.addMessage({
        direction: 'IN',
        peer: `${parsed.groupName} · ${parsed.senderNickname}`,
        text: parsed.rawText,
        status: 'GROUP-OBSERVED',
      });
      return;
    }

    const allowed = this.groupAllowlist.has(String(groupId));
    if (!allowed || !parsed.mentioned || !parsed.text) {
      this.state.increment('dropped');
      this.state.incrementGroup('blocked');
      this.state.addMessage({
        direction: 'IN',
        peer: `${parsed.groupName} · ${parsed.senderNickname}`,
        text: parsed.rawText,
        status: !allowed
          ? 'GROUP-NOT-ALLOWED'
          : (parsed.mentioned ? 'GROUP-EMPTY-MENTION' : 'GROUP-NOT-MENTIONED'),
      });
      return;
    }
    if (this.adminMode === WECHAT_ADMIN_MODES.PAUSED || this.isSleeping()) {
      this.state.increment('dropped');
      this.state.incrementGroup('blocked');
      this.state.addMessage({
        direction: 'IN',
        peer: `${parsed.groupName} · ${parsed.senderNickname}`,
        text: parsed.text,
        status: this.isSleeping() ? 'SLEEP-DROP' : 'ADMIN-PAUSED',
      });
      return;
    }

    const guard = this.messageGuard?.check({
      userId: `group:${groupId}:user:${userId}`,
      text: parsed.text,
      wechatMessageId: receipt.messageId,
    });
    if (guard && !guard.allowed) {
      this.state.increment('blocked');
      this.state.incrementGroup('blocked');
      this.state.addMessage({
        direction: 'IN',
        peer: `${parsed.groupName} · ${parsed.senderNickname}`,
        text: parsed.text,
        status: guard.status,
      });
      return;
    }

    this.state.addMessage({
      direction: 'IN',
      peer: `${parsed.groupName} · ${parsed.senderNickname}`,
      text: parsed.text,
      status: 'GROUP-MENTION',
    });
    try {
      await this.onGroupText({
        groupId,
        groupName: parsed.groupName,
        userId,
        nickname: parsed.senderNickname,
        text: parsed.text,
        rawText: parsed.rawText,
        mentioned: true,
        wechatMessageId: receipt.messageId,
      });
      this.state.incrementGroup('forwarded');
      this.idMap.updateMessageReceipt?.(receipt.messageId, 'FORWARDED');
    } catch (error) {
      this.messageGuard?.rollback(guard);
      if (error?.code === 'UPSTREAM_BUSY') this.state.increment('blocked');
      this.state.incrementGroup('blocked');
      this.state.addError('group-message-forward', error);
      this.state.addMessage({
        direction: 'IN',
        peer: `${parsed.groupName} · ${parsed.senderNickname}`,
        text: parsed.text,
        status: error?.code === 'UPSTREAM_BUSY' ? 'UPSTREAM-BUSY' : 'FORWARD-FAILED',
      });
    }
  }

  async sendText(onebotUserId, text) {
    if (!this.loggedIn) throw new Error('微信尚未登录');
    if (this.adminMode !== WECHAT_ADMIN_MODES.RUNNING) {
      throw new Error('管理员已暂停机器人回复');
    }
    if (this.isSleeping()) throw new Error('机器人处于定时休眠时段');
    const protocolId = this.idMap.protocolId(onebotUserId, 'user');
    if (!protocolId) throw new Error(`未找到 OneBot 用户映射: ${onebotUserId}`);
    const contact = this.idMap.contact(onebotUserId);
    const result = await (this.bot.sendText
      ? this.bot.sendText(text, protocolId)
      : this.bot.sendMsg(text, protocolId));
    this.state.increment('replied');
    this.state.addMessage({
      direction: 'OUT',
      peer: contact?.nickname || onebotUserId,
      text,
      status: 'SENT',
    });
    return result;
  }

  async sendGroupText(onebotGroupId, text) {
    if (!this.loggedIn) throw new Error('微信尚未登录');
    if (this.adminMode !== WECHAT_ADMIN_MODES.RUNNING) {
      throw new Error('管理员已暂停机器人回复');
    }
    if (this.isSleeping()) throw new Error('机器人处于定时休眠时段');
    if (this.groupChatMode !== GROUP_CHAT_MODES.MENTION_ONLY) {
      throw new Error('群聊回复模式未启用');
    }
    const groupId = String(onebotGroupId);
    if (!this.groupAllowlist.has(groupId)) throw new Error('该群不在回复白名单中');
    const lastReplyAt = this.lastGroupReplyAt.get(groupId) || 0;
    if (lastReplyAt && this.now() - lastReplyAt < this.groupReplyCooldownMs) {
      const error = new Error('群聊回复冷却中，请稍后再试');
      error.code = 'GROUP_REPLY_COOLDOWN';
      throw error;
    }
    const protocolId = this.idMap.protocolId(groupId, 'group');
    if (!protocolId) throw new Error(`未找到 OneBot 群映射: ${groupId}`);
    const contact = this.idMap.contact(groupId);
    const result = await (this.bot.sendText
      ? this.bot.sendText(text, protocolId)
      : this.bot.sendMsg(text, protocolId));
    this.lastGroupReplyAt.set(groupId, this.now());
    this.state.increment('replied');
    this.state.incrementGroup('replied');
    this.state.addMessage({
      direction: 'OUT',
      peer: contact?.nickname || groupId,
      text,
      status: 'GROUP-SENT',
    });
    return result;
  }

  saveSession() {
    if (!this.sessionUsable || !this.bot?.botData) return;
    const tempPath = `${this.sessionPath}.tmp`;
    try {
      writeFileSync(tempPath, JSON.stringify(this.bot.botData), {
        encoding: 'utf8',
        mode: 0o600,
      });
      renameSync(tempPath, this.sessionPath);
    } catch (error) {
      this.state.addError('wechat-session-save', error);
    }
  }

  clearSession() {
    try {
      rmSync(this.sessionPath, { force: true });
    } catch (error) {
      this.state.addError('wechat-session-clear', error);
    }
  }

  shutdown() {
    this.stopping = true;
    if (this.loginRetryTimer) clearTimeout(this.loginRetryTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.saveSession();
    this.bot?.destroyLocal?.();
  }
}
