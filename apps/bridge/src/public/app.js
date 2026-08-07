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

function renderSelfAvatar(state) {
  const el = $('bot-avatar');
  const sa = state.selfAvatar || {};
  el.classList.remove('visible');
  el.title = '';
  el.innerHTML = '';
  if (!sa.avatarBase64) return;
  el.classList.add('visible');
  el.title = sa.nickname || sa.wxid || 'FEAGLE';
  const img = document.createElement('img');
  img.src = `data:image/jpeg;base64,${sa.avatarBase64}`;
  img.alt = sa.nickname || 'bot';
  el.appendChild(img);
}

function renderAdminMode(state) {
  const mode = state.wechat.adminMode || 'RUNNING';
  const badge = $('admin-mode-badge');
  const pauseButton = $('pause-toggle');
  badge.dataset.mode = mode;
  badge.textContent = bilingualStatus(mode);

  if (mode === 'MANUAL_OFFLINE') {
    $('admin-mode-hint').textContent = '微信与自动恢复已停止 / WeChat & auto-heal stopped';
    pauseButton.disabled = true;
    pauseButton.textContent = '解除时限';
  } else if (mode === 'PAUSED') {
    $('admin-mode-hint').textContent = '时限中：只接收不回复 / Time limit: receive only';
    pauseButton.disabled = false;
    pauseButton.textContent = '解除时限';
  } else {
    $('admin-mode-hint').textContent = '正常接收并回复消息 / Processing messages';
    pauseButton.disabled = false;
    pauseButton.textContent = '恢复时限';
  }

  pauseButton.dataset.mode = mode;
}

function renderGroupChat(state) {
  const groupChat = state.groupChat || {
    mode: 'OFF',
    allowlist: [],
    discovered: [],
  };
  $('group-observed').textContent = groupChat.observed || 0;
  $('group-forwarded').textContent = groupChat.forwarded || 0;
  $('group-replied').textContent = groupChat.replied || 0;
  $('group-blocked').textContent = groupChat.blocked || 0;
  $('group-policy-blocked').textContent = groupChat.policyBlocked || 0;
  $('group-rate-limited').textContent = groupChat.rateLimited || 0;
  $('group-fused').textContent = groupChat.fused || 0;

  const discovered = groupChat.discovered || [];
  if (!discovered.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-inline';
    empty.textContent = '尚未发现群聊 / No groups discovered';
    $('group-list').replaceChildren(empty);
    return;
  }
  const fuseByGroup = new Map((groupChat.fuses || []).map((fuse) => [String(fuse.groupId), fuse]));
  $('group-list').replaceChildren(...discovered.map((group) => {
    const gid = String(group.groupId);
    const fuse = fuseByGroup.get(gid);
    const mode = group.mode || 'MENTION_ONLY';
    const sleeping = ((state.schedule || {}).mode) === 'SLEEPING';
    const paused = (state.wechat.adminMode || 'RUNNING') === 'PAUSED';
    // 时限 = 休眠时段 + 手动暂停（PAUSED）：两者 bot 实际都只收不回复
    // 实时状态优先级：熔断(灰) > 时限(绿灯降级为黄) > 手动配置色
    const timeLimited = sleeping || paused;
    const button = document.createElement('button');
    button.className = fuse ? 'group-chip fused' : 'group-chip';
    button.type = 'button';
    button.dataset.groupId = gid;
    // 时限内仅绿灯（艾特回复）降级为黄灯，红/黄灯是手动设置不受影响
    if (timeLimited && !fuse && mode === 'MENTION_ONLY') {
      button.title = '时限中：仅接收不回复，恢复需先解除时限 / Time limit: receive only';
    }

    // 群头像占位框（方形色块 + 群名首字，后续换真实头像；双击展开/收起 ID + members）
    const avatar = document.createElement('span');
    avatar.className = 'avatar-placeholder';
    avatar.textContent = (group.name || '?').slice(0, 1);

    // 文本列：群名 + meta（meta 默认隐藏，双击头像展开）
    const body = document.createElement('span');
    body.className = 'chip-body';
    const name = document.createElement('strong');
    name.textContent = group.name;
    const meta = document.createElement('small');
    meta.className = 'chip-meta';
    meta.textContent = `ID ${gid} · ${group.memberCount || 0} members`;
    body.append(name, meta);

    // 红绿灯 = 实时状态：熔断(灰) > 时限(仅绿灯降级为黄) > 配置模式
    // 时限内 bot 实际只收不回复（SLEEP-DROP / PAUSED），艾特回复的群显示黄灯；
    // 手动设置的红/黄灯不受时限影响，保持原色
    const displayMode = !fuse && timeLimited && mode === 'MENTION_ONLY' ? 'OBSERVE' : mode;
    const lights = document.createElement('span');
    lights.className = 'traffic-lights';
    lights.dataset.mode = displayMode;
    for (const [m, cls, title] of [
      ['OFF', 'red', '不接收 / IGNORE'],
      ['OBSERVE', 'amber', '仅接收不回复 / RECEIVE ONLY'],
      ['MENTION_ONLY', 'green', '艾特回复 / REPLY ON @'],
    ]) {
      const dot = document.createElement('i');
      dot.className = `dot dot-${cls}`;
      dot.title = title;
      lights.append(dot);
    }

    button.append(avatar, body, lights);

    // 熔断：红色动态进度底（宽度 = 剩余/总时长，1s interval 刷新）
    if (fuse) {
      button.dataset.fuseUntil = fuse.untilAt;
      button.dataset.fuseStart = fuse.trippedAt;
      const progress = document.createElement('span');
      progress.className = 'fuse-progress';
      // 创建时即写入初始宽度，避免渲染后先显示 CSS 100% 再跳回实际值（SSE 每 4s 重建的跳变 bug）
      const total = Date.parse(fuse.untilAt) - Date.parse(fuse.trippedAt);
      const remain = Math.max(0, Date.parse(fuse.untilAt) - Date.now());
      progress.style.width = `${total > 0 ? (remain / total) * 100 : 0}%`;
      button.append(progress);
    }

    // 点击条目（非头像区域）→ 弹窗切换接收模式（传显示态，所见即所得）
    button.addEventListener('click', () => openGroupStatusModal(gid, group.name, displayMode, timeLimited));
    // 头像：单击 = 弹窗（250ms 防抖，避免双击误触）；双击 = 展开/收起 ID + members
    let avatarClickTimer = null;
    avatar.addEventListener('click', (event) => {
      event.stopPropagation();
      clearTimeout(avatarClickTimer);
      avatarClickTimer = setTimeout(() => openGroupStatusModal(gid, group.name, displayMode, timeLimited), 250);
    });
    avatar.addEventListener('dblclick', (event) => {
      event.stopPropagation();
      clearTimeout(avatarClickTimer);
      body.classList.toggle('show-meta');
    });

    return button;
  }));
}

