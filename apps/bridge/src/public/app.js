const $ = (id) => document.getElementById(id);

const metricLabels = {
  received: '已接收',
  forwarded: '已转发',
  replied: '已回复',
  dropped: '已丢弃',
  blocked: '已拦截',
  failed: '失败',
};

const statusLabels = {
  STARTING: '启动中 / STARTING',
  RESTORING: '恢复中 / RESTORING',
  WAITING_SCAN: '等待扫码 / WAITING SCAN',
  WAITING_AGENT: '等待 Agent / WAITING AGENT',
  WAITING_HOOK: '等待 Hook / WAITING HOOK',
  WAITING: '等待连接 / WAITING',
  LISTENING: '正在监听 / LISTENING',
  STOPPED: '已停止 / STOPPED',
  SCANNED: '已扫码 / SCANNED',
  ONLINE: '在线 / ONLINE',
  CONNECTED: '已连接 / CONNECTED',
  READY: '就绪 / READY',
  RUNNING: '运行中 / RUNNING',
  ACTIVE: '运行中 / ACTIVE',
  TEST: '测试中 / TEST',
  SLEEPING: '休眠中 / SLEEPING',
  PAUSED: '暂停回复 / PAUSED',
  MANUAL_OFFLINE: '紧急离线 / MANUAL OFFLINE',
  LOGGING_OUT: '正在下线 / LOGGING OUT',
  LOGGED_OUT: '已退出 / LOGGED OUT',
  DISCONNECTED: '未连接 / DISCONNECTED',
  DISABLED: '未启用 / DISABLED',
  WAITING_BIND: '等待绑定 / WAITING BIND',
  BOUND: '已绑定 / BOUND',
  UNBOUND: '未绑定 / UNBOUND',
  DEGRADED: '连接异常 / DEGRADED',
  RECOVERING: '自动修复 / RECOVERING',
  ERROR: '错误 / ERROR',
  EXITED: '已退出 / EXITED',
  UNKNOWN: '未知 / UNKNOWN',
  HEALTHY: '健康 / HEALTHY',
  STALE: '同步超时 / STALE',
  FAILED: '失败 / FAILED',
  OFFLINE: '离线 / OFFLINE',
  SENDING: '发送中 / SENDING',
  OFF: '已关闭 / OFF',
  OBSERVE: '仅观察 / OBSERVE',
  MENTION_ONLY: '被 @ 时回复 / MENTION ONLY',
};

const messageStatusLabels = {
  RECEIVED: 'RECEIVED',
  SENT: 'SENT',
  'SLEEP-DROP': 'SLEEP DROP',
  'ADMIN-PAUSED': 'PAUSED',
  'UPSTREAM-BUSY': 'BUSY',
  'FORWARD-FAILED': 'FAILED',
  'DUPLICATE-REPLAY': 'REPLAY BLOCKED',
  'STALE-REPLAY': 'STALE BLOCKED',
  'GROUP-OFF': 'GROUP OFF',
  'GROUP-OBSERVED': 'OBSERVED',
  'GROUP-NOT-ALLOWED': 'NOT ALLOWED',
  'GROUP-NOT-MENTIONED': 'NOT MENTIONED',
  'GROUP-EMPTY-MENTION': 'EMPTY MENTION',
  'GROUP-MENTION': 'GROUP MENTION',
  'GROUP-SENT': 'GROUP SENT',
  'GROUP-POLICY-BLOCKED': 'POLICY BLOCKED',
  'GROUP-MEMBER-RATE-LIMITED': 'MEMBER RATE',
  'GROUP-RATE-LIMITED': 'GROUP RATE',
  'GROUP-FUSED': 'GROUP FUSED',
};

function bilingualStatus(value) {
  return statusLabels[value] || value || '--';
}

function time(value) {
  if (!value) return '--:--:--';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(value));
}

