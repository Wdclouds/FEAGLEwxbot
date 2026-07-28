export const GROUP_SAFETY_STATUS = Object.freeze({
  ALLOWED: 'ALLOWED',
  FUSED: 'GROUP-FUSED',
  POLICY_BLOCKED: 'GROUP-POLICY-BLOCKED',
  MEMBER_RATE_LIMITED: 'GROUP-MEMBER-RATE-LIMITED',
  GROUP_RATE_LIMITED: 'GROUP-RATE-LIMITED',
});

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function normalizeBlockedTerms(value) {
  const candidates = Array.isArray(value) ? value : [];
  return Array.from(new Set(candidates
    .map((term) => String(term || '').trim().toLocaleLowerCase())
    .filter(Boolean)
    .map((term) => term.slice(0, 64))))
    .slice(0, 100);
}

function activeTimestamps(timestamps, threshold) {
  return (timestamps || []).filter((timestamp) => timestamp > threshold);
}

export class GroupSafetyGate {
  constructor({
    now = () => Date.now(),
    blockedTerms = [],
    memberLimit = positiveInteger(process.env.BOT_GROUP_MEMBER_RATE_LIMIT, 3),
    memberWindowMs = positiveInteger(process.env.BOT_GROUP_MEMBER_RATE_WINDOW_MS, 60_000),
    groupLimit = positiveInteger(process.env.BOT_GROUP_RATE_LIMIT, 6),
    groupWindowMs = positiveInteger(process.env.BOT_GROUP_RATE_WINDOW_MS, 60_000),
    fuseFailureThreshold = positiveInteger(process.env.BOT_GROUP_FUSE_FAILURES, 3),
    fuseFailureWindowMs = positiveInteger(
      process.env.BOT_GROUP_FUSE_FAILURE_WINDOW_MS,
      5 * 60_000,
    ),
    fuseAnomalyThreshold = positiveInteger(process.env.BOT_GROUP_FUSE_ANOMALIES, 12),
    fuseAnomalyWindowMs = positiveInteger(
      process.env.BOT_GROUP_FUSE_ANOMALY_WINDOW_MS,
      60_000,
    ),
    fuseDurationMs = positiveInteger(process.env.BOT_GROUP_FUSE_DURATION_MS, 15 * 60_000),
    onFuse = () => {},
    onChange = () => {},
  } = {}) {
    this.now = now;
    this.blockedTerms = normalizeBlockedTerms(blockedTerms);
    this.memberLimit = memberLimit;
    this.memberWindowMs = memberWindowMs;
    this.groupLimit = groupLimit;
    this.groupWindowMs = groupWindowMs;
    this.fuseFailureThreshold = fuseFailureThreshold;
    this.fuseFailureWindowMs = fuseFailureWindowMs;
    this.fuseAnomalyThreshold = fuseAnomalyThreshold;
    this.fuseAnomalyWindowMs = fuseAnomalyWindowMs;
    this.fuseDurationMs = fuseDurationMs;
    this.onFuse = onFuse;
    this.onChange = onChange;
    this.groupTimestamps = new Map();
    this.memberTimestamps = new Map();
    this.failureTimestamps = new Map();
    this.anomalyTimestamps = new Map();
    this.fuses = new Map();
    this.fuseTimers = new Map();
  }

  setBlockedTerms(terms) {
    this.blockedTerms = normalizeBlockedTerms(terms);
    return [...this.blockedTerms];
  }

  matchedBlockedTerm(text) {
    const normalized = String(text || '').toLocaleLowerCase();
    return this.blockedTerms.find((term) => normalized.includes(term)) || '';
  }