function render(state) {
  renderSelfAvatar(state);
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

// ── 终端日志流（/logs SSE）──
// 行格式：[HH:MM:SS] [LEVEL] message；跟随滚动，用户上翻时不强制拽回
const termLog = $('term-log');
const MAX_TERM_LINES = 2000;
const TERM_RE = /^\[(\d{2}:\d{2}:\d{2})\] \[([A-Z]+)\]\s?(.*)$/s;
let termStarted = false;

function appendTermLine(raw) {
  if (!termStarted) {
    termLog.replaceChildren();
    termStarted = true;
  }
  const p = document.createElement('p');
  const t = document.createElement('time');
  const m = TERM_RE.exec(raw);
  if (m) {
    t.textContent = m[1];
    const lvl = document.createElement('span');
    lvl.textContent = m[2];
    lvl.className = `lvl lvl-${m[2].toLowerCase()}`;
    p.append(t, lvl, document.createTextNode(` ${m[3]}`));
  } else {
    t.textContent = time(new Date());
    p.append(t, document.createTextNode(` ${raw}`));
  }
  const stick = termLog.scrollHeight - termLog.scrollTop - termLog.clientHeight < 40;
  termLog.append(p);
  while (termLog.childElementCount > MAX_TERM_LINES) termLog.firstElementChild.remove();
  if (stick) termLog.scrollTop = termLog.scrollHeight;
}

const termStream = new EventSource('/logs');
termStream.onmessage = (event) => appendTermLine(event.data);

// ── 熔断倒计时：每秒刷新红色进度底的剩余宽度（剩余/总时长）──
setInterval(() => {
  document.querySelectorAll('.group-chip.fused').forEach((chip) => {
    const until = Date.parse(chip.dataset.fuseUntil);
    const start = Date.parse(chip.dataset.fuseStart);
    if (!until || !start) return;
    const total = until - start;
    const remain = Math.max(0, until - Date.now());
    const bar = chip.querySelector('.fuse-progress');
    if (bar) bar.style.width = `${total > 0 ? (remain / total) * 100 : 0}%`;
  });
}, 1000);

// ── 复制最近 15 条终端日志 ──
function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  return new Promise((resolve, reject) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    try {
      document.execCommand('copy');
      resolve();
    } catch (err) {
      reject(err);
    }
    ta.remove();
  });
}

