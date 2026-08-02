export const MESSAGE_GUARD_STATUS = Object.freeze({
  ALLOWED: 'ALLOWED',
  BLOCKED_USER: 'BLOCKED_USER',
  NOT_ALLOWLISTED: 'NOT_ALLOWLISTED',
  TOO_LONG: 'TOO_LONG',
  DUPLICATE: 'DUPLICATE',
  USER_RATE_LIMITED: 'USER_RATE_LIMITED',
  GLOBAL_RATE_LIMITED: 'GLOBAL_RATE_LIMITED',
});

export const MESSAGE_GUARD_DEFAULTS = Object.freeze({
  maxCodePoints: 2_000,
  duplicateTtlMs: 5 * 60_000,
  perUserLimit: 3,
  perUserWindowMs: 30_000,
  globalLimit: 30,
  globalWindowMs: 60_000,
});

const RESERVATION = Symbol('message-guard-reservation');

function assertNonNegativeInteger(name, value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

function assertPositiveInteger(name, value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function normalizeUserIds(value, optionName) {
  if (value === undefined || value === null) return null;
  try {
    return new Set(Array.from(value, (userId) => String(userId)));
  } catch {
    throw new TypeError(`${optionName} must be an iterable of user IDs`);
  }
}

function result(allowed, status, retryAfterMs, details = {}) {
  return {
    allowed,
    verdict: allowed ? 'ALLOW' : 'DROP',
    status,
    retryAfterMs,
    ...details,
  };
}

function messageFields(message) {
  const input = message && typeof message === 'object' ? message : {};
  return {
    userId: String(input.userId ?? input.FromUserName ?? ''),
    msgId: input.msgId
      ?? input.messageId
      ?? input.wechatMessageId
      ?? input.MsgId
      ?? input.MsgID
      ?? input.NewMsgId
      ?? null,
    text: String(input.text ?? input.Content ?? ''),
  };
}

export function countCodePoints(value) {
  return Array.from(String(value ?? '')).length;
}

export class MessageGuard {
  constructor(options = {}) {
    const {
      maxCodePoints = MESSAGE_GUARD_DEFAULTS.maxCodePoints,
      duplicateTtlMs = MESSAGE_GUARD_DEFAULTS.duplicateTtlMs,
      perUserLimit = MESSAGE_GUARD_DEFAULTS.perUserLimit,
      perUserWindowMs = MESSAGE_GUARD_DEFAULTS.perUserWindowMs,
      globalLimit = MESSAGE_GUARD_DEFAULTS.globalLimit,
      globalWindowMs = MESSAGE_GUARD_DEFAULTS.globalWindowMs,
    } = options;

    assertNonNegativeInteger('maxCodePoints', maxCodePoints);
    assertNonNegativeInteger('duplicateTtlMs', duplicateTtlMs);
    assertPositiveInteger('perUserLimit', perUserLimit);
    assertPositiveInteger('perUserWindowMs', perUserWindowMs);
    assertPositiveInteger('globalLimit', globalLimit);
    assertPositiveInteger('globalWindowMs', globalWindowMs);

    const clock = options.clock ?? options.now ?? Date.now;
    if (typeof clock !== 'function') {
      throw new TypeError('clock must be a function');
    }

    this.maxCodePoints = maxCodePoints;
    this.duplicateTtlMs = duplicateTtlMs;
    this.perUserLimit = perUserLimit;
    this.perUserWindowMs = perUserWindowMs;
    this.globalLimit = globalLimit;
    this.globalWindowMs = globalWindowMs;
    this.clock = clock;
    this.allowUserIds = normalizeUserIds(
      options.allowUserIds ?? options.allowedUserIds,
      'allowUserIds',
    );
    this.blockUserIds = normalizeUserIds(
      options.blockUserIds ?? options.blockedUserIds,
      'blockUserIds',
    ) ?? new Set();

    this.duplicateExpirations = new Map();
    this.perUserTimestamps = new Map();
    this.globalTimestamps = [];
  }

  check(message) {
    const now = Number(this.clock());
    if (!Number.isFinite(now)) {
      throw new TypeError('clock must return a finite millisecond timestamp');
    }

    const { userId, msgId, text } = messageFields(message);
    const codePointLength = countCodePoints(text);

    if (this.blockUserIds.has(userId)) {
      return result(false, MESSAGE_GUARD_STATUS.BLOCKED_USER, null, { userId });
    }

    if (this.allowUserIds && !this.allowUserIds.has(userId)) {
      return result(false, MESSAGE_GUARD_STATUS.NOT_ALLOWLISTED, null, { userId });
    }

    if (codePointLength > this.maxCodePoints) {
      return result(false, MESSAGE_GUARD_STATUS.TOO_LONG, null, {
        codePointLength,
        maxCodePoints: this.maxCodePoints,
      });
    }

    this.#prune(now);

    const normalizedMsgId = msgId === null || msgId === undefined || String(msgId) === ''
      ? null
      : String(msgId);
    if (normalizedMsgId !== null) {
      const expiresAt = this.duplicateExpirations.get(normalizedMsgId);
      if (expiresAt !== undefined && expiresAt > now) {
        return result(
          false,
          MESSAGE_GUARD_STATUS.DUPLICATE,
          Math.max(1, Math.ceil(expiresAt - now)),
          { msgId: normalizedMsgId },
        );
      }
    }

    const userTimestamps = this.perUserTimestamps.get(userId) ?? [];
    if (userTimestamps.length >= this.perUserLimit) {
      return result(
        false,
        MESSAGE_GUARD_STATUS.USER_RATE_LIMITED,
        this.#retryAfter(userTimestamps, this.perUserWindowMs, now),
        {
          scope: 'user',
          userId,
          limit: this.perUserLimit,
          windowMs: this.perUserWindowMs,
        },
      );
    }

    if (this.globalTimestamps.length >= this.globalLimit) {
      return result(
        false,
        MESSAGE_GUARD_STATUS.GLOBAL_RATE_LIMITED,
        this.#retryAfter(this.globalTimestamps, this.globalWindowMs, now),
        {
          scope: 'global',
          limit: this.globalLimit,
          windowMs: this.globalWindowMs,
        },
      );
    }

    userTimestamps.push(now);
    this.perUserTimestamps.set(userId, userTimestamps);
    this.globalTimestamps.push(now);
    if (normalizedMsgId !== null && this.duplicateTtlMs > 0) {
      this.duplicateExpirations.set(normalizedMsgId, now + this.duplicateTtlMs);
    }

    const allowed = result(true, MESSAGE_GUARD_STATUS.ALLOWED, 0, {
      userId,
      msgId: normalizedMsgId,
      codePointLength,
    });
    Object.defineProperty(allowed, RESERVATION, {
      value: {
        userId,
        msgId: normalizedMsgId,
        timestamp: now,
        rolledBack: false,
      },
    });
    return allowed;
  }

  rollback(verdict) {
    const reservation = verdict?.[RESERVATION];
    if (!reservation || reservation.rolledBack) return false;
    reservation.rolledBack = true;

    const removeTimestamp = (timestamps) => {
      const index = timestamps.lastIndexOf(reservation.timestamp);
      if (index >= 0) timestamps.splice(index, 1);
    };
    removeTimestamp(this.globalTimestamps);

    const userTimestamps = this.perUserTimestamps.get(reservation.userId);
    if (userTimestamps) {
      removeTimestamp(userTimestamps);
      if (userTimestamps.length === 0) {
        this.perUserTimestamps.delete(reservation.userId);
      }
    }

    if (reservation.msgId !== null) {
      const expectedExpiration = reservation.timestamp + this.duplicateTtlMs;
      if (this.duplicateExpirations.get(reservation.msgId) === expectedExpiration) {
        this.duplicateExpirations.delete(reservation.msgId);
      }
    }
    return true;
  }

  #prune(now) {
    for (const [msgId, expiresAt] of this.duplicateExpirations) {
      if (expiresAt <= now) this.duplicateExpirations.delete(msgId);
    }

    const globalThreshold = now - this.globalWindowMs;
    this.globalTimestamps = this.globalTimestamps.filter(
      (timestamp) => timestamp > globalThreshold,
    );

    const userThreshold = now - this.perUserWindowMs;
    for (const [userId, timestamps] of this.perUserTimestamps) {
      const active = timestamps.filter((timestamp) => timestamp > userThreshold);
      if (active.length === 0) {
        this.perUserTimestamps.delete(userId);
      } else {
        this.perUserTimestamps.set(userId, active);
      }
    }
  }

  #retryAfter(timestamps, windowMs, now) {
    return Math.max(1, Math.ceil(timestamps[0] + windowMs - now));
  }
}