  checkInbound({ groupId, userId, text }) {
    const now = this.now();
    const normalizedGroupId = String(groupId);
    const fuse = this.getFuse(normalizedGroupId, now);
    if (fuse) return this.denied(GROUP_SAFETY_STATUS.FUSED, fuse.until - now);
    if (this.matchedBlockedTerm(text)) {
      return this.denied(GROUP_SAFETY_STATUS.POLICY_BLOCKED, null);
    }

    const memberKey = `${normalizedGroupId}:${userId}`;
    const memberTimestamps = activeTimestamps(
      this.memberTimestamps.get(memberKey),
      now - this.memberWindowMs,
    );
    this.memberTimestamps.set(memberKey, memberTimestamps);
    if (memberTimestamps.length >= this.memberLimit) {
      this.recordAnomaly(normalizedGroupId, now);
      return this.denied(
        GROUP_SAFETY_STATUS.MEMBER_RATE_LIMITED,
        memberTimestamps[0] + this.memberWindowMs - now,
      );
    }

    const groupTimestamps = activeTimestamps(
      this.groupTimestamps.get(normalizedGroupId),
      now - this.groupWindowMs,
    );
    this.groupTimestamps.set(normalizedGroupId, groupTimestamps);
    if (groupTimestamps.length >= this.groupLimit) {
      this.recordAnomaly(normalizedGroupId, now);
      return this.denied(
        GROUP_SAFETY_STATUS.GROUP_RATE_LIMITED,
        groupTimestamps[0] + this.groupWindowMs - now,
      );
    }

    memberTimestamps.push(now);
    groupTimestamps.push(now);
    return { allowed: true, status: GROUP_SAFETY_STATUS.ALLOWED, retryAfterMs: 0 };
  }

  checkOutbound({ groupId, text }) {
    const now = this.now();
    const fuse = this.getFuse(groupId, now);
    if (fuse) return this.denied(GROUP_SAFETY_STATUS.FUSED, fuse.until - now);
    if (this.matchedBlockedTerm(text)) {
      return this.denied(GROUP_SAFETY_STATUS.POLICY_BLOCKED, null);
    }
    return { allowed: true, status: GROUP_SAFETY_STATUS.ALLOWED, retryAfterMs: 0 };
  }

  recordFailure(groupId) {
    const now = this.now();
    const normalizedGroupId = String(groupId);
    const timestamps = activeTimestamps(
      this.failureTimestamps.get(normalizedGroupId),
      now - this.fuseFailureWindowMs,
    );
    timestamps.push(now);
    this.failureTimestamps.set(normalizedGroupId, timestamps);
    if (timestamps.length >= this.fuseFailureThreshold) {
      this.trip(normalizedGroupId, 'PIPELINE_FAILURE', now);
    }
  }

  recordSuccess(groupId) {
    this.failureTimestamps.delete(String(groupId));
  }

  recordAnomaly(groupId, now = this.now()) {
    const normalizedGroupId = String(groupId);
    const timestamps = activeTimestamps(
      this.anomalyTimestamps.get(normalizedGroupId),
      now - this.fuseAnomalyWindowMs,
    );
    timestamps.push(now);
    this.anomalyTimestamps.set(normalizedGroupId, timestamps);
    if (timestamps.length >= this.fuseAnomalyThreshold) {
      this.trip(normalizedGroupId, 'RATE_ANOMALY', now);
    }
  }

  trip(groupId, reason, now = this.now()) {
    if (this.getFuse(groupId, now)) return;
    const fuse = {
      groupId: String(groupId),
      reason,
      trippedAt: new Date(now).toISOString(),
      until: now + this.fuseDurationMs,
      untilAt: new Date(now + this.fuseDurationMs).toISOString(),
    };
    this.fuses.set(String(groupId), fuse);
    const timer = setTimeout(() => {
      this.fuseTimers.delete(String(groupId));
      this.getFuse(groupId, this.now());
    }, this.fuseDurationMs);
    timer.unref();
    this.fuseTimers.set(String(groupId), timer);
    this.onChange(this.activeFuses(now));
    this.onFuse(fuse);
  }

  getFuse(groupId, now = this.now()) {
    const normalizedGroupId = String(groupId);
    const fuse = this.fuses.get(normalizedGroupId);
    if (!fuse) return null;
    if (fuse.until > now) return fuse;
    this.fuses.delete(normalizedGroupId);
    const timer = this.fuseTimers.get(normalizedGroupId);
    if (timer) clearTimeout(timer);
    this.fuseTimers.delete(normalizedGroupId);
    this.failureTimestamps.delete(normalizedGroupId);
    this.anomalyTimestamps.delete(normalizedGroupId);
    this.onChange(this.activeFuses(now));
    return null;
  }

  activeFuses(now = this.now()) {
    for (const groupId of [...this.fuses.keys()]) this.getFuse(groupId, now);
    return [...this.fuses.values()].map(({ until, ...fuse }) => fuse);
  }

  denied(status, retryAfterMs) {
    return {
      allowed: false,
      status,
      retryAfterMs: retryAfterMs === null ? null : Math.max(1, Math.ceil(retryAfterMs)),
    };
  }

  stop() {
    for (const timer of this.fuseTimers.values()) clearTimeout(timer);
    this.fuseTimers.clear();
  }
}
