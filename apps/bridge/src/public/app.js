const $ = (id) => document.getElementById(id);

const statusLabels = {
  STARTING: '启动中 / STARTING',
  CONNECTING: '连接中 / CONNECTING',
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

// 纯中文状态（总览页 Cardless 去双语，2026-08-08）
const statusZh = (status) => ({
  STARTING: '启动中', CONNECTING: '连接中', RESTORING: '恢复中', WAITING_SCAN: '等待扫码',
  WAITING_AGENT: '等待连接', WAITING_HOOK: '等待 Hook', WAITING: '等待连接',
  LISTENING: '正在监听', STOPPED: '已停止', SCANNED: '已扫码',
  ONLINE: '在线', CONNECTED: '已连接', READY: '就绪',
  RUNNING: '运行中', ACTIVE: '运行中', TEST: '测试中', SLEEPING: '休眠中',
  PAUSED: '暂停回复', MANUAL_OFFLINE: '紧急离线', LOGGING_OUT: '正在下线',
  LOGGED_OUT: '已退出', DISCONNECTED: '未连接', DISABLED: '未启用',
  WAITING_BIND: '等待绑定', BOUND: '已绑定', UNBOUND: '未绑定',
  DEGRADED: '连接异常', RECOVERING: '自动修复', ERROR: '错误', EXITED: '已退出',
  UNKNOWN: '未知', HEALTHY: '健康', STALE: '同步超时', FAILED: '失败',
  OFFLINE: '离线', SENDING: '发送中', OFF: '已关闭', OBSERVE: '仅观察',
  MENTION_ONLY: '被 @ 时回复',
}[status] || String(status || '未知'));

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
  $(`${key}-status`).textContent = statusZh(status);
  const detailNode = $(`${key}-detail`);
  if (detailNode) detailNode.textContent = detail || '';
  const item = document.querySelector(`.svc-item[data-key="${key}"]`);
  if (!item) return;
  // Cardless：运行=品牌黄高亮 + 发光圆点；停用/等待=低饱和灰（2026-08-08）
  const active = ['ONLINE', 'CONNECTED', 'READY', 'RUNNING', 'ACTIVE'].includes(status);
  item.classList.toggle('live', active);
  item.classList.toggle('dead', !active);
}

function renderSelfAvatar(state) {
  const sa = state.selfAvatar || {};
  const heroAvatar = $('hero-avatar');
  if (!heroAvatar) return;
  heroAvatar.replaceChildren();
  if (!sa.avatarBase64) return;
  const heroImg = document.createElement('img');
  heroImg.src = `data:image/jpeg;base64,${sa.avatarBase64}`;
  heroImg.alt = sa.nickname || 'bot';
  heroAvatar.appendChild(heroImg);
}

function renderAdminMode(state) {
  const mode = state.wechat.adminMode || 'RUNNING';
  const schedule = state.schedule || {};
  const sleepOverride = schedule.sleepOverride === true;
  const sleeping = schedule.mode === 'SLEEPING';
  const badge = $('admin-mode-badge');
  const pauseButton = $('pause-toggle');
  badge.dataset.mode = mode;
  badge.textContent = statusZh(mode === 'RUNNING' ? 'RUNNING' : mode === 'PAUSED' ? 'PAUSED' : 'MANUAL_OFFLINE');

  if (mode === 'MANUAL_OFFLINE') {
    $('admin-mode-hint').textContent = '微信与自动恢复已停止';
    pauseButton.disabled = true;
    pauseButton.textContent = '解除时限';
  } else if (sleepOverride) {
    // 已解除时限（休眠豁免）：休眠时段内也正常回复
    $('admin-mode-hint').textContent = '已解除时限：休眠时段内正常回复';
    pauseButton.disabled = false;
    pauseButton.textContent = '恢复时限';
  } else if (sleeping) {
    // 休眠时限中：只接收不回复
    $('admin-mode-hint').textContent = '时限中：只接收不回复，可解除';
    pauseButton.disabled = false;
    pauseButton.textContent = '解除时限';
  } else {
    // 非休眠时段：没有时限，按钮不可用
    $('admin-mode-hint').textContent = '正常接收并回复消息';
    pauseButton.disabled = true;
    pauseButton.textContent = '解除时限';
  }

  pauseButton.dataset.mode = mode;
  pauseButton.dataset.sleepOverride = String(sleepOverride);
}

const groupModeLabels = {
  MENTION_ONLY: '艾特回复',
  OBSERVE: '仅接收',
  OFF: '不接收',
};
let selectedGroupId = '';
let selectedContext = null;
let activeConvTab = 'flow';
const convLoaded = { flow: false, memory: false, persona: false, tools: false, logs: false };

function showSelectedGroup(context) {
  const name = $('selected-group-name');
  const badge = $('conv-kind-badge');
  const tabs = $('conv-tabs');
  const modeActions = $('group-mode-actions');
  if (!context) {
    name.textContent = '请选择联系人';
    badge.hidden = true;
    tabs.hidden = true;
    if (modeActions) modeActions.hidden = true;
    return;
  }
  name.textContent = context.name || '未命名联系人';
  badge.textContent = context.kind === 'group' ? '群聊' : '私聊';
  badge.hidden = false;
  tabs.hidden = false;

  if (modeActions) {
    if (context.kind === 'group') {
      modeActions.hidden = false;
      const curMode = context.mode || context.displayMode || 'MENTION_ONLY';
      modeActions.querySelectorAll('.mode-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.mode === curMode);
      });
    } else {
      modeActions.hidden = true;
    }
  }
}