function duration(startedAt) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(startedAt)) / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${days}天 / d ${String(hours).padStart(2, '0')}时 / h ${String(minutes).padStart(2, '0')}分 / m`;
}

function setService(key, status, detail) {
  $(`${key}-status`).textContent = bilingualStatus(status);
  const detailNode = $(`${key}-detail`);
  if (detailNode) detailNode.textContent = detail || '';
  const service = document.querySelector(`.service[data-key="${key}"]`);
  const active = ['ONLINE', 'CONNECTED', 'READY', 'RUNNING', 'ACTIVE'].includes(status);
  const testing = status === 'TEST';
  const bad = ['ERROR', 'EXITED', 'LOGGED_OUT', 'MANUAL_OFFLINE'].includes(status);
  const color = active
    ? 'var(--accent)'
    : bad
      ? 'var(--red)'
      : testing
        ? 'var(--blue)'
        : 'var(--amber)';
  service.querySelector('i').style.background = color;
  service.querySelector('span').style.color = color;
}

function renderAdminMode(state) {
  const mode = state.wechat.adminMode || 'RUNNING';
  const badge = $('admin-mode-badge');
  const pauseButton = $('pause-toggle');
  const offlineButton = $('manual-offline-toggle');
  const offlineHint = $('manual-offline-hint');
  badge.dataset.mode = mode;
  badge.textContent = bilingualStatus(mode);

  if (mode === 'MANUAL_OFFLINE') {
    $('admin-mode-hint').textContent = '微信与自动恢复已停止 / WeChat & auto-heal stopped';
    pauseButton.disabled = true;
    pauseButton.textContent = '暂停回复';
    offlineButton.textContent = '恢复运行';
    if (offlineHint) offlineHint.innerHTML =
      '当前不会自动重连或推送二维码。<span>No reconnect or QR alerts while manually offline.</span>';
  } else if (mode === 'PAUSED') {
    $('admin-mode-hint').textContent = '微信保持在线但不回复 / Connected without replies';
    pauseButton.disabled = false;
    pauseButton.textContent = '恢复回复';
    offlineButton.textContent = '紧急离线';
    if (offlineHint) offlineHint.innerHTML =
      '消息会被记录为暂停丢弃；连接与心跳仍保持。<span>Messages are dropped; session and heartbeat stay active.</span>';
  } else {
    $('admin-mode-hint').textContent = '正常接收并回复消息 / Processing messages';
    pauseButton.disabled = false;
    pauseButton.textContent = '暂停回复';
    offlineButton.textContent = '紧急离线';
    if (offlineHint) offlineHint.innerHTML =
      '紧急离线会退出微信，并停止自动重连和二维码通知。<span>Logs out WeChat and suppresses auto-heal & QR alerts.</span>';
  }

  pauseButton.dataset.mode = mode;
  offlineButton.dataset.mode = mode;
}

function allowlistFromInput() {
  return Array.from(new Set($('group-allowlist').value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => /^\d+$/.test(item))));
}

function blockedTermsFromInput() {
  return Array.from(new Set($('group-blocked-terms').value
    .split(/\r?\n/)
    .map((item) => item.trim().toLocaleLowerCase())
    .filter(Boolean)))
    .slice(0, 100);
}

function renderGroupChat(state) {
  const groupChat = state.groupChat || {
    mode: 'OFF',
    allowlist: [],
    discovered: [],
  };
  const badge = $('group-mode-badge');
  badge.dataset.mode = groupChat.mode;
  badge.textContent = bilingualStatus(groupChat.mode);
  if (document.activeElement !== $('group-mode')) $('group-mode').value = groupChat.mode;
  if (document.activeElement !== $('group-allowlist')) {
    $('group-allowlist').value = (groupChat.allowlist || []).join(', ');
  }
  if (document.activeElement !== $('group-blocked-terms')) {
    $('group-blocked-terms').value = (groupChat.blockedTerms || []).join('\n');
  }
  $('group-observed').textContent = groupChat.observed || 0;
  $('group-forwarded').textContent = groupChat.forwarded || 0;
  $('group-replied').textContent = groupChat.replied || 0;
  $('group-blocked').textContent = groupChat.blocked || 0;
  $('group-policy-blocked').textContent = groupChat.policyBlocked || 0;
  $('group-rate-limited').textContent = groupChat.rateLimited || 0;
  $('group-fused').textContent = groupChat.fused || 0;
  const fuses = groupChat.fuses || [];
  const fuseStatus = $('group-fuse-status');
  fuseStatus.classList.toggle('active', fuses.length > 0);
  fuseStatus.textContent = fuses.length
    ? fuses.map((fuse) => (
      `群 ${fuse.groupId} · ${fuse.reason} · 至 / UNTIL ${time(fuse.untilAt)}`
    )).join(' | ')
    : '没有群聊熔断 / NO ACTIVE FUSES';

  const discovered = groupChat.discovered || [];
  if (!discovered.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-inline';
    empty.textContent = '尚未发现群聊 / No groups discovered';
    $('group-list').replaceChildren(empty);
    return;
  }
  $('group-list').replaceChildren(...discovered.map((group) => {
    const button = document.createElement('button');
    button.className = 'group-chip';
    button.type = 'button';
    button.dataset.groupId = group.groupId;
    const name = document.createElement('strong');
    name.textContent = group.name;
    const meta = document.createElement('small');
    meta.textContent = `ID ${group.groupId} · ${group.memberCount || 0} members`;
    button.append(name, meta);
    button.addEventListener('click', () => {
      const values = new Set(allowlistFromInput());
      values.add(String(group.groupId));
      $('group-allowlist').value = [...values].join(', ');
      $('group-config-hint').textContent =
        `已加入输入框 / Added：${group.name}；点击保存后生效 / Save to apply`;
    });
    return button;
  }));
}

function render(state) {
  renderAdminMode(state);
  renderGroupChat(state);
  const transport = state.transport || { active: 'wechat4u', detail: '' };
  const android = state.android || {};
  const androidActive = transport.active === 'android';
  $('transport-current').textContent = androidActive ? 'Android Hook' : 'Wechat4u Web';
  $('android-diagnostics').hidden = !androidActive;
  if (androidActive) {
    $('android-server').textContent = `${bilingualStatus(android.serverStatus)} · ${android.endpoint || '--'}`;
    $('android-device').textContent = `${bilingualStatus(android.deviceStatus)} · ${android.deviceIdMasked || '--'}`;
    $('android-hook').textContent = android.hookConnected
      ? '已连接 / CONNECTED'
      : '未连接 / DISCONNECTED';
    const hbAge = android.heartbeatAgeMs;
    const hbTimeout = android.heartbeatTimeoutMs || 75_000;
    const hbEl = $('android-heartbeat');
    hbEl.textContent = android.lastHeartbeatAt
      ? `${time(android.lastHeartbeatAt)} · ${Math.round((hbAge || 0) / 1000)}s / ${Math.round(hbTimeout / 1000)}s`
      : '--';
    if (hbAge == null) delete hbEl.dataset.status;
    else hbEl.dataset.status = hbAge >= hbTimeout ? 'crit' : (hbAge >= hbTimeout * 0.6 ? 'warn' : 'ok');
    $('android-pending').textContent = android.pendingCommands || 0;
  }
  $('account').textContent = state.wechat.account || '--';
  $('session-status').textContent = bilingualStatus(state.wechat.status);
  $('protocol-health').textContent = bilingualStatus(state.wechat.protocolHealth || 'UNKNOWN');
  $('protocol-health').dataset.status = state.wechat.protocolHealth || 'UNKNOWN';
  const syncAge = state.wechat.syncAgeMs;
  const syncDegraded = state.wechat.degradedAfterMs || 90_000;
  const lastSyncEl = $('last-sync');
  lastSyncEl.textContent = state.wechat.lastSyncAt
    ? `上次 / LAST ${time(state.wechat.lastSyncAt)} · ${Math.max(0, Math.round((syncAge || 0) / 1000))}s`
    : '上次同步 / LAST --';
  if (syncAge == null) delete lastSyncEl.dataset.status;
  else lastSyncEl.dataset.status = syncAge >= syncDegraded ? 'crit' : (syncAge >= syncDegraded * 0.6 ? 'warn' : 'ok');
  $('recovery-attempts').textContent = state.wechat.recoveryAttempts || 0;
  $('sync-errors').textContent =
    `错误 / ERRORS ${state.wechat.syncErrors || 0} · 连续 / STREAK ${state.wechat.consecutiveSyncErrors || 0}`;
  $('wechat-status').textContent = bilingualStatus(state.wechat.status);
  $('wechat-detail').textContent = state.wechat.detail;
  $('qr-time').textContent = state.wechat.qrCreatedAt
    ? `二维码生成 / QR ISSUED ${time(state.wechat.qrCreatedAt)}`
    : state.wechat.detail;

  const hasQr = Boolean(state.wechat.qrDataUrl);
  $('qr').src = hasQr ? state.wechat.qrDataUrl : '';
  $('qr').style.display = hasQr ? 'block' : 'none';
  $('qr-placeholder').style.display = hasQr ? 'none' : 'grid';

  setService('astrbot', state.astrbot.status, state.astrbot.detail);
  setService(
    'onebot',
    state.onebot.status,
    `${state.onebot.detail} · 处理中 / IN FLIGHT ${state.onebot.inFlight || 0}`,
  );
  const notifications = state.notifications || {
    status: 'DISABLED',
    detail: '飞书通知尚未配置 / Feishu is not configured',
  };
  setService('notifications', notifications.status, [
    notifications.detail,
    notifications.lastSentAt ? `上次 / LAST ${time(notifications.lastSentAt)}` : '',
  ].filter(Boolean).join(' · '));
  setService('schedule', state.schedule.mode);
  $('timezone').textContent = state.schedule.timezone;
  $('quiet-hours').textContent = state.schedule.quietHours;

  const testMode = Boolean(state.schedule.testMode);
  const testButton = $('test-mode-toggle');
  testButton.dataset.enabled = String(testMode);
  testButton.setAttribute('aria-pressed', String(testMode));
  testButton.textContent = testMode
    ? '关闭测试模式'
    : '测试模式';
  const testModeHint = $('test-mode-hint');
  if (testModeHint) testModeHint.textContent = testMode
    ? '已忽略休眠时段'
    : '临时忽略休眠时段';

  const reloginStatus = state.wechat.reloginTestStatus || 'IDLE';
  const reloginButton = $('force-relogin-test');
  const reloginHint = $('force-relogin-hint');
  const reloginRunning = reloginStatus === 'RUNNING';
  reloginButton.disabled = androidActive
    || reloginRunning
    || state.wechat.adminMode !== 'RUNNING';
  reloginButton.textContent = reloginRunning
    ? '等待重新登录'
    : '强制重登测试';
  if (reloginHint) {
    if (androidActive) {
      reloginHint.textContent = 'Android Hook 不使用 Web 扫码重登测试';
    } else if (reloginRunning) {
      reloginHint.textContent = state.wechat.reloginTestDetail || '二维码将发送到飞书私聊';
    } else if (reloginStatus === 'SUCCESS') {
      reloginHint.textContent = `上次成功：${state.wechat.reloginTestDetail}`;
    } else if (reloginStatus === 'FAILED') {
      reloginHint.textContent = `上次失败：${state.wechat.reloginTestDetail}`;
    }
  }

  $('metrics').replaceChildren(...Object.entries(state.counters).map(([key, value]) => {
    const row = document.createElement('div');
    row.className = 'metric-row';
    const name = document.createElement('span');
    name.textContent = metricLabels[key] || key.toUpperCase();
    const num = document.createElement('strong');
    num.textContent = value;
    row.append(name, num);
    return row;
  }));

  if (!state.messages.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 5;
    cell.className = 'empty';
    cell.textContent = '暂无消息流量 / NO MESSAGE TRAFFIC';
    row.append(cell);
    $('messages').replaceChildren(row);
  } else {
    $('messages').replaceChildren(...state.messages.map((message) => {
      const row = document.createElement('tr');
      const direction = message.direction === 'IN' ? 'IN' : 'OUT';
      const messageStatus = messageStatusLabels[message.status] || message.status;
      [time(message.time), direction, message.peer, message.text, messageStatus]
        .forEach((value, index) => {
          const cell = document.createElement('td');
          cell.textContent = value;
          if (index === 4) cell.className = 'status';
          row.append(cell);
        });
      return row;
    }));
  }

  if (!state.errors.length) {
    const p = document.createElement('p');
    const t = document.createElement('time');
    t.textContent = time(state.now);
    const source = document.createElement('span');
    source.textContent = '系统 / SYS';
    p.append(t, source, '没有错误记录 / No errors recorded');
    $('errors').replaceChildren(p);
  } else {
    $('errors').replaceChildren(...state.errors.map((error) => {
      const p = document.createElement('p');
      const t = document.createElement('time');
      t.textContent = time(error.time);
      const source = document.createElement('span');
      source.textContent = error.source;
      p.append(t, source, ` ${error.message}`);
      return p;
    }));
  }
  $('uptime').textContent = `运行时间 / UPTIME ${duration(state.startedAt)}`;
}

function setTheme(theme) {
  const normalized = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = normalized;
  localStorage.setItem('feagle-theme', normalized);
  const logo = $('brand-logo');
  if (logo) logo.src = normalized === 'light'
    ? '/assets/icons/feaglew.svg'
    : '/assets/icons/feagleb.svg';
  $('theme-label').textContent = normalized === 'light'
    ? '白天 / Light'
    : '夜间 / Dark';
}

async function setAdminMode(mode) {
  const response = await fetch('/api/wechat/admin-mode', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-FEAGLE-Dashboard': '1',
    },
    body: JSON.stringify({
      mode,
      confirm: mode === 'MANUAL_OFFLINE' ? 'MANUAL_OFFLINE' : undefined,
    }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || '状态切换失败 / State change failed');
  render(payload);
}

// ─────────────────────────────────────────────────────────────
// 视图路由（hash-based SPA）
// ─────────────────────────────────────────────────────────────
const VIEWS = ['overview', 'traffic', 'groups', 'settings-traffic'];

function currentView() {
  const hash = window.location.hash.replace(/^#\/?/, '');
  return VIEWS.includes(hash) ? hash : 'overview';
}

function applyView(view) {
  document.querySelectorAll('.view').forEach((section) => {
    section.classList.toggle('active', section.dataset.view === view);
  });
  document.querySelectorAll('.bottom-nav a').forEach((link) => {
    link.classList.toggle('active', link.dataset.viewLink === view);
  });
  // 懒加载设置数据：总览（通道 radio 初始化）与流量安全
  if (view === 'overview' || view === 'settings-traffic') {
    loadSettings();
  }
  window.scrollTo(0, 0);
}

function navigate() {
  applyView(currentView());
}

// ─────────────────────────────────────────────────────────────
// 设置页逻辑（合并自原 settings.js）
// ─────────────────────────────────────────────────────────────
let activeTransport = 'wechat4u';

function mutationHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-FEAGLE-Dashboard': '1',
  };
}

function renderSettings(settings) {
  activeTransport = settings.transport;
  $('transport-current').textContent = activeTransport === 'android' ? 'Android Hook' : 'Wechat4u Web';
  document.querySelector(`input[name="transport"][value="${activeTransport}"]`).checked = true;
  for (const input of document.querySelectorAll('[data-setting]')) {
    const scale = Number(input.dataset.scale || 1);
    input.value = Number.isFinite(Number(settings[input.dataset.setting]))
      && input.type === 'number'
      ? Number(settings[input.dataset.setting]) / scale
      : settings[input.dataset.setting] ?? '';
  }
}

function collectSettings(form) {
  const values = {};
  for (const input of form.querySelectorAll('[data-setting]')) {
    const key = input.dataset.setting;
    if (input.type === 'radio') {
      // 单选组只提交选中的值
      if (input.checked) values[key] = input.value;
    } else if (input.type === 'number') {
      const scale = Number(input.dataset.scale || 1);
      values[key] = Math.round(Number(input.value) * scale);
    } else {
      values[key] = input.value.trim();
    }
  }
  return values;
}

async function loadSettings() {
  try {
    const response = await fetch('/api/settings');
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '读取设置失败');
    renderSettings(payload.settings);
  } catch (error) {
    const statusEl = $('save-status-transport') || $('save-status-limits');
    if (statusEl) statusEl.textContent = `读取失败 / Load failed: ${error.message}`;
  }
}

// 保存表单（transport 或 limits 视图）
function bindSave(formId, statusId) {
  const target = $(`save-${formId}`);
  if (!target) return; // 容错：按钮 id 不匹配时静默跳过，避免中断整个脚本（2026-08-05 实测 save-limits 缺失导致 initGlassSurface 永远不执行）
  target.addEventListener('click', async () => {
    const form = $(`${formId}-settings-form`);
    const button = $(`save-${formId}`);
    const status = $(statusId); // 可能为 null（UI 已删提示元素），容错处理
    if (!form.reportValidity()) return;
    button.disabled = true;
    if (status) status.textContent = '正在校验并保存 / Validating and saving...';
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: mutationHeaders(),
        body: JSON.stringify(collectSettings(form)),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '保存失败');
      if (status) status.textContent = '设置已保存，Bridge 正在重启；数秒后刷新页面 / Restarting, refresh shortly.';
    } catch (error) {
      if (status) status.textContent = `保存失败 / Failed: ${error.message}`;
      button.disabled = false;
    }
  });
}

// ─────────────────────────────────────────────────────────────
// 事件绑定
// ─────────────────────────────────────────────────────────────
setInterval(() => {
  $('clock').textContent = time(new Date());
}, 1000);

setTheme(document.documentElement.dataset.theme);
fetch('/api/status').then((response) => response.json()).then(render);
const events = new EventSource('/events');
events.onmessage = (event) => render(JSON.parse(event.data));

window.addEventListener('hashchange', navigate);
applyView(currentView());

$('theme-toggle').addEventListener('click', () => {
  setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

$('pause-toggle').addEventListener('click', async () => {
  const button = $('pause-toggle');
  const currentMode = button.dataset.mode || 'RUNNING';
  button.disabled = true;
  try {
    await setAdminMode(currentMode === 'PAUSED' ? 'RUNNING' : 'PAUSED');
  } catch (error) {
    const offlineHint2 = $('manual-offline-hint');
    if (offlineHint2) offlineHint2.textContent = `切换失败 / Failed：${error.message}`;
  } finally {
    if (button.dataset.mode !== 'MANUAL_OFFLINE') button.disabled = false;
  }
});

$('manual-offline-toggle').addEventListener('click', async () => {
  const button = $('manual-offline-toggle');
  const currentMode = button.dataset.mode || 'RUNNING';
  const nextMode = currentMode === 'MANUAL_OFFLINE' ? 'RUNNING' : 'MANUAL_OFFLINE';
  if (
    nextMode === 'MANUAL_OFFLINE'
    && !window.confirm(
      '紧急离线会注销当前微信 Session，并停止自动重连和飞书二维码通知。恢复时需要重新扫码。\n\nEmergency offline logs out WeChat and suppresses reconnect/QR alerts. A new scan is required to resume.\n\n确认继续 / Continue?',
    )
  ) return;

  button.disabled = true;
  try {
    await setAdminMode(nextMode);
  } catch (error) {
    const offlineHint2 = $('manual-offline-hint');
    if (offlineHint2) offlineHint2.textContent = `切换失败 / Failed：${error.message}`;
  } finally {
    button.disabled = false;
  }
});

$('group-config-save').addEventListener('click', async () => {
  const button = $('group-config-save');
  const hint = $('group-config-hint');
  const mode = $('group-mode').value;
  const allowlist = allowlistFromInput();
  const blockedTerms = blockedTermsFromInput();
  if (
    mode === 'MENTION_ONLY'
    && !window.confirm(
      '启用后，只有白名单群中明确 @ 机器人的文本才会进入 AstrBot 并可能产生回复。空白名单仍不会回复。\n\nOnly explicit @ messages from allowlisted groups can reach AstrBot. Continue?',
    )
  ) return;
  button.disabled = true;
  hint.textContent = '正在保存 / Saving...';
  try {
    const response = await fetch('/api/group-chat/config', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-FEAGLE-Dashboard': '1',
      },
      body: JSON.stringify({
        mode,
        allowlist,
        blockedTerms,
        confirm: mode === 'MENTION_ONLY' ? 'ENABLE_GROUP_REPLY' : undefined,
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '保存失败 / Save failed');
    render(payload);
    hint.innerHTML = mode === 'OFF'
      ? '群聊已完全关闭。<span>Group processing is fully disabled.</span>'
      : mode === 'OBSERVE'
        ? '仅观察：不会送入 AstrBot 或调用模型。<span>No AstrBot or model calls.</span>'
        : '仅白名单群内明确 @ 才会回复。<span>Allowlist + explicit @ required.</span>';
  } catch (error) {
    hint.textContent = `保存失败 / Failed：${error.message}`;
  } finally {
    button.disabled = false;
  }
});

$('test-mode-toggle').addEventListener('click', async () => {
  const button = $('test-mode-toggle');
  const enabled = button.dataset.enabled === 'true';
  button.disabled = true;
  try {
    const response = await fetch('/api/test-mode', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-FEAGLE-Dashboard': '1',
      },
      body: JSON.stringify({ enabled: !enabled }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '切换失败 / Toggle failed');
    render(payload);
  } catch (error) {
    const testModeHint2 = $('test-mode-hint');
    if (testModeHint2) testModeHint2.textContent = `切换失败 / Failed：${error.message}`;
  } finally {
    button.disabled = false;
  }
});

$('notification-test').addEventListener('click', async () => {
  const button = $('notification-test');
  const hint = $('notification-test-hint');
  button.disabled = true;
  if (hint) hint.textContent = '正在发送 / Sending...';
  try {
    const response = await fetch('/api/notifications/test', {
      method: 'POST',
      headers: { 'X-FEAGLE-Dashboard': '1' },
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '发送失败 / Send failed');
    render(payload);
    if (hint) hint.textContent = '已发送，请检查飞书';
  } catch (error) {
    if (hint) hint.textContent = `发送失败 / Failed：${error.message}`;
  } finally {
    button.disabled = false;
  }
});

$('force-relogin-test').addEventListener('click', async () => {
  const button = $('force-relogin-test');
  const hint = $('force-relogin-hint');
  const confirmed = window.confirm(
    '该测试会注销当前微信 Session，推送一次二维码并等待重新登录。\n\nThis test logs out WeChat, sends one QR and waits for login.\n\n确认开始 / Start test?',
  );
  if (!confirmed) return;

  button.disabled = true;
  if (hint) hint.textContent = '正在注销并生成二维码 / Logging out and generating QR...';
  try {
    const response = await fetch('/api/wechat/force-relogin', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-FEAGLE-Dashboard': '1',
      },
      body: JSON.stringify({ confirm: 'FORCE_LOGOUT' }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '测试启动失败 / Test failed');
    render(payload);
  } catch (error) {
    hint.textContent = `启动失败 / Failed：${error.message}`;
    button.disabled = false;
  }
});

// 设置页事件
$('switch-transport').addEventListener('click', async () => {
  const button = $('switch-transport');
  const hint = $('transport-hint');
  const selected = document.querySelector('input[name="transport"]:checked')?.value;
  if (!selected || selected === activeTransport) {
    hint.textContent = '当前已经是这个通道 / This transport is already active.';
    return;
  }
  if (!window.confirm(
    `确认从 ${activeTransport} 切换到 ${selected}？\n\n数据不会清空，但不同通道的联系人 ID 不会按昵称自动合并。\n\nSwitch transport and restart?`,
  )) return;
  button.disabled = true;
  hint.textContent = '正在保存并切换 / Switching...';
  try {
    const response = await fetch('/api/transport', {
      method: 'POST',
      headers: mutationHeaders(),
      body: JSON.stringify({ transport: selected, confirm: 'SWITCH_TRANSPORT' }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '切换失败');
    hint.textContent = 'Bridge 正在重启；请数秒后返回状态页 / Restarting.';
  } catch (error) {
    hint.textContent = `切换失败 / Failed: ${error.message}`;
    button.disabled = false;
  }
});

bindSave('transport', 'save-status-transport');
bindSave('limits', 'save-status-limits');


/* ── GlassSurface（react-bits 原生版）：底部导航 SVG displacement 玻璃 ── */
function initGlassSurface() {
  const el = document.querySelector('.bottom-nav.glass-surface');
  if (!el || typeof ResizeObserver === 'undefined') return;

  // Chrome 支持 backdrop-filter:url(#filter) 引用 SVG filter；Webkit/Firefox 不支持 → 毛玻璃 fallback
  const supportsSvgBackdrop = (() => {
    if ((/Safari/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent)) || /Firefox/.test(navigator.userAgent)) return false;
    const probe = document.createElement('div');
    probe.style.backdropFilter = 'url(#glass-filter-nav)';
    return probe.style.backdropFilter !== '';
  })();
  el.classList.toggle('glass-surface--svg', supportsSvgBackdrop);
  el.classList.toggle('glass-surface--fallback', !supportsSvgBackdrop);

  const feImage = document.getElementById('glass-map-nav');
  if (!feImage) return;

  const updateDisplacementMap = () => {
    const rect = el.getBoundingClientRect();
    const w = Math.max(rect.width, 1);
    const h = Math.max(rect.height, 1);
    const edge = Math.min(w, h) * 0.035; // borderWidth 0.07 × 0.5
    const svgContent = [
      '<svg viewBox="0 0 ' + w + ' ' + h + '" xmlns="http://www.w3.org/2000/svg">',
      '<defs>',
      '<linearGradient id="red-grad-nav" x1="100%" y1="0%" x2="0%" y2="0%"><stop offset="0%" stop-color="#0000"/><stop offset="100%" stop-color="red"/></linearGradient>',
      '<linearGradient id="blue-grad-nav" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#0000"/><stop offset="100%" stop-color="blue"/></linearGradient>',
      '</defs>',
      '<rect x="0" y="0" width="' + w + '" height="' + h + '" fill="black"></rect>',
      '<rect x="0" y="0" width="' + w + '" height="' + h + '" rx="999" fill="url(#red-grad-nav)"/>',
      '<rect x="0" y="0" width="' + w + '" height="' + h + '" rx="999" fill="url(#blue-grad-nav)" style="mix-blend-mode: difference"/>',
      '<rect x="' + edge + '" y="' + edge + '" width="' + (w - edge * 2) + '" height="' + (h - edge * 2) + '" rx="999" fill="hsl(0 0% 50% / 0.93)" style="filter:blur(11px)"/>',
      '</svg>'
    ].join('');
    feImage.setAttribute('href', 'data:image/svg+xml,' + encodeURIComponent(svgContent));
  };

  updateDisplacementMap();
  const ro = new ResizeObserver(() => setTimeout(updateDisplacementMap, 0));
  ro.observe(el);
}
initGlassSurface();
