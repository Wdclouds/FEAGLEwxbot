const $ = (id) => document.getElementById(id);
const labels = {
  received: 'RECEIVED',
  forwarded: 'FORWARDED',
  replied: 'REPLIED',
  dropped: 'SLEEP DROP',
  blocked: 'GUARD BLOCK',
  failed: 'FAILED',
};

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
  return `${days}d ${String(hours).padStart(2, '0')}h ${String(minutes).padStart(2, '0')}m`;
}

function setService(key, status, detail) {
  $(`${key}-status`).textContent = status;
  const detailNode = $(`${key}-detail`);
  if (detailNode) detailNode.textContent = detail || '';
  const service = document.querySelector(`.service[data-key="${key}"]`);
  const active = ['ONLINE', 'CONNECTED', 'READY', 'RUNNING', 'ACTIVE'].includes(status);
  const testing = status === 'TEST';
  const bad = ['ERROR', 'EXITED', 'LOGGED_OUT'].includes(status);
  const color = active ? 'var(--green)' : bad ? 'var(--red)' : testing ? 'var(--blue)' : 'var(--amber)';
  service.querySelector('i').style.background = color;
  service.querySelector('span').style.color = color;
}

function render(state) {
  $('account').textContent = state.wechat.account || '--';
  $('session-status').textContent = state.wechat.status;
  $('protocol-health').textContent = state.wechat.protocolHealth || 'UNKNOWN';
  $('protocol-health').dataset.status = state.wechat.protocolHealth || 'UNKNOWN';
  $('last-sync').textContent = state.wechat.lastSyncAt
    ? `LAST ${time(state.wechat.lastSyncAt)} · ${Math.max(0, Math.round((state.wechat.syncAgeMs || 0) / 1000))}s`
    : 'LAST --';
  $('recovery-attempts').textContent = state.wechat.recoveryAttempts || 0;
  $('sync-errors').textContent = `ERRORS ${state.wechat.syncErrors || 0} · STREAK ${state.wechat.consecutiveSyncErrors || 0}`;
  $('wechat-status').textContent = state.wechat.status;
  $('wechat-detail').textContent = state.wechat.detail;
  $('qr-time').textContent = state.wechat.qrCreatedAt
    ? `QR ISSUED ${time(state.wechat.qrCreatedAt)}`
    : state.wechat.detail;

  const hasQr = Boolean(state.wechat.qrDataUrl);
  $('qr').src = hasQr ? state.wechat.qrDataUrl : '';
  $('qr').style.display = hasQr ? 'block' : 'none';
  $('qr-placeholder').style.display = hasQr ? 'none' : 'grid';

  setService('astrbot', state.astrbot.status, state.astrbot.detail);
  setService(
    'onebot',
    state.onebot.status,
    `${state.onebot.detail} · IN FLIGHT ${state.onebot.inFlight || 0}`,
  );
  const notifications = state.notifications || {
    status: 'DISABLED',
    detail: '飞书通知尚未配置',
  };
  setService('notifications', notifications.status, [
    notifications.detail,
    notifications.lastSentAt ? `LAST ${time(notifications.lastSentAt)}` : '',
  ].filter(Boolean).join(' · '));
  setService('schedule', state.schedule.mode);
  $('timezone').textContent = state.schedule.timezone;
  $('quiet-hours').textContent = state.schedule.quietHours;
  const testMode = Boolean(state.schedule.testMode);
  const testButton = $('test-mode-toggle');
  testButton.dataset.enabled = String(testMode);
  testButton.setAttribute('aria-pressed', String(testMode));
  testButton.textContent = testMode ? '关闭测试模式' : '开启测试模式';
  $('test-mode-hint').textContent = testMode
    ? '测试模式已开启：当前不受休眠时段限制。'
    : '开启后临时忽略休眠时段，再次点击即可恢复。';
  const reloginStatus = state.wechat.reloginTestStatus || 'IDLE';
  const reloginButton = $('force-relogin-test');
  const reloginHint = $('force-relogin-hint');
  const reloginRunning = reloginStatus === 'RUNNING';
  reloginButton.disabled = reloginRunning;
  reloginButton.textContent = reloginRunning ? '等待重新登录...' : '强制下线测试';
  if (reloginRunning) {
    reloginHint.textContent = state.wechat.reloginTestDetail || '二维码将发送到飞书私聊。';
  } else if (reloginStatus === 'SUCCESS') {
    reloginHint.textContent = `上次测试成功：${state.wechat.reloginTestDetail}`;
  } else if (reloginStatus === 'FAILED') {
    reloginHint.textContent = `上次测试失败：${state.wechat.reloginTestDetail}`;
  }

  $('metrics').replaceChildren(...Object.entries(state.counters).map(([key, value]) => {
    const article = document.createElement('article');
    article.className = 'metric';
    const small = document.createElement('small');
    small.textContent = labels[key] || key.toUpperCase();
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
    cell.textContent = 'NO MESSAGE TRAFFIC';
    row.append(cell);
    $('messages').replaceChildren(row);
  } else {
    $('messages').replaceChildren(...state.messages.map((message) => {
      const row = document.createElement('tr');
      [time(message.time), message.direction, message.peer, message.text, message.status]
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
    source.textContent = 'SYS';
    p.append(t, source, ' no errors recorded');
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
  $('uptime').textContent = `UPTIME ${duration(state.startedAt)}`;
}

setInterval(() => {
  $('clock').textContent = time(new Date());
}, 1000);

fetch('/api/status').then((response) => response.json()).then(render);
const events = new EventSource('/events');
events.onmessage = (event) => render(JSON.parse(event.data));

$('test-mode-toggle').addEventListener('click', async () => {
  const button = $('test-mode-toggle');
  const enabled = button.dataset.enabled === 'true';
  button.disabled = true;
  try {
    const response = await fetch('/api/test-mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !enabled }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '切换失败');
    render(payload);
  } catch (error) {
    $('test-mode-hint').textContent = `切换失败：${error.message}`;
  } finally {
    button.disabled = false;
  }
});

$('notification-test').addEventListener('click', async () => {
  const button = $('notification-test');
  const hint = $('notification-test-hint');
  button.disabled = true;
  hint.textContent = '正在发送飞书私聊测试通知...';
  try {
    const response = await fetch('/api/notifications/test', { method: 'POST' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '发送失败');
    render(payload);
    hint.textContent = '测试通知已发送，请检查飞书私聊。';
  } catch (error) {
    hint.textContent = `发送失败：${error.message}`;
  } finally {
    button.disabled = false;
  }
});

$('force-relogin-test').addEventListener('click', async () => {
  const button = $('force-relogin-test');
  const hint = $('force-relogin-hint');
  const confirmed = window.confirm(
    '该操作会立即注销当前微信 Session，必须重新扫码登录。确认开始测试吗？',
  );
  if (!confirmed) return;

  button.disabled = true;
  hint.textContent = '正在注销微信并申请新的登录二维码...';
  try {
    const response = await fetch('/api/wechat/force-relogin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'FORCE_LOGOUT' }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '强制下线测试启动失败');
    render(payload);
  } catch (error) {
    hint.textContent = `启动失败：${error.message}`;
    button.disabled = false;
  }
});