function selectGroup(context) {
  selectedGroupId = context.key;
  selectedContext = context;
  document.querySelectorAll('.group-chip').forEach((chip) => {
    chip.setAttribute('aria-pressed', String(chip.dataset.groupId === selectedGroupId));
  });
  showSelectedGroup(context);
  convLoaded.flow = convLoaded.memory = convLoaded.persona = convLoaded.tools = false;
  switchConvTab('flow');
  loadConvFlow();
}

function convKey() {
  return selectedContext ? `${selectedContext.kind}:${selectedContext.talker}` : '';
}

function emptyP(text) {
  const p = document.createElement('p');
  p.className = 'empty-inline';
  p.textContent = text;
  return p;
}

function sectionTitle(text) {
  const h = document.createElement('h4');
  h.className = 'conv-section-title';
  h.textContent = text;
  return h;
}

function statCard(label, value) {
  const span = document.createElement('span');
  const b = document.createElement('b');
  b.textContent = value;
  const small = document.createElement('small');
  small.textContent = label;
  span.append(b, small);
  return span;
}

function formatConvTime(date) {
  if (!date || Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

/* ── Tab 切换 ── */
function switchConvTab(tab) {
  activeConvTab = tab;
  document.querySelectorAll('.conv-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.querySelectorAll('.conv-pane').forEach((pane) => {
    pane.classList.toggle('active', pane.dataset.pane === tab);
  });
  if (tab === 'memory' && !convLoaded.memory) {
    convLoaded.memory = true;
    loadMemory();
  } else if (tab === 'persona' && !convLoaded.persona) {
    convLoaded.persona = true;
    loadPersona();
  } else if (tab === 'tools' && !convLoaded.tools) {
    convLoaded.tools = true;
    loadSkills();
  } else if (tab === 'logs' && !convLoaded.logs) {
    convLoaded.logs = true;
    loadConvLogs();
  }
}

document.querySelectorAll('.conv-tab').forEach((btn) => {
  btn.addEventListener('click', () => switchConvTab(btn.dataset.tab));
});

/* ── 对话流 Tab ── */
let flowBeforeId = null;
let flowLoading = false;

async function loadConvFlow(reset = true) {
  if (!selectedContext || flowLoading) return;
  flowLoading = true;
  const list = $('flow-list');
  if (reset) list.replaceChildren(emptyP('加载中…'));
  try {
    const params = new URLSearchParams({
      kind: selectedContext.kind,
      talker: selectedContext.talker,
      limit: '50',
    });
    if (!reset && flowBeforeId) params.set('beforeId', String(flowBeforeId));
    const response = await fetch(`/api/messages?${params}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '加载失败');
    const messages = payload.messages || [];
    if (messages.length) flowBeforeId = messages[0].id;
    const more = $('flow-load-more');
    more.hidden = messages.length < 50;
    if (reset) {
      list.replaceChildren();
      if (!messages.length) {
        list.append(emptyP('这个会话还没有消息记录'));
        more.hidden = true;
      }
    }
    for (const msg of messages) list.append(buildFlowBubble(msg));
    if (reset) list.scrollTop = list.scrollHeight;
  } catch (error) {
    if (reset) list.replaceChildren(emptyP(`对话流加载失败：${error.message}`));
  } finally {
    flowLoading = false;
    convLoaded.flow = true;
  }
}

function buildFlowBubble({ id, event }) {
  const out = event.direction === 'OUT';
  const bubble = document.createElement('article');
  bubble.className = `flow-bubble ${out ? 'out' : 'in'}`;
  const meta = document.createElement('div');
  meta.className = 'flow-meta';
  const sender = document.createElement('span');
  sender.className = 'flow-sender';
  sender.textContent = out ? '我' : (event.sender?.nickname || '成员');
  const timeEl = document.createElement('time');
  timeEl.textContent = formatConvTime(event.time ? new Date(event.time * 1000) : null);
  meta.append(sender, timeEl);
  if (event.fromReceipts && event.status) {
    const tag = document.createElement('span');
    tag.className = 'flow-status-tag';
    tag.textContent = CONV_LOG_STATUS[event.status] || event.status || '';
    meta.append(tag);
  }
  const body = document.createElement('div');
  body.className = 'flow-content';
  const segments = event.message || [];
  for (const seg of segments) {
    if (seg.type === 'text' && seg.data?.text) {
      body.append(document.createTextNode(seg.data.text));
    } else if (seg.type === 'image') {
      const file = seg.data?.file || '';
      if (file) {
        const img = document.createElement('img');
        img.className = 'flow-img';
        img.loading = 'lazy';
        img.alt = '图片';
        img.src = file.startsWith('base64://')
          ? `data:image/jpeg;base64,${file.slice('base64://'.length)}`
          : file;
        body.append(img);
      } else {
        const ph = document.createElement('span');
        ph.className = 'flow-img-placeholder';
        ph.textContent = '[图片]';
        body.append(ph);
      }
    } else if (seg.type === 'at') {
      const at = document.createElement('span');
      at.className = 'flow-at';
      at.textContent = '@' + (seg.data?.qq === String(event.self_id) ? '我' : (seg.data?.qq || ''));
      body.append(at);
    } else {
      const raw = seg.data?.text || JSON.stringify(seg).slice(0, 60);
      if (/^\[CQ:image[,]/.test(raw)) {
        const ph = document.createElement('span');
        ph.className = 'flow-img-placeholder';
        ph.textContent = '[图片]';
        body.append(ph);
      } else {
        body.append(document.createTextNode(raw));
      }
    }
  }
  if (!body.childNodes.length) body.append(document.createTextNode(event.raw_message || '(空消息)'));
  bubble.append(meta, body);
  return bubble;
}

/* ── 记忆 Tab ── */
let memoryScope = 'chat';
let memoryOwner = '';

function memoryScopeParams() {
  const params = new URLSearchParams({ limit: '15' });
  if (memoryScope === 'chat' && selectedContext) params.set('key', convKey());
  if (memoryOwner) params.set('owner', memoryOwner);
  return params;
}

async function loadMemoryOwnerOptions() {
  const select = $('memory-owner');
  if (!select) return;
  const prev = select.value;
  select.replaceChildren();
  select.append(new Option('全部成员', ''));
  const isGroup = selectedContext && selectedContext.kind === 'group';
  if (!isGroup) { select.disabled = true; return; }
  try {
    const response = await fetch('/api/conversation/members?kind=group&talker=' + encodeURIComponent(selectedContext.talker));
    const payload = await response.json();
    if (payload.ok && payload.members) {
      for (const member of payload.members) select.append(new Option(member.name || member.id, member.id));
    }
    select.disabled = false;
  } catch { select.disabled = true; }
  if ([...select.options].some((o) => o.value === prev)) select.value = prev;
  else select.value = '';
  memoryOwner = select.value;
}

// ── 简易 Markdown 渲染（文档库展示用，不引入外部库）──
function renderMarkdown(md) {
  const box = document.createElement('div');
  box.className = 'md-view';
  const text = String(md || '');
  if (!text.trim()) { box.append(emptyP('（文档为空）')); return box; }
  const lines = text.split('\n');
  let list = null; // 当前 <ul>
  const closeList = () => { if (list) { box.append(list); list = null; } };
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) { closeList(); continue; }
    const esc = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const inline = esc
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
    if (/^###\s+/.test(line)) { closeList(); const h = document.createElement('h5'); h.innerHTML = inline.replace(/^###\s+/, ''); box.append(h); }
    else if (/^##\s+/.test(line)) { closeList(); const h = document.createElement('h4'); h.innerHTML = inline.replace(/^##\s+/, ''); box.append(h); }
    else if (/^#\s+/.test(line)) { closeList(); const h = document.createElement('h3'); h.innerHTML = inline.replace(/^#\s+/, ''); box.append(h); }
    else if (/^[-*]\s+/.test(line)) {
      if (!list) { list = document.createElement('ul'); }
      const li = document.createElement('li');
      li.innerHTML = inline.replace(/^[-*]\s+/, '');
      list.append(li);
    } else {
      closeList();
      const p = document.createElement('p');
      p.innerHTML = inline;
      box.append(p);
    }
  }
  closeList();
  return box;
}

/* ── 记忆 Tab（文档库优先：每天 4 点整理的 memory.md）── */
async function loadMemory() {
  const statsEl = $('memory-stats');
  const list = $('memory-list');
  list.replaceChildren(emptyP('加载中…'));
  statsEl.replaceChildren();
  if (!selectedContext) { list.replaceChildren(emptyP('选择左侧联系人查看记忆文档')); return; }
  try {
    const key = convKey();
    const response = await fetch(`/api/docs?key=${encodeURIComponent(key)}&type=memory`);
    const payload = await response.json();
    if (response.ok && payload.ok && payload.docs?.memory) {
      // 有整理好的文档：显示它
      statsEl.replaceChildren(statCard('文档库', 'memory.md'));
      list.replaceChildren(renderMarkdown(payload.docs.memory));
      return;
    }
    // 还没有文档：提示（等每日 4:00 自动整理），并提供搜索兜底
    list.replaceChildren(emptyP('这个会话还没有整理好的记忆文档（每天凌晨 4 点自动整理聊天记录生成）。可以先用搜索查看原始记忆：'));
    try {
      const recent = await fetch(`/api/memory/recent?${memoryScopeParams()}`).then((r) => r.json());
      if (recent.ok && recent.data?.memories?.length) {
        list.replaceChildren(...recent.data.memories.slice(0, 5).map(buildMemoryCard));
      }
    } catch { /* 搜索兜底失败静默 */ }
  } catch (error) {
    list.replaceChildren(emptyP(`记忆加载失败：${error.message}`));
  }
}

async function runMemorySearch() {
  const q = $('memory-q').value.trim();
  const list = $('memory-list');
  if (!q) { loadMemory(); return; }
  list.replaceChildren(emptyP('搜索中…'));
  try {
    const params = new URLSearchParams({ q, limit: '15' });
    if (memoryScope === 'chat' && selectedContext) params.set('key', convKey());
    if (memoryOwner) params.set('owner', memoryOwner);
    const response = await fetch(`/api/memory/search?${params}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '搜索失败');
    const arr = payload.data?.results || payload.data?.memories || [];
    if (!arr.length) list.replaceChildren(emptyP('没有找到相关记忆'));
    else list.replaceChildren(...arr.map(buildMemoryCard));
  } catch (error) {
    list.replaceChildren(emptyP(`搜索失败：${error.message}`));
  }
}

function buildMemoryCard(mem) {
  const card = document.createElement('article');
  card.className = 'memory-card';
  const head = document.createElement('div');
  head.className = 'memory-card-head';
  const tier = document.createElement('span');
  tier.className = 'memory-tier';
  tier.textContent = mem.tier || 'L?';
  const meta = document.createElement('span');
  meta.className = 'memory-meta';
  meta.textContent = [
    mem.owner ? `成员 ${mem.owner}` : '',
    mem.category || '',
    mem.heat_score != null ? `热度 ${mem.heat_score}` : '',
    mem.created_at ? String(mem.created_at).slice(0, 10) : '',
  ].filter(Boolean).join(' · ');
  head.append(tier, meta);
  const content = document.createElement('p');
  content.className = 'memory-content';
  content.textContent = String(mem.content || '(空记忆)').slice(0, 300);
  card.append(head, content);
  return card;
}

/* ── 画像 Tab（文档库优先：personas/ 每人一份画像）── */
async function loadPersona() {
  const list = $('persona-list');
  list.replaceChildren(emptyP('加载中…'));
  if (!selectedContext) { list.replaceChildren(emptyP('选择左侧联系人查看画像')); return; }
  try {
    const key = convKey();
    const response = await fetch(`/api/docs?key=${encodeURIComponent(key)}&type=persona`);
    const payload = await response.json();
    if (response.ok && payload.ok && payload.docs?.personas) {
      const personas = payload.docs.personas;
      const names = Object.keys(personas);
      if (!names.length) {
        list.replaceChildren(emptyP('这个会话还没有成员画像（每天凌晨 4 点整理，或对话样本不足时只记录主题）。'));
        return;
      }
      const frag = [];
      frag.push(sectionTitle(`成员画像 ${names.length}`));
      for (const name of names) {
        const card = document.createElement('article');
        card.className = 'memory-card persona-doc';
        const head = document.createElement('div');
        head.className = 'memory-card-head';
        const tag = document.createElement('span');
        tag.className = 'memory-tier belief-tag';
        tag.textContent = '画像';
        const who = document.createElement('span');
        who.className = 'memory-meta';
        who.textContent = name;
        head.append(tag, who);
        card.append(head);
        card.append(renderMarkdown(personas[name]));
        frag.push(card);
      }
      list.replaceChildren(...frag);
      return;
    }
    // 无文档：旧逻辑兜底（信念 + 相关记忆）
    const q = selectedContext?.name || selectedContext?.talker || '';
    const pr = await fetch(`/api/persona?q=${encodeURIComponent(q)}&limit=10`);
    const pp = await pr.json();
    const { beliefs = [], memories = [], errors = [] } = pp.data || {};
    const frag = [];
    if (!beliefs.length && !memories.length) {
      frag.push(emptyP('暂无画像数据（每日 4 点整理后会生成成员画像文档）。'));
    } else {
      if (beliefs.length) { frag.push(sectionTitle(`信念 ${beliefs.length}`)); frag.push(...beliefs.map(buildBeliefCard)); }
      if (memories.length) { frag.push(sectionTitle(`相关记忆 ${memories.length}`)); frag.push(...memories.map(buildMemoryCard)); }
    }
    if (errors.length) frag.push(emptyP(`部分数据源暂不可用：${errors[0]}`));
    list.replaceChildren(...frag);
  } catch (error) {
    list.replaceChildren(emptyP(`画像加载失败：${error.message}`));
  }
}

function buildBeliefCard(belief) {
  const card = document.createElement('article');
  card.className = 'memory-card belief';
  const head = document.createElement('div');
  head.className = 'memory-card-head';
  const tag = document.createElement('span');
  tag.className = 'memory-tier belief-tag';
  tag.textContent = '信念';
  const meta = document.createElement('span');
  meta.className = 'memory-meta';
  meta.textContent = belief.category || belief.confidence != null ? `置信 ${belief.confidence}` : '';
  head.append(tag, meta);
  const content = document.createElement('p');
  content.className = 'memory-content';
  content.textContent = String(
    belief.content || belief.text || belief.statement || JSON.stringify(belief).slice(0, 240),
  ).slice(0, 300);
  card.append(head, content);
  return card;
}

/* ── 工具栏 Tab（技能文件夹管理器） ── */

async function loadSkills() {
  const box = $('tools-config');
  box.replaceChildren(emptyP('加载中…'));
  try {
    const response = await fetch(`/api/skills?key=${encodeURIComponent(convKey())}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '技能列表加载失败');
    renderSkillManager(box, payload.skills || []);
  } catch (error) {
    box.replaceChildren(emptyP(`加载失败：${error.message}`));
  }
}

function renderSkillManager(box, skills) {
  const list = document.createElement('div');
  list.className = 'skill-list';
  if (!skills.length) {
    list.append(emptyP('这个会话还没有技能文件夹，新建一个吧'));
  } else {
    for (const skill of skills) {
      const row = document.createElement('div');
      row.className = 'skill-row';
      const info = document.createElement('div');
      info.className = 'skill-info';
      const nameEl = document.createElement('strong');
      nameEl.textContent = skill.name;
      const meta = document.createElement('small');
      meta.textContent = `SKILL.md · ${skill.size} B · ${(skill.mtime || '').slice(0, 16).replace('T', ' ')}`;
      info.append(nameEl, meta);
      const actions = document.createElement('div');
      actions.className = 'skill-actions';
      const viewBtn = document.createElement('button');
      viewBtn.type = 'button';
      viewBtn.className = 'skill-btn';
      viewBtn.textContent = '预览';
      viewBtn.addEventListener('click', () => openSkillPreview(skill.name));
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'skill-btn';
      editBtn.textContent = '编辑';
      editBtn.addEventListener('click', () => openSkillEditor(skill.name));
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'skill-btn danger';
      delBtn.textContent = '删除';
      delBtn.addEventListener('click', () => deleteSkill(skill.name));
      actions.append(viewBtn, editBtn, delBtn);
      row.append(info, actions);
      list.append(row);
    }
  }
  const createForm = document.createElement('div');
  createForm.className = 'skill-create';
  const input = document.createElement('input');
  input.className = 'memory-input';
  input.placeholder = '新技能名（字母/数字/_-，如 daily-summary）';
  input.autocomplete = 'off';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tools-save';
  btn.textContent = '新建技能';
  btn.addEventListener('click', async () => {
    const name = input.value.trim();
    if (!name) return;
    await saveSkill(name, templateSkill(name));
  });
  createForm.append(input, btn);
  box.replaceChildren(list, createForm);
  renderToolSwitches(box, list, createForm);
}

// 工具启用开关：/api/tools/catalog（目录）+ /api/tools/config（per-chat 配置）
async function renderToolSwitches(box, list, createForm) {
  const toolSection = document.createElement('div');
  toolSection.className = 'tool-switch-section';
  const toolTitle = document.createElement('h4');
  toolTitle.className = 'conv-section-title';
  toolTitle.textContent = '启用工具';
  toolSection.append(toolTitle);
  const toolHint = document.createElement('p');
  toolHint.className = 'tool-switch-hint';
  toolHint.textContent = '为该会话启用/停用 Hermes 工具（保存后立即生效）';
  toolSection.append(toolHint);
  const toolGrid = document.createElement('div');
  toolGrid.className = 'tool-switch-grid';
  toolGrid.append(emptyP('加载工具目录…'));
  toolSection.append(toolGrid);
  const toolSave = document.createElement('button');
  toolSave.type = 'button';
  toolSave.className = 'tools-save';
  toolSave.textContent = '保存工具配置';
  toolSave.disabled = true;
  toolSection.append(toolSave);
  box.replaceChildren(list, createForm, toolSection);
  try {
    const [catRes, cfgRes] = await Promise.all([
      fetch('/api/tools/catalog').then((r) => r.json()),
      fetch(`/api/tools/config?key=${encodeURIComponent(convKey())}`).then((r) => r.json()),
    ]);
    const catalog = (catRes.catalog && (catRes.catalog.tools || [])) || [];
    const enabled = new Set((cfgRes.config && (cfgRes.config.tools || [])) || []);
    if (!catalog.length) {
      toolGrid.replaceChildren(emptyP('工具目录为空（catalog 未返回工具）'));
      return;
    }
    const rows = catalog.map((tool) => {
      const label = document.createElement('label');
      label.className = 'tool-switch-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = tool;
      cb.checked = enabled.has(tool);
      const span = document.createElement('span');
      span.textContent = tool;
      label.append(cb, span);
      cb.addEventListener('change', () => { toolSave.disabled = false; });
      return label;
    });
    toolGrid.replaceChildren(...rows);
    toolSave.addEventListener('click', async () => {
      const chosen = [...toolGrid.querySelectorAll('input[type=checkbox]:checked')].map((c) => c.value);
      toolSave.disabled = true;
      toolSave.textContent = '保存中…';
      try {
        const res = await fetch('/api/tools/config', {
          method: 'PUT',
          headers: mutationHeaders(),
          body: JSON.stringify({ key: convKey(), tools: chosen }),
        });
        const payload = await res.json();
        if (!res.ok) throw new Error(payload.error || '保存失败');
        toolSave.textContent = '已保存 ✓';
        setTimeout(() => { toolSave.textContent = '保存工具配置'; }, 2000);
      } catch (err) {
        toolSave.textContent = `保存失败：${err.message}`;
        toolSave.disabled = false;
      }
    });
  } catch (err) {
    toolGrid.replaceChildren(emptyP(`工具配置加载失败：${err.message}`));
  }
}

function templateSkill(name) {
  return `---
name: ${name}
description: "（填写这个技能的作用）"
version: 1.0.0
metadata:
  hermes:
    tags: []
---

# ${name}

## 这个技能做什么
（描述）

## 使用时机
（什么时候该用）

## 操作指引
（步骤）
`;
}

async function openSkillEditor(name) {
  const box = $('tools-config');
  box.replaceChildren(emptyP('加载中…'));
  try {
    const response = await fetch(`/api/skills/content?key=${encodeURIComponent(convKey())}&name=${encodeURIComponent(name)}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '读取失败');
    renderSkillEditor(box, name, payload.content || '');
  } catch (error) {
    box.replaceChildren(emptyP(`读取失败：${error.message}`));
  }
}

async function openSkillPreview(name) {
  const box = $('tools-config');
  box.replaceChildren(emptyP('加载中…'));
  try {
    const response = await fetch(`/api/skills/content?key=${encodeURIComponent(convKey())}&name=${encodeURIComponent(name)}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '读取失败');
    renderSkillPreview(box, name, payload.content || '');
  } catch (error) {
    box.replaceChildren(emptyP(`读取失败：${error.message}`));
  }
}

function renderSkillPreview(box, name, content) {
  const title = document.createElement('h4');
  title.className = 'conv-section-title';
  title.textContent = `预览技能：${name}`;
  const pre = document.createElement('pre');
  pre.className = 'skill-preview';
  pre.textContent = content;
  const actions = document.createElement('div');
  actions.className = 'skill-editor-actions';
  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'tools-save';
  editBtn.textContent = '编辑';
  editBtn.addEventListener('click', () => openSkillEditor(name));
  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'skill-btn';
  backBtn.textContent = '返回列表';
  backBtn.addEventListener('click', () => loadSkills());
  actions.append(editBtn, backBtn);
  box.replaceChildren(title, pre, actions);
}

function renderSkillEditor(box, name, content) {
  const title = document.createElement('h4');
  title.className = 'conv-section-title';
  title.textContent = `编辑技能：${name}`;
  const textarea = document.createElement('textarea');
  textarea.className = 'tools-workflow';
  textarea.rows = 16;
  textarea.value = content;
  const actions = document.createElement('div');
  actions.className = 'skill-editor-actions';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'tools-save';
  saveBtn.textContent = '保存';
  saveBtn.addEventListener('click', () => saveSkill(name, textarea.value));
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'skill-btn';
  cancelBtn.textContent = '返回';
  cancelBtn.addEventListener('click', () => loadSkills());
  actions.append(saveBtn, cancelBtn);
  box.replaceChildren(title, textarea, actions);
}

async function saveSkill(name, content) {
  try {
    const response = await fetch('/api/skills', {
      method: 'PUT',
      headers: mutationHeaders(),
      body: JSON.stringify({ key: convKey(), name, content }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '保存失败');
    loadSkills();
  } catch (error) {
    const box = $('tools-config');
    box.replaceChildren(emptyP(`保存失败：${error.message}`));
  }
}

async function deleteSkill(name) {
  if (!window.confirm(`删除技能 ${name}？（会删除整个文件夹）`)) return;
  try {
    const response = await fetch(
      `/api/skills?key=${encodeURIComponent(convKey())}&name=${encodeURIComponent(name)}`,
      { method: 'DELETE', headers: mutationHeaders() },
    );
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '删除失败');
    loadSkills();
  } catch (error) {
    const box = $('tools-config');
    box.replaceChildren(emptyP(`删除失败：${error.message}`));
  }
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

  const contacts = state.contacts || {};
  const discovered = groupChat.discovered || [];

  // 建立多级匹配索引：protocolId(talker) -> groupId(OneBot) -> name
  const discoveredByProtocolId = new Map();
  const discoveredByGroupId = new Map();
  const discoveredByName = new Map();
  for (const group of discovered) {
    if (group.protocolId) discoveredByProtocolId.set(String(group.protocolId), group);
    if (group.groupId) discoveredByGroupId.set(String(group.groupId), group);
    if (group.name) {
      discoveredByName.set(group.name, group);
      const cleanName = group.name.replace(/\s*-[^-]+$/, '').trim();
      if (cleanName && cleanName !== group.name) discoveredByName.set(cleanName, group);
    }
  }

  const contactRows = [
    ...(contacts.groups || []).map((contact) => ({ ...contact, kind: 'group' })),
    ...(contacts.privates || []).map((contact) => ({ ...contact, kind: 'private' })),
  ];

  // 仅严格展示当前 contacts 中的真实群聊与私聊联系人

  if (!contactRows.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-inline';
    empty.textContent = contacts.status === 'READY'
      ? '当前没有可用的群聊或私聊'
      : '点击顶部 Logo 同步群聊与私聊';
    $('group-list').replaceChildren(empty);
    selectedGroupId = '';
    showSelectedGroup(null);
    return;
  }
  const contactKey = (contact) => `${contact.kind}:${contact.talker}`;
  if (!contactRows.some((contact) => contactKey(contact) === selectedGroupId)) {
    selectedGroupId = contactKey(contactRows[0]);
  }
  const fuseByGroup = new Map((groupChat.fuses || []).map((fuse) => [String(fuse.groupId), fuse]));
  const contexts = new Map();
  $('group-list').replaceChildren(...contactRows.map((contact) => {
    const key = contactKey(contact);
    let matchedGroup = null;
    if (contact.kind === 'group') {
      matchedGroup = discoveredByProtocolId.get(contact.talker)
        || (contact.talker ? discoveredByGroupId.get(contact.talker.replace(/^group:/, '')) : null)
        || discoveredByName.get(contact.name)
        || discoveredByName.get((contact.name || '').replace(/\s*-[^-]+$/, '').trim())
        || null;
    }
    const gid = matchedGroup ? String(matchedGroup.groupId) : (contact.kind === 'group' && contact.talker?.endsWith('@chatroom') ? contact.talker : '');
    const fuse = gid ? fuseByGroup.get(gid) : null;
    const mode = matchedGroup?.mode || (groupChat.groupModes && gid ? groupChat.groupModes[gid] : null) || groupChat.mode || 'MENTION_ONLY';
    const sleeping = ((state.schedule || {}).mode) === 'SLEEPING';
    // 时限 = 休眠时段（豁免「解除时限」后后端 sleeping()=false → mode=ACTIVE → 不降级）
    // 实时状态优先级：熔断(灰) > 时限(绿灯降级为黄) > 手动配置色
    const timeLimited = sleeping;
    const button = document.createElement('button');
    button.className = fuse ? 'group-chip fused' : 'group-chip';
    button.type = 'button';
    button.dataset.groupId = key;
    button.setAttribute('role', 'listitem');
    button.setAttribute('aria-pressed', String(key === selectedGroupId));
    // 时限内仅绿灯（艾特回复）降级为黄灯，红/黄灯是手动设置不受影响
    if (timeLimited && !fuse && mode === 'MENTION_ONLY') {
      button.title = '时限中：仅接收不回复，恢复需先解除时限 / Time limit: receive only';
    }

    // 圆形群头像占位：头像边框颜色直接表达接收模式。
    const avatar = document.createElement('span');
    avatar.className = 'avatar-placeholder';
    if (contact.avatarBase64) {
      const image = document.createElement('img');
      image.alt = '';
      image.src = `data:image/jpeg;base64,${contact.avatarBase64}`;
      avatar.append(image);
    } else {
      avatar.textContent = (contact.name || '?').slice(0, 1);
    }

    // 红绿灯 = 实时状态：熔断(灰) > 时限(仅绿灯降级为黄) > 配置模式
    // 时限内 bot 实际只收不回复（SLEEP-DROP / PAUSED），艾特回复的群显示黄灯；
    // 手动设置的红/黄灯不受时限影响，保持原色
    const displayMode = !fuse && timeLimited && mode === 'MENTION_ONLY' ? 'OBSERVE' : mode;
    avatar.dataset.mode = contact.kind === 'private' ? 'PRIVATE' : (fuse ? 'FUSED' : displayMode);
    const context = {
      key,
      gid,
      mode,
      name: contact.name,
      kind: contact.kind,
      talker: contact.talker,
      displayMode,
      timeLimited,
      fused: Boolean(fuse),
    };
    contexts.set(key, context);
    const contactType = contact.kind === 'private' ? '私聊' : '群聊';
    const contactStatus = contact.kind === 'private'
      ? contactType
      : (fuse ? '熔断中' : groupModeLabels[displayMode] || displayMode);
    button.title = `${contact.name} · ${contactStatus}`;
    button.setAttribute('aria-label', button.title);
    button.append(avatar);

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

    button.addEventListener('click', () => selectGroup(context));

    return button;
  }));
  showSelectedGroup(contexts.get(selectedGroupId));
}

function render(state) {
  renderSelfAvatar(state);
  renderAdminMode(state);
  renderGroupChat(state);
  const transport = state.transport || { active: 'android', detail: '' };
  const android = state.android || {};
  const androidActive = transport.active === 'android';
  // 安卓链路服务项（Cardless：收进左列服务列表）
  const hbAge = android.heartbeatAgeMs;
  const hbTimeout = android.heartbeatTimeoutMs || 75_000;
  const hbText = android.lastHeartbeatAt
    ? `心跳 ${time(android.lastHeartbeatAt)} · ${Math.round((hbAge || 0) / 1000)}s`
    : '心跳 --';
  setService('android', android.hookConnected ? 'CONNECTED' : (androidActive ? 'WAITING' : 'OFFLINE'),
    `${android.deviceIdMasked || '--'} · Hook ${android.hookConnected ? '已连接' : '未连接'} · ${hbText}`);
  $('account').textContent = state.wechat.account || '--';
  $('wechat-detail').textContent = state.wechat.detail;
  // 中央核心：在线 = 品牌黄呼吸光圈 + 黄状态点（Cardless 2026-08-08）
  const online = state.wechat.status === 'ONLINE';
  const heroOrb = $('hero-orb');
  if (heroOrb) heroOrb.classList.toggle('online', online);
  const heroDot = $('hero-dot');
  if (heroDot) heroDot.classList.toggle('online', online);

  // 中央核心主体：已配对头像优先，否则脉冲占位（Android Hook 无扫码）
  const sa = state.selfAvatar || {};
  const heroAvatar = $('hero-avatar');
  const showAvatar = Boolean(heroAvatar && sa.avatarBase64);
  if (heroAvatar) heroAvatar.style.display = showAvatar ? 'block' : 'none';
  $('qr-placeholder').style.display = !showAvatar ? 'grid' : 'none';

  const hermes = state.hermes || state.astrbot || {
    status: 'CONNECTING',
    detail: '等待 Hermes Gateway',
  };
  setService('hermes', hermes.status, hermes.detail);
  setService(
    'onebot',
    state.onebot.status,
    `${state.onebot.detail} · 处理中 ${state.onebot.inFlight || 0}`,
  );
  setService('schedule', state.schedule.mode);
  $('timezone').textContent = state.schedule.timezone;
  $('quiet-hours').textContent = state.schedule.quietHours;

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

// 解除时限 = 休眠豁免：休眠时段内也正常回复；休眠结束自动重置（后端 updateSchedule）
async function setSleepOverride(enabled) {
  const response = await fetch('/api/schedule/override', {
    method: 'POST',
    headers: mutationHeaders(),
    body: JSON.stringify({ enabled: Boolean(enabled) }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || '切换失败 / Override change failed');
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
  const logo = $('brand-logo');
  const canSyncContacts = view === 'groups';
  logo.classList.toggle('sync-enabled', canSyncContacts);
  logo.tabIndex = canSyncContacts ? 0 : -1;
  logo.setAttribute('aria-disabled', String(!canSyncContacts));
  logo.setAttribute('aria-label', canSyncContacts ? '同步群聊和私聊联系人' : 'FEAGLE Logo');
  logo.title = canSyncContacts ? '点击同步群聊和私聊' : '';
  // 懒加载流量安全设置
  if (view === 'settings-traffic') {
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
function mutationHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-FEAGLE-Dashboard': '1',
  };
}

function renderSettings(settings) {
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
    const statusEl = $('save-status-limits');
    if (statusEl) statusEl.textContent = `读取失败 / Load failed: ${error.message}`;
  }
}

// 保存流量安全设置
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
    // 超时兜底：保存成功后容器会重启（~500ms shutdown），响应 body 可能在重启窗口丢失，
    // fetch 无超时会永久挂起（2026-08-08 实测：按钮一直 loading）。12s 后视为已提交。
    const controller = new AbortController();
    const saveTimer = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: mutationHeaders(),
        body: JSON.stringify(collectSettings(form)),
        signal: controller.signal,
      });
      clearTimeout(saveTimer);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '保存失败');
      if (status) status.textContent = '设置已保存，Bridge 正在重启；数秒后刷新页面 / Restarting, refresh shortly.';
      button.disabled = false;
    } catch (error) {
      clearTimeout(saveTimer);
      if (status) {
        status.textContent = error.name === 'AbortError'
          ? '已提交，Bridge 正在重启；请稍后刷新页面 / Submitted, restarting; refresh shortly.'
          : `保存失败 / Failed: ${error.message}`;
      }
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

let contactsSyncInFlight = false;

async function requestContactsSync() {
  if (currentView() !== 'groups' || contactsSyncInFlight) return;
  if (!window.confirm('是否同步群聊和私聊联系人？')) return;
  contactsSyncInFlight = true;
  try {
    const syncRequest = fetch('/api/contacts/refresh', {
      method: 'POST',
      headers: { 'X-FEAGLE-Dashboard': '1' },
    });
    window.alert('正在同步中');
    const response = await syncRequest;
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    if (payload.state) render(payload.state);
    const result = payload.result || {};
    window.alert(
      `同步成功：群聊 ${result.groups || 0}，私聊 ${result.privates || 0}`
      + `\n新增 ${result.inserted || 0}，更新 ${result.updated || 0}，删除 ${result.deleted || 0}`,
    );
  } catch (error) {
    window.alert(`同步失败：${error.message || error}`);
  } finally {
    contactsSyncInFlight = false;
  }
}

$('brand-logo').addEventListener('click', requestContactsSync);
$('brand-logo').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  requestContactsSync();
});

/* ── 日志 Tab（per-conversation 输入/输出日志） ── */
const CONV_LOG_STATUS = {
  RECEIVED: '收到',
  FORWARDED: '已转发',
  DROPPED: '已丢弃',
  BLOCKED: '已拦截',
  CACHED: '已缓存',
  SENT: '已发送',
  'GROUP-SENT': '群回复',
  'GROUP-OFF': '群关闭',
  'GROUP-OBSERVED': '仅观察',
  'GROUP-NOT-MENTIONED': '未艾特',
  'GROUP-NOT-ALLOWED': '未授权',
  'SLEEP-DROP': '休眠丢弃',
  'ADMIN-PAUSED': '暂停丢弃',
  'UPSTREAM-BUSY': '上游繁忙',
  'FORWARD-FAILED': '转发失败',
};
let convLogBeforeId = null;
let convLogLoading = false;

async function loadConvLogs(reset = true) {
  if (!selectedContext || convLogLoading) return;
  convLogLoading = true;
  const list = $('conv-log-list');
  if (reset) list.replaceChildren(emptyP('加载中…'));
  try {
    const params = new URLSearchParams({ key: convKey(), limit: '100' });
    if (!reset && convLogBeforeId) params.set('beforeId', String(convLogBeforeId));
    const response = await fetch(`/api/logs?${params}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '日志加载失败');
    const logs = payload.logs || [];
    if (logs.length) convLogBeforeId = logs[0].id ?? logs[0].rowid ?? null;
    const more = $('conv-log-more');
    more.hidden = logs.length < 100;
    if (reset) {
      list.replaceChildren();
      if (!logs.length) {
        list.append(emptyP('这个会话还没有日志（发条消息试试）'));
        more.hidden = true;
      }
    }
    for (const log of logs) list.append(buildConvLogRow(log));
  } catch (error) {
    if (reset) list.replaceChildren(emptyP(`日志加载失败：${error.message}`));
  } finally {
    convLogLoading = false;
    convLoaded.logs = true;
  }
}

function buildConvLogRow(log) {
  const row = document.createElement('div');
  row.className = `conv-log-row ${log.direction === 'OUT' ? 'out' : 'in'}`;
  const timeEl = document.createElement('time');
  timeEl.className = 'conv-log-time';
  timeEl.textContent = formatConvTime(new Date(log.createdAt));
  const dirEl = document.createElement('span');
  dirEl.className = `conv-log-dir ${log.direction === 'OUT' ? 'out' : 'in'}`;
  dirEl.textContent = log.direction === 'OUT' ? '出' : '入';
  const statusEl = document.createElement('span');
  statusEl.className = `conv-log-status ${String(log.status || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  statusEl.textContent = CONV_LOG_STATUS[log.status] || log.status || '?';
  const senderEl = document.createElement('span');
  senderEl.className = 'conv-log-sender';
  senderEl.textContent = log.direction === 'OUT' ? 'Bot' : (log.sender || '成员');
  const textEl = document.createElement('span');
  textEl.className = 'conv-log-text';
  textEl.textContent = log.text || '';
  row.append(timeEl, dirEl, statusEl, senderEl, textEl);
  return row;
}

$('conv-log-more').addEventListener('click', () => loadConvLogs(false));

function renderMemoryScope() {
  document.querySelectorAll('.memory-scope-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.scope === memoryScope);
  });
}

document.querySelectorAll('.memory-scope-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    memoryScope = btn.dataset.scope;
    renderMemoryScope();
    const q = $('memory-q').value.trim();
    if (q) runMemorySearch();
    else loadMemory();
  });
});

$('memory-search-btn').addEventListener('click', runMemorySearch);
$('memory-q').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') runMemorySearch();
});
$('memory-refresh-btn').addEventListener('click', () => {
  convLoaded.memory = false;
  switchConvTab('memory');
});
$('memory-owner').addEventListener('change', (event) => {
  memoryOwner = event.target.value;
  const q = $('memory-q').value.trim();
  if (q) runMemorySearch();
  else loadMemory();
});
$('flow-load-more').addEventListener('click', () => loadConvFlow(false));

$('pause-toggle').addEventListener('click', async () => {
  const button = $('pause-toggle');
  const sleepOverride = button.dataset.sleepOverride === 'true';
  button.disabled = true;
  try {
    await setSleepOverride(!sleepOverride);
  } catch (error) {
    const offlineHint2 = $('manual-offline-hint');
    if (offlineHint2) offlineHint2.textContent = `切换失败 / Failed：${error.message}`;
  } finally {
    if (button.dataset.mode !== 'MANUAL_OFFLINE') button.disabled = false;
  }
});

bindSave('limits', 'save-status-limits');

// ── 群聊接收模式切换按钮交互 ──
document.querySelectorAll('.group-mode-actions .mode-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    if (!selectedContext || selectedContext.kind !== 'group') return;
    const targetMode = btn.dataset.mode;
    const targetGid = selectedContext.gid || selectedContext.talker;
    if (!targetGid || !targetMode) return;

    btn.disabled = true;
    try {
      const response = await fetch('/api/group-chat/status', {
        method: 'POST',
        headers: mutationHeaders(),
        body: JSON.stringify({ groupId: targetGid, mode: targetMode }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '切换失败');
      selectedContext.mode = targetMode;
      selectedContext.displayMode = targetMode;
      document.querySelectorAll('.group-mode-actions .mode-btn').forEach((b) => {
        b.classList.toggle('active', b.dataset.mode === targetMode);
      });
      render(payload);
    } catch (error) {
      window.alert(`切换模式失败：${error.message || error}`);
    } finally {
      btn.disabled = false;
    }
  });
});


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
