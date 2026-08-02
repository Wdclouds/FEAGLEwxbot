const $ = (id) => document.getElementById(id);

const metricLabels = {
  received: '已接收 / RECEIVED',
  forwarded: '已转发 / FORWARDED',
  replied: '已回复 / REPLIED',
  dropped: '已丢弃 / DROPPED',
  blocked: '已拦截 / BLOCKED',
  failed: '失败 / FAILED',
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
  RECEIVED: '已接收 / RECEIVED',
  SENT: '已发送 / SENT',
  'SLEEP-DROP': '休眠丢弃 / SLEEP DROP',
  'ADMIN-PAUSED': '暂停丢弃 / PAUSED',
  'UPSTREAM-BUSY': '上游繁忙 / BUSY',
  'FORWARD-FAILED': '转发失败 / FAILED',
  'DUPLICATE-REPLAY': '重放拦截 / REPLAY BLOCKED',
  'STALE-REPLAY': '过期拦截 / STALE BLOCKED',
  'GROUP-OFF': '群聊关闭 / GROUP OFF',
  'GROUP-OBSERVED': '群聊观察 / OBSERVED',
  'GROUP-NOT-ALLOWED': '群不在白名单 / NOT ALLOWED',
  'GROUP-NOT-MENTIONED': '未 @ 机器人 / NOT MENTIONED',
  'GROUP-EMPTY-MENTION': '空 @ / EMPTY MENTION',
  'GROUP-MENTION': '群聊 @ / GROUP MENTION',
  'GROUP-SENT': '群聊已发送 / GROUP SENT',
  'GROUP-POLICY-BLOCKED': '本地策略拦截 / POLICY BLOCKED',
  'GROUP-MEMBER-RATE-LIMITED': '成员限流 / MEMBER RATE',
  'GROUP-RATE-LIMITED': '群聊限流 / GROUP RATE',
  'GROUP-FUSED': '群聊熔断 / GROUP FUSED',
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
  badge.dataset.mode = mode;
  badge.textContent = bilingualStatus(mode);

  if (mode === 'MANUAL_OFFLINE') {
    $('admin-mode-hint').textContent = '微信与自动恢复已停止 / WeChat & auto-heal stopped';
    pauseButton.disabled = true;
    pauseButton.textContent = '暂停回复 / Pause';
    offlineButton.textContent = '恢复运行 / Resume';
    $('manual-offline-hint').innerHTML =
      '当前不会自动重连或推送二维码。<span>No reconnect or QR alerts while manually offline.</span>';
  } else if (mode === 'PAUSED') {
    $('admin-mode-hint').textContent = '微信保持在线但不回复 / Connected without replies';
    pauseButton.disabled = false;
    pauseButton.textContent = '恢复回复 / Resume';
    offlineButton.textContent = '紧急离线 / Offline';
    $('manual-offline-hint').innerHTML =
      '消息会被记录为暂停丢弃；连接与心跳仍保持。<span>Messages are dropped; session and heartbeat stay active.</span>';
  } else {
    $('admin-mode-hint').textContent = '正常接收并回复消息 / Processing messages';
    pauseButton.disabled = false;
    pauseButton.textContent = '暂停回复 / Pause';
    offlineButton.textContent = '紧急离线 / Offline';
    $('manual-offline-hint').innerHTML =
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
  $('transport-name').textContent = androidActive ? 'Android Hook' : 'Wechat4u Web';
  $('transport-detail').textContent = transport.detail || '';
  $('android-diagnostics').hidden = !androidActive;
  if (androidActive) {
    $('android-server').textContent = `${bilingualStatus(android.serverStatus)} · ${android.endpoint || '--'}`;
    $('android-device').textContent = `${bilingualStatus(android.deviceStatus)} · ${android.deviceIdMasked || '--'}`;
    $('android-hook').textContent = android.hookConnected
      ? '已连接 / CONNECTED'
      : '未连接 / DISCONNECTED';
    $('android-heartbeat').textContent = android.lastHeartbeatAt
      ? `${time(android.lastHeartbeatAt)} · ${Math.round((android.heartbeatAgeMs || 0) / 1000)}s`
      : '--';
    $('android-pending').textContent = android.pendingCommands || 0;
  }
  $('account').textContent = state.wechat.account || '--';
  $('session-status').textContent = bilingualStatus(state.wechat.status);
  $('protocol-health').textContent = bilingualStatus(state.wechat.protocolHealth || 'UNKNOWN');
  $('protocol-health').dataset.status = state.wechat.protocolHealth || 'UNKNOWN';
  $('last-sync').textContent = state.wechat.lastSyncAt
    ? `上次 / LAST ${time(state.wechat.lastSyncAt)} · ${Math.max(0, Math.round((state.wechat.syncAgeMs || 0) / 1000))}s`
    : '上次同步 / LAST --';
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
    ? '关闭测试模式 / Disable'
    : '测试模式 / Test mode';
  $('test-mode-hint').textContent = testMode
    ? '已忽略休眠时段 / Quiet hours bypassed'
    : '临时忽略休眠时段 / Bypass quiet hours';

  const reloginStatus = state.wechat.reloginTestStatus || 'IDLE';
  const reloginButton = $('force-relogin-test');
  const reloginHint = $('force-relogin-hint');
  const reloginRunning = reloginStatus === 'RUNNING';
  reloginButton.disabled = androidActive
    || reloginRunning
    || state.wechat.adminMode !== 'RUNNING';
  reloginButton.textContent = reloginRunning
    ? '等待重新登录 / Waiting...'
    : '强制重登测试 / Relogin test';
  if (androidActive) {
    reloginHint.textContent = 'Android Hook 不使用 Web 扫码重登测试 / Not used by Android transport';
  } else if (reloginRunning) {
    reloginHint.textContent =
      state.wechat.reloginTestDetail || '二维码将发送到飞书私聊 / QR will be sent once';
  } else if (reloginStatus === 'SUCCESS') {
    reloginHint.textContent = `上次成功 / Last success：${state.wechat.reloginTestDetail}`;
  } else if (reloginStatus === 'FAILED') {
    reloginHint.textContent = `上次失败 / Last failed：${state.wechat.reloginTestDetail}`;
  }

  $('metrics').replaceChildren(...Object.entries(state.counters).map(([key, value]) => {
    const article = document.createElement('article');
    article.className = 'metric';
    const small = document.createElement('small');
    small.textContent = metricLabels[key] || key.toUpperCase();
    const strong = document.createElement('strong');
    strong.textContent = value;
    article.append(small, strong);
    return article;
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
      const direction = message.direction === 'IN' ? '接收 / IN' : '发送 / OUT';
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
  $('theme-icon').textContent = normalized === 'light' ? '☀' : '☾';
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

setInterval(() => {
  $('clock').textContent = time(new Date());
}, 1000);

setTheme(document.documentElement.dataset.theme);
fetch('/api/status').then((response) => response.json()).then(render);
const events = new EventSource('/events');
events.onmessage = (event) => render(JSON.parse(event.data));

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
    $('manual-offline-hint').textContent = `切换失败 / Failed：${error.message}`;
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
    $('manual-offline-hint').textContent = `切换失败 / Failed：${error.message}`;
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
    $('test-mode-hint').textContent = `切换失败 / Failed：${error.message}`;
  } finally {
    button.disabled = false;
  }
});

$('notification-test').addEventListener('click', async () => {
  const button = $('notification-test');
  const hint = $('notification-test-hint');
  button.disabled = true;
  hint.textContent = '正在发送 / Sending...';
  try {
    const response = await fetch('/api/notifications/test', {
      method: 'POST',
      headers: { 'X-FEAGLE-Dashboard': '1' },
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '发送失败 / Send failed');
    render(payload);
    hint.textContent = '已发送，请检查飞书 / Sent, check Feishu';
  } catch (error) {
    hint.textContent = `发送失败 / Failed：${error.message}`;
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
  hint.textContent = '正在注销并生成二维码 / Logging out and generating QR...';
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
