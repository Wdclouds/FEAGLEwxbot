import { RuntimeState } from './state.js';
import { DashboardServer } from './dashboard.js';
import { IdMap } from './id-map.js';
import { parseQuietHours, isQuietTime } from './quiet-hours.js';
import { WechatClient } from './wechat-client.js';
import { AndroidWechatClient } from './android-client.js';
import { OneBotClient } from './onebot-client.js';
import { AstrBotSupervisor } from './astrbot-supervisor.js';
import { MessageGuard } from './message-guard.js';
import { FeishuNotifier } from './feishu-notifier.js';
import { FeishuBindingClient, loadFeishuBinding } from './feishu-binding.js';
import {
  PersistentControlState,
  WECHAT_ADMIN_MODES,
} from './control-state.js';
import { GROUP_CHAT_MODES } from './group-chat.js';
import { GroupSafetyGate } from './group-safety.js';
import { BridgeSettingsStore } from './bridge-settings.js';

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function userIdSet(value) {
  const ids = String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

const state = new RuntimeState();
const settingsStore = new BridgeSettingsStore({
  path: process.env.BRIDGE_SETTINGS_PATH || '/app/data/bridge-settings.json',
});
let settings;
try {
  settings = settingsStore.load();
} catch (error) {
  state.addError('bridge-settings-load', error);
  settings = settingsStore.snapshot();
}
const controlStore = new PersistentControlState({
  path: process.env.BOT_CONTROL_STATE_PATH || '/app/data/control-state.json',
});
let savedControl = {
  wechatAdminMode: WECHAT_ADMIN_MODES.RUNNING,
  groupChatMode: GROUP_CHAT_MODES.OFF,
  groupAllowlist: [],
  groupBlockedTerms: [],
  groupModes: {},
  selfAvatar: null,
  sleepOverride: false,
  changedAt: '',
};
try {
  savedControl = controlStore.load();
} catch (error) {
  state.addError('control-state-load', error);
}
state.patch('wechat', {
  adminMode: savedControl.wechatAdminMode,
  adminModeChangedAt: savedControl.changedAt,
});
state.patch('groupChat', {
  mode: savedControl.groupChatMode,
  allowlist: savedControl.groupAllowlist,
  blockedTerms: savedControl.groupBlockedTerms,
  groupModes: savedControl.groupModes,
});
if (savedControl.selfAvatar) {
  state.setSelfAvatar(savedControl.selfAvatar);
}
const quietRange = parseQuietHours(settings.quietHours);
const timezone = settings.timezone;
// 休眠豁免（解除时限）：休眠时段内也正常回复；休眠结束由 updateSchedule 自动重置
let sleepOverride = savedControl.sleepOverride;
state.patch('schedule', {
  timezone,
  quietHours: settings.quietHours,
  sleepOverride,
});
let testMode = false;
const sleeping = () => !testMode && !sleepOverride && isQuietTime(new Date(), quietRange, timezone);

const updateSchedule = () => {
  // 休眠时段结束后自动关闭豁免（下次休眠默认又只收不回复）
  if (sleepOverride && !isQuietTime(new Date(), quietRange, timezone)) {
    sleepOverride = false;
    try {
      controlStore.saveSleepOverride(false);
    } catch (error) {
      state.addError('sleep-override-reset', error);
    }
  }
  state.setSchedule({
    mode: testMode ? 'TEST' : (sleeping() ? 'SLEEPING' : 'ACTIVE'),
    testMode,
    sleepOverride,
  });
};

const setTestMode = (enabled) => {
  testMode = Boolean(enabled);
  updateSchedule();
  console.log(`[Schedule] test mode ${testMode ? 'enabled' : 'disabled'}`);
  return state.snapshot();
};

const feishuBindingPath = process.env.FEISHU_BINDING_PATH || '/app/data/feishu/binding.json';
let savedFeishuBinding = null;
try {
  savedFeishuBinding = loadFeishuBinding(feishuBindingPath);
} catch (error) {
  state.addError('feishu-binding-store', error);
}
const notifier = new FeishuNotifier({
  state,
  receiveId: savedFeishuBinding?.receiveId || '',
  receiveIdType: savedFeishuBinding?.receiveIdType || 'open_id',
});
const feishuBinding = new FeishuBindingClient({
  state,
  notifier,
  bindingPath: feishuBindingPath,
});
let wechat;
const dashboard = new DashboardServer({
  state,
  host: '0.0.0.0',
  port: Number(process.env.BOT_DASHBOARD_PORT || 6190),
  setTestMode,
  sendNotificationTest: () => notifier.sendTest(),
  forceWechatRelogin: async () => {
    notifier.beginReloginTest();
    try {
      return await wechat.forceReloginTest();
    } catch (error) {
      notifier.cancelReloginTest();
      throw error;
    }
  },
  setWechatAdminMode: async (mode) => {
    controlStore.save(mode);
    if (mode === WECHAT_ADMIN_MODES.MANUAL_OFFLINE) {
      notifier.cancelReloginTest();
    }
    return wechat.setAdminMode(mode);
  },
  setSleepOverride: async (enabled) => {
    sleepOverride = Boolean(enabled);
    controlStore.saveSleepOverride(sleepOverride);
    updateSchedule();
    console.log(`[Schedule] sleep override ${sleepOverride ? 'enabled (时限已解除)' : 'disabled'}`);
    return state.snapshot();
  },
  setGroupChatConfig: async (mode, allowlist, blockedTerms) => {
    controlStore.saveGroupChatConfig(mode, allowlist, blockedTerms);
    return wechat.setGroupChatConfig(mode, allowlist, blockedTerms);
  },
  setGroupChatMode: async (groupId, mode) => {
    controlStore.saveGroupMode(groupId, mode);
    state.setGroupMode(groupId, mode);
    wechat?.setGroupMode?.(groupId, mode);
    return state.snapshot();
  },
  getBridgeSettings: () => settingsStore.snapshot(),
  saveBridgeSettings: (changes) => {
    const saved = settingsStore.save(changes);
    state.patch('transport', {
      requested: saved.transport,
      switching: true,
      restartRequired: true,
      detail: '设置已保存，Bridge 正在重启 / Restarting',
    });
    setTimeout(() => shutdown('DASHBOARD_SETTINGS_RESTART', 0), 500).unref();
    return { settings: saved, state: state.snapshot() };
  },
  switchTransport: (nextTransport) => {
    if (
      nextTransport === 'android'
      && String(process.env.ANDROID_BRIDGE_TOKEN || '').trim().length < 24
    ) {
      throw new Error('Android 配对密钥未配置，请先运行 ./wxbot-bridge setup');
    }
    const saved = settingsStore.save({ transport: nextTransport });
    state.patch('transport', {
      requested: saved.transport,
      switching: true,
      restartRequired: true,
      detail: '正在切换消息通道 / Switching transport',
    });
    setTimeout(() => shutdown('DASHBOARD_TRANSPORT_SWITCH', 0), 500).unref();
    return { settings: saved, state: state.snapshot() };
  },
});
const idMap = new IdMap();
idMap.pruneMessageReceipts();
// 重启后恢复已知群列表（idMap 持久化的 group 实体），避免 discovered 空白
try {
  state.restoreGroups(idMap.listGroups());
} catch (error) {
  state.addError('idmap-list-groups', error);
}
const groupSafety = new GroupSafetyGate({
  blockedTerms: savedControl.groupBlockedTerms,
  memberLimit: settings.groupMemberRateLimit,
  memberWindowMs: settings.groupMemberRateWindowMs,
  groupLimit: settings.groupRateLimit,
  groupWindowMs: settings.groupRateWindowMs,
  onChange: (fuses) => state.patch('groupChat', { fuses }),
  onFuse: (fuse) => {
    state.incrementGroup('fused');
    const group = idMap.contact(fuse.groupId);
    void notifier.sendGroupFuseAlert({
      ...fuse,
      groupName: group?.nickname || `群 ${fuse.groupId}`,
    }).catch(() => {});
  },
});
const astrbot = new AstrBotSupervisor({ state });
const messageGuard = new MessageGuard({
  maxCodePoints: settings.maxMessageChars,
  duplicateTtlMs: positiveInteger(process.env.BOT_DUPLICATE_TTL_MS, 5 * 60_000),
  perUserLimit: settings.userRateLimit,
  perUserWindowMs: settings.userRateWindowMs,
  globalLimit: settings.globalRateLimit,
  globalWindowMs: settings.globalRateWindowMs,
  allowUserIds: userIdSet(process.env.BOT_ALLOW_USER_IDS),
  blockUserIds: userIdSet(process.env.BOT_BLOCK_USER_IDS),
});

let onebot;
const transport = settings.transport;
state.patch('transport', {
  active: transport,
  requested: transport,
  switching: false,
  restartRequired: false,
  detail: transport === 'android'
    ? 'Android Hook transport'
    : 'Wechat4u Web transport',
});
if (transport !== 'android') {
  state.patch('android', { serverStatus: 'DISABLED' });
}
const commonWechatOptions = {
  state,
  idMap,
  isSleeping: sleeping,
  messageGuard,
  initialAdminMode: savedControl.wechatAdminMode,
  onPrivateText: async (message) => onebot.sendPrivateText(message),
  onGroupText: async (message) => onebot.sendGroupText(message),
  onPrivateImage: async (message) => onebot.sendPrivateImage(message),
  onGroupImage: async (message) => onebot.sendGroupImage(message),
  onSelfAvatar: async (message) => {
    try {
      controlStore.saveSelfAvatar(message);
    } catch (error) {
      state.addError('control-state-self-avatar', error);
    }
  },
  initialGroupChatMode: savedControl.groupChatMode,
  initialGroupAllowlist: savedControl.groupAllowlist,
  initialGroupBlockedTerms: savedControl.groupBlockedTerms,
  initialGroupModes: savedControl.groupModes,
  groupSafety,
  groupReplyCooldownMs: settings.groupReplyCooldownMs,
  groupReplyMaxChars: settings.groupReplyMaxChars,
  groupJitterMinMs: settings.groupJitterMinMs,
  groupJitterMaxMs: settings.groupJitterMaxMs,
};
if (transport === 'android') {
  wechat = new AndroidWechatClient(commonWechatOptions);
} else if (transport === 'wechat4u') {
  wechat = new WechatClient({
    ...commonWechatOptions,
    onFatal: (error) => {
      state.addError('wechat-fatal', error);
      shutdown('WECHAT_WATCHDOG', 1);
    },
    onReloginOutcome: (outcome) => notifier.finishReloginTest(outcome),
  });
} else {
  throw new Error(`Unsupported WECHAT_TRANSPORT: ${transport}`);
}

const bridgeSelfId = idMap.entity(
  'self',
  'feagle:bridge',
  'feagle:bridge',
  'FEAGLE WxBot',
);
onebot = new OneBotClient({
  state,
  idMap,
  wechat,
  selfId: bridgeSelfId,
  isSleeping: sleeping,
  maxInFlight: settings.maxInFlight,
  maxInFlightPerUser: settings.maxInFlightPerUser,
});

updateSchedule();
const scheduleTimer = setInterval(updateSchedule, 30_000);
scheduleTimer.unref();

async function main() {
  await dashboard.start();
  notifier.start();
  feishuBinding.start();
  astrbot.start();
  await wechat.start();
  onebot.start();
}

let shuttingDown = false;
function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.exitCode = exitCode;
  console.log(`[Runtime] received ${signal}, shutting down`);
  clearInterval(scheduleTimer);
  feishuBinding.stop();
  notifier.stop();
  groupSafety.stop();
  onebot.stop();
  wechat.shutdown();
  astrbot.stop();
  dashboard.stop();
  idMap.close();
  const exitTimer = setTimeout(() => process.exit(exitCode), 1_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (error) => {
  state.addError('uncaughtException', error);
  console.error(error);
});
process.on('unhandledRejection', (error) => {
  state.addError('unhandledRejection', error);
  console.error(error);
});

main().catch((error) => {
  state.addError('startup', error);
  console.error(error);
  setTimeout(() => process.exit(1), 1_000).unref();
});
