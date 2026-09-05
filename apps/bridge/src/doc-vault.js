/**
 * doc-vault.js — 会话文档体系：把聊天记录提炼成结构化 MD 文档库。
 *
 * 每天 04:00 由 index.js 调用：
 *   1. 从 message_receipts 拉取该会话前一天的记录（群+私聊）
 *   2. 调 DeepSeek 把记录提炼成结构化 Markdown（知识/决策/人物）
 *   3. 写入 /root/.hermes/conv-docs/<会话>/（memory.md + personas/）
 *   4. 提炼成功后删除已消化的 receipts（先消化再删，不无限堆积）
 *
 * 文档库布局：
 *   conv-docs/
 *     g-<群oid>-<群名>/README.md + memory.md + personas/<wxid>.md
 *     u-<私聊oid>/memory.md + persona.md
 *     toolbox/README.md（GitHub 小工具收纳架，预留）
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const DOC_ROOT = process.env.CONV_DOC_ROOT || '/root/.hermes/conv-docs';
const LLM_BASE = process.env.LLM_API_BASE || 'https://api.deepseek.com/v1';
const LLM_MODEL = process.env.LLM_MODEL || 'deepseek-v4-flash';
const LLM_TIMEOUT_MS = 120_000;

function llmKey() {
  return process.env.LLM_API_KEY
    || process.env.DEEPSEEK_API_KEY
    || '';
}

function safeName(name) {
  return String(name || '会话')
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .slice(0, 40);
}

/** 会话 key → 文档目录名：group:1000000003 → g-1000000003 */
function convDirName(convKey) {
  const m = /^(group|private):(\d+)$/.exec(String(convKey || '').trim());
  if (!m) return null;
  return `${m[1] === 'group' ? 'g' : 'u'}-${m[2]}`;
}

/** 从聊天记录里提取"说话的人"集合（群成员画像用） */
function collectSenders(logs) {
  const senders = new Map();
  for (const log of logs) {
    const s = String(log.sender || '').trim();
    if (!s || s === 'Group member' || s === 'bot') continue;
    if (!senders.has(s)) senders.set(s, []);
    senders.get(s).push(log);
  }
  return senders;
}