$('copy-term-log').addEventListener('click', async () => {
  const btn = $('copy-term-log');
  const rows = [...termLog.querySelectorAll('p')].slice(-15);
  if (!rows.length) return;
  const text = rows.map((p) => {
    const t = p.querySelector('time')?.textContent || '';
    const lvl = p.querySelector('.lvl')?.textContent || '';
    const msg = [...p.childNodes]
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent)
      .join('')
      .trim();
    return `[${t}] [${lvl}] ${msg}`;
  }).join('\n');
  try {
    await copyText(text);
    btn.textContent = '已复制';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = '复制';
      btn.classList.remove('copied');
    }, 1600);
  } catch (err) {
    btn.textContent = '复制失败';
    setTimeout(() => { btn.textContent = '复制'; }, 1600);
  }
});

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

// ── 群聊接收模式切换弹窗（2026-08-07）──
const MODE_LABELS = { MENTION_ONLY: '艾特回复', OBSERVE: '仅接收不回复', OFF: '不接收' };
const statusModal = $('group-status-modal');
let pendingGroupId = null;
let pendingGroupMode = null;
let pendingTimeLimited = false;

function openGroupStatusModal(groupId, name, current, timeLimited) {
  pendingGroupId = groupId;
  pendingGroupMode = current;
  pendingTimeLimited = Boolean(timeLimited);
  const tip = $('group-status-modal-tip');
  if (tip) tip.hidden = true;
  $('group-status-modal-group').textContent =
    `${name}（当前：${MODE_LABELS[current] || current}）`;
  document.querySelectorAll('.modal-option').forEach((opt) => {
    opt.classList.toggle('selected', opt.dataset.mode === current);
  });
  statusModal.hidden = false;
}

function closeGroupStatusModal() {
  statusModal.hidden = true;
  pendingGroupId = null;
  pendingGroupMode = null;
  pendingTimeLimited = false;
}

$('group-status-modal-cancel').addEventListener('click', closeGroupStatusModal);
statusModal.addEventListener('click', (event) => {
  if (event.target === statusModal) closeGroupStatusModal();
});
document.querySelectorAll('.modal-option').forEach((opt) => {
  opt.addEventListener('click', () => {
    pendingGroupMode = opt.dataset.mode;
    document.querySelectorAll('.modal-option')
      .forEach((o) => o.classList.toggle('selected', o === opt));
  });
});
$('group-status-modal-confirm').addEventListener('click', async () => {
  const gid = pendingGroupId;
  const target = pendingGroupMode;
  if (!gid || !target) return closeGroupStatusModal();
  // 时限内禁止手动开启艾特回复：制止操作并引导去「解除时限」按钮
  if (pendingTimeLimited && target === 'MENTION_ONLY') {
    const tip = $('group-status-modal-tip');
    if (tip) tip.hidden = false;
    return;
  }
  const button = $('group-status-modal-confirm');
  button.disabled = true;
  try {
    const response = await fetch('/api/group-chat/status', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-FEAGLE-Dashboard': '1',
      },
      body: JSON.stringify({ groupId: gid, mode: target }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '切换失败 / Switch failed');
    render(payload);
    closeGroupStatusModal();
  } catch (error) {
    $('group-status-modal-group').textContent = `切换失败 / Failed：${error.message}`;
  } finally {
    button.disabled = false;
  }
});

// 时限内被制止时的引导按钮：跳到流量安全页找「解除时限」
$('group-status-modal-goto').addEventListener('click', () => {
  closeGroupStatusModal();
  window.location.hash = '#/settings-traffic';
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
