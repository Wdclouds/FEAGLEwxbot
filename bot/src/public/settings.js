const $ = (id) => document.getElementById(id);
let activeTransport = 'wechat4u';

function setTheme(theme) {
  const normalized = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = normalized;
  localStorage.setItem('feagle-theme', normalized);
  $('theme-icon').textContent = normalized === 'light' ? '☀' : '☾';
  $('theme-label').textContent = normalized === 'light' ? '白天 / Light' : '夜间 / Dark';
}

function mutationHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-FEAGLE-Dashboard': '1',
  };
}

function renderSettings(settings) {
  activeTransport = settings.transport;
  $('active-transport').textContent = activeTransport === 'android' ? 'Android Hook' : 'Wechat4u Web';
  document.querySelector(`input[name="transport"][value="${activeTransport}"]`).checked = true;
  for (const input of document.querySelectorAll('[data-setting]')) {
    const scale = Number(input.dataset.scale || 1);
    input.value = Number.isFinite(Number(settings[input.dataset.setting]))
      && input.type === 'number'
      ? Number(settings[input.dataset.setting]) / scale
      : settings[input.dataset.setting] ?? '';
  }
}

function collectSettings() {
  const values = {};
  for (const input of document.querySelectorAll('[data-setting]')) {
    const key = input.dataset.setting;
    if (input.type === 'number') {
      const scale = Number(input.dataset.scale || 1);
      values[key] = Math.round(Number(input.value) * scale);
    } else {
      values[key] = input.value.trim();
    }
  }
  return values;
}

async function loadSettings() {
  const response = await fetch('/api/settings');
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || '读取设置失败');
  renderSettings(payload.settings);
}

setTheme(document.documentElement.dataset.theme);
$('theme-toggle').addEventListener('click', () => {
  setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

$('save-settings').addEventListener('click', async () => {
  const button = $('save-settings');
  const status = $('save-status');
  if (!$('settings-form').reportValidity()) return;
  button.disabled = true;
  status.textContent = '正在校验并保存 / Validating and saving...';
  try {
    const response = await fetch('/api/settings', {
      method: 'PUT',
      headers: mutationHeaders(),
      body: JSON.stringify(collectSettings()),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '保存失败');
    status.textContent = '设置已保存，Bridge 正在重启；数秒后刷新页面 / Restarting, refresh shortly.';
  } catch (error) {
    status.textContent = `保存失败 / Failed: ${error.message}`;
    button.disabled = false;
  }
});

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

loadSettings().catch((error) => {
  $('save-status').textContent = `读取失败 / Load failed: ${error.message}`;
});
