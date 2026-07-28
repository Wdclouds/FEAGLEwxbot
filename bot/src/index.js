import { RuntimeState } from './state.js';
import { DashboardServer } from './dashboard.js';
import { IdMap } from './id-map.js';
import { parseQuietHours, isQuietTime } from './quiet-hours.js';
import { WechatClient } from './wechat-client.js';
import { OneBotClient } from './onebot-client.js';
import { AstrBotSupervisor } from './astrbot-supervisor.js';
import { MessageGuard } from './message-guard.js';
import { FeishuNotifier } from './feishu-notifier.js';
import { FeishuBindingClient, loadFeishuBinding } from './feishu-binding.js';

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
const quietRange = parseQuietHours(process.env.BOT_QUIET_HOURS || '00:00-07:00');
const timezone = process.env.BOT_TIMEZONE || 'Asia/Shanghai';
let testMode = false;
const sleeping = () => !testMode && isQuietTime(new Date(), quietRange, timezone);

const updateSchedule = () => state.setSchedule({
  mode: testMode ? 'TEST' : (sleeping() ? 'SLEEPING' : 'ACTIVE'),
  testMode,
});

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
});
const idMap = new IdMap();
const astrbot = new AstrBotSupervisor({ state });
const messageGuard = new MessageGuard({
  maxCodePoints: positiveInteger(process.env.BOT_MAX_MESSAGE_CHARS, 2_000),
  duplicateTtlMs: positiveInteger(process.env.BOT_DUPLICATE_TTL_MS, 5 * 60_000),
  perUserLimit: positiveInteger(process.env.BOT_USER_RATE_LIMIT, 3),
  perUserWindowMs: positiveInteger(process.env.BOT_USER_RATE_WINDOW_MS, 30_000),
  globalLimit: positiveInteger(process.env.BOT_GLOBAL_RATE_LIMIT, 30),
  globalWindowMs: positiveInteger(process.env.BOT_GLOBAL_RATE_WINDOW_MS, 60_000),
  allowUserIds: userIdSet(process.env.BOT_ALLOW_USER_IDS),
  blockUserIds: userIdSet(process.env.BOT_BLOCK_USER_IDS),
});

let onebot;
wechat = new WechatClient({
  state,
  idMap,
  isSleeping: sleeping,
  messageGuard,
  onFatal: (error) => {
    state.addError('wechat-fatal', error);
    shutdown('WECHAT_WATCHDOG', 1);
  },
  onReloginOutcome: (outcome) => notifier.finishReloginTest(outcome),
  onPrivateText: async (message) => onebot.sendPrivateText(message),
});

onebot = new OneBotClient({
  state,
  idMap,
  wechat,
  isSleeping: sleeping,
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
