import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { parseQuietHours } from './quiet-hours.js';

export const TRANSPORTS = Object.freeze(['wechat4u', 'android']);

const INTEGER_RANGES = Object.freeze({
  maxMessageChars: [100, 10_000],
  userRateLimit: [1, 100],
  userRateWindowMs: [1_000, 3_600_000],
  globalRateLimit: [1, 1_000],
  globalRateWindowMs: [1_000, 3_600_000],
  maxInFlight: [1, 100],
  maxInFlightPerUser: [1, 20],
  groupReplyCooldownMs: [0, 3_600_000],
  groupReplyMaxChars: [1, 2_000],
  groupJitterMinMs: [0, 60_000],
  groupJitterMaxMs: [0, 60_000],
  groupMemberRateLimit: [1, 100],
  groupMemberRateWindowMs: [1_000, 3_600_000],
  groupRateLimit: [1, 1_000],
  groupRateWindowMs: [1_000, 3_600_000],
});

export const SAFE_SETTING_KEYS = Object.freeze([
  'transport',
  'quietHours',
  'timezone',
  ...Object.keys(INTEGER_RANGES),
]);

function integer(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

export function settingsDefaults(env = process.env) {
  return {
    transport: String(env.WECHAT_TRANSPORT || 'wechat4u').trim().toLowerCase(),
    quietHours: env.BOT_QUIET_HOURS || '00:00-07:00',
    timezone: env.BOT_TIMEZONE || 'Asia/Shanghai',
    maxMessageChars: integer(env.BOT_MAX_MESSAGE_CHARS, 2_000),
    userRateLimit: integer(env.BOT_USER_RATE_LIMIT, 3),
    userRateWindowMs: integer(env.BOT_USER_RATE_WINDOW_MS, 30_000),
    globalRateLimit: integer(env.BOT_GLOBAL_RATE_LIMIT, 30),
    globalRateWindowMs: integer(env.BOT_GLOBAL_RATE_WINDOW_MS, 60_000),
    maxInFlight: integer(env.BOT_MAX_INFLIGHT, 3),
    maxInFlightPerUser: integer(env.BOT_MAX_INFLIGHT_PER_USER, 1),
    groupReplyCooldownMs: integer(env.BOT_GROUP_REPLY_COOLDOWN_MS, 5_000),
    groupReplyMaxChars: integer(env.BOT_MAX_GROUP_REPLY_CHARS, 1_000),
    groupJitterMinMs: integer(env.BOT_GROUP_JITTER_MIN_MS, 1_000),
    groupJitterMaxMs: integer(env.BOT_GROUP_JITTER_MAX_MS, 3_000),
    groupMemberRateLimit: integer(env.BOT_GROUP_MEMBER_RATE_LIMIT, 3),
    groupMemberRateWindowMs: integer(env.BOT_GROUP_MEMBER_RATE_WINDOW_MS, 60_000),
    groupRateLimit: integer(env.BOT_GROUP_RATE_LIMIT, 6),
    groupRateWindowMs: integer(env.BOT_GROUP_RATE_WINDOW_MS, 60_000),
  };
}

function validateTimezone(value) {
  const timezone = String(value || '').trim();
  if (!timezone || timezone.length > 64) throw new TypeError('Invalid timezone');
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format(new Date());
  } catch {
    throw new TypeError('Invalid timezone');
  }
  return timezone;
}

export function normalizeBridgeSettings(input, defaults = settingsDefaults()) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const unknown = Object.keys(source).filter((key) => !SAFE_SETTING_KEYS.includes(key));
  if (unknown.length) throw new TypeError(`Unsupported setting: ${unknown[0]}`);
  const merged = { ...defaults, ...source };
  if (!TRANSPORTS.includes(merged.transport)) {
    throw new TypeError('transport must be wechat4u or android');
  }
  parseQuietHours(String(merged.quietHours));
  merged.quietHours = String(merged.quietHours);
  merged.timezone = validateTimezone(merged.timezone);
  for (const [key, [minimum, maximum]] of Object.entries(INTEGER_RANGES)) {
    const value = Number(merged[key]);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new TypeError(`${key} must be an integer between ${minimum} and ${maximum}`);
    }
    merged[key] = value;
  }
  if (merged.groupJitterMinMs > merged.groupJitterMaxMs) {
    throw new TypeError('groupJitterMinMs cannot exceed groupJitterMaxMs');
  }
  if (merged.maxInFlightPerUser > merged.maxInFlight) {
    throw new TypeError('maxInFlightPerUser cannot exceed maxInFlight');
  }
  return Object.fromEntries(SAFE_SETTING_KEYS.map((key) => [key, merged[key]]));
}

export class BridgeSettingsStore {
  constructor({
    path = process.env.BRIDGE_SETTINGS_PATH || '/app/data/bridge-settings.json',
    defaults = settingsDefaults(),
  } = {}) {
    this.path = path;
    this.defaults = normalizeBridgeSettings({}, defaults);
    this.settings = this.defaults;
  }

  load() {
    if (!existsSync(this.path)) {
      this.settings = this.defaults;
      return { ...this.settings };
    }
    const stored = JSON.parse(readFileSync(this.path, 'utf8'));
    this.settings = normalizeBridgeSettings(stored, this.defaults);
    return { ...this.settings };
  }

  save(changes) {
    const next = normalizeBridgeSettings(changes, this.settings);
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temporary, this.path);
    this.settings = next;
    return { ...next };
  }

  snapshot() {
    return { ...this.settings };
  }
}