/** 调 DeepSeek 把一批聊天记录提炼成结构化 Markdown */
async function summarizeConversation(conversationName, logs, instruction) {
  const key = llmKey();
  if (!key) throw new Error('LLM key 未配置 (LLM_API_KEY / DEEPSEEK_API_KEY)');
  if (!logs.length) return '（无聊天记录）\n';

  const transcript = logs
    .map((log) => {
      const who = log.direction === 'OUT' ? '机器人' : (log.sender || '成员');
      const time = String(log.createdAt || '').slice(0, 16).replace('T', ' ');
      return `[${time}] ${who}: ${String(log.text || '').slice(0, 400)}`;
    })
    .join('\n');

  const system = '你是一个会话档案整理器。把用户提供的微信聊天记录整理成结构化的中文 Markdown 文档。'
    + '要求：'
    + '1. 提炼真实内容，不编造；'
    + '2. 按主题组织（## 主题），每个主题下列出关键信息点；'
    + '3. 单独输出 ## 知识沉淀（事实/方法/结论）和 ## 待办/承诺（如果有人答应做某事）；'
    + '4. 语言简洁，保留人名/项目名/技术名词原文；'
    + '5. 输出纯 Markdown，不要包裹在代码块里。'
    + '\n\n' + instruction;

  const body = JSON.stringify({
    model: LLM_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `会话：${conversationName}\n\n聊天记录：\n${transcript}` },
    ],
    temperature: 0.3,
    max_tokens: 1500,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const res = await fetch(LLM_BASE + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + key,
      },
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      throw new Error(`LLM ${res.status}: ${detail}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || '';
    return content.trim() + '\n';
  } finally {
    clearTimeout(timer);
  }
}

/** 把某个会话前一天的记录消化成文档（memory.md + personas/），成功后返回删除用的 rowid 集合 */
export async function digestConversation(convKey, logs, { convName = '' } = {}) {
  const dirName = convDirName(convKey);
  // 图片是无用信息：过滤掉图片缓存记录与 [图片] 占位，只提炼文本对话
  const textLogs = (logs || []).filter((log) => {
    const status = String(log.status || '');
    const text = String(log.text || '').trim();
    if (status === 'CACHED') return false;
    if (text === '[图片]' || text === '[CQ:image]' || text === '') return false;
    return true;
  });
  if (!dirName || !textLogs.length) return { digested: 0, skipped: true };

  const dir = join(DOC_ROOT, dirName);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, 'personas'), { recursive: true });

  const name = convName || dirName;
  const header = `# ${name}\n\n> 自动整理于 ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · 来源：微信聊天记录\n\n`;

  // 1. memory.md（累积：旧的保留 + 新增段落）
  const memoryPath = join(dir, 'memory.md');
  const prevMemory = existsSync(memoryPath) ? readFileSync(memoryPath, 'utf8') : '';
    const todayCN = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const newSection = await summarizeConversation(
    name,
    textLogs,
    `把这段聊天记录提炼成新的 Markdown 段落，以 "## ${todayCN} 记录" 开头。`,
  );
  const memoryDoc = header + '---\n' + prevMemory + '\n---\n' + newSection;
  writeFileSync(memoryPath, memoryDoc, 'utf8');

  // 2. personas/（群里每个说过话的人一份画像；私聊单人 persona.md）
  const senders = collectSenders(textLogs);
  let personaFiles = 0;
  for (const [sender, senderLogs] of senders) {
    const safe = safeName(sender);
    const personaPath = join(dir, 'personas', `${safe}.md`);
    const prev = existsSync(personaPath) ? readFileSync(personaPath, 'utf8') : '';
    const newProfile = await summarizeConversation(
      sender,
      senderLogs,
      '这是某个微信用户的发言记录。请你提炼一份真正的用户画像档案（不要罗列聊天记录本身）：\n1. ## 基本画像：性格特征、说话风格（简洁/幽默/认真/情绪化等）、关心的话题领域；\n2. ## 与机器人的互动模式：ta 怎么使用你（提问方式、依赖度、信任度）；\n3. ## 值得记住的偏好：用词习惯、时间规律、对回复的期待；\n4. 如果信息不足以画像，明确写"样本不足，仅记录发言主题"并只列主题词。\n以 "## 更新" 开头追加本次新观察，不要重复旧内容。',
    );
    const doc = `# 用户画像：${sender}\n\n> 自动整理\n\n---\n${prev}\n---\n${newProfile}`;
    writeFileSync(personaPath, doc, 'utf8');
    personaFiles += 1;
  }

  return { digested: logs.length, memoryFile: memoryPath, personaFiles };
}

/** 列出文档库整体结构（dashboard 展示用） */
export function listDocVault() {
  const result = [];
  if (!existsSync(DOC_ROOT)) return result;
  for (const entry of readdirSync(DOC_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(DOC_ROOT, entry.name);
    const files = readdirSync(dir).filter((f) => f.endsWith('.md') || f.endsWith('.json'));
    const personas = existsSync(join(dir, 'personas'))
      ? readdirSync(join(dir, 'personas')).filter((f) => f.endsWith('.md'))
      : [];
    result.push({
      dir: entry.name,
      files,
      personas,
    });
  }
  return result;
}

/** 读取某个会话的文档内容 */
export function readConvDocs(convKey) {
  const dirName = convDirName(convKey);
  if (!dirName) return null;
  const dir = join(DOC_ROOT, dirName);
  if (!existsSync(dir)) return null;
  const memory = existsSync(join(dir, 'memory.md'))
    ? readFileSync(join(dir, 'memory.md'), 'utf8')
    : '';
  const personas = {};
  const pDir = join(dir, 'personas');
  if (existsSync(pDir)) {
    for (const f of readdirSync(pDir)) {
      if (!f.endsWith('.md')) continue;
      personas[f.replace(/\.md$/, '')] = readFileSync(join(pDir, f), 'utf8');
    }
  }
  return { dirName, memory, personas };
}

/** 按目录名直接读（g-<oid>/u-<oid>），由 bridge 层转换后使用。 */
export function readDocDir(dirName, type = 'memory') {
  if (!dirName) return null;
  const dir = join(DOC_ROOT, String(dirName));
  if (!existsSync(dir)) return null;
  if (type === 'persona') {
    const personas = {};
    const pDir = join(dir, 'personas');
    if (existsSync(pDir)) {
      for (const f of readdirSync(pDir)) {
        if (!f.endsWith('.md')) continue;
        personas[f.replace(/\.md$/, '')] = readFileSync(join(pDir, f), 'utf8');
      }
    }
    return { memory: '', personas };
  }
  const memoryPath = join(dir, 'memory.md');
  return {
    memory: existsSync(memoryPath) ? readFileSync(memoryPath, 'utf8') : '',
    personas: {},
  };
}

/** 给 dashboard 的 API 用：按 key 读 memory / persona 文档 */
/** 给 dashboard 的 API 用：按 key 读 memory / persona 文档 */
export function readDocFile(convKey, type) {
  const docs = readConvDocs(convKey);
  if (!docs) return null;
  if (type === 'persona') return docs.personas;
  return docs.memory;
}
