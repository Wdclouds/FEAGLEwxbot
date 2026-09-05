/**
 * conv-skills.js — per-channel 技能文件夹管理（/root/.hermes/conv-skills/<channel>/<skill>/SKILL.md）。
 * 全部路径强制收敛在 CONV_SKILLS_ROOT 内；channel/skill 名称均严格白名单校验，防路径穿越。
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, normalize } from 'node:path';

const ROOT = process.env.CONV_SKILLS_ROOT || '/root/.hermes/conv-skills';
const SKILL_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** 归一化频道 id → 文件夹名：g:1000000003 / g-1000000003 → g-1000000003 */
export function channelFolder(chatId) {
  const match = /^([gu])[:|-]?(\d+)$/i.exec(String(chatId || '').trim());
  if (!match) throw new TypeError('无效的频道 id（需 g:xxx / u:xxx / g-xxx / u-xxx）');
  return `${match[1].toLowerCase()}-${match[2]}`;
}

function skillDir(chatId, skillName) {
  const folder = channelFolder(chatId);
  if (!SKILL_NAME_RE.test(String(skillName || ''))) {
    throw new TypeError('无效的技能名（仅允许字母数字、下划线、连字符，最长 64）');
  }
  const resolved = normalize(join(ROOT, folder, skillName));
  const rootPrefix = normalize(ROOT) + '/';
  if (!resolved.startsWith(rootPrefix)) {
    throw new TypeError('路径越界，已拒绝');
  }
  return resolved;
}

/** 列出某频道已配置的技能（存在 SKILL.md 的目录） */
export function listChannelSkills(chatId) {
  const folder = join(ROOT, channelFolder(chatId));
  try {
    return readdirSync(folder, { withFileTypes: true })
      .filter((entry) => (
        entry.isDirectory()
        && SKILL_NAME_RE.test(entry.name)
        && existsSync(join(folder, entry.name, 'SKILL.md'))
      ))
      .map((entry) => {
        const file = join(folder, entry.name, 'SKILL.md');
        const stat = statSync(file);
        return {
          name: entry.name,
          size: stat.size,
          mtime: stat.mtime.toISOString(),
          path: file,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/** 读取某技能的 SKILL.md 内容 */
export function readSkill(chatId, skillName) {
  const file = join(skillDir(chatId, skillName), 'SKILL.md');
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

/** 写入（新建或覆盖）某技能的 SKILL.md */
export function writeSkill(chatId, skillName, content) {
  const dir = skillDir(chatId, skillName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), String(content ?? ''), 'utf8');
  const stat = statSync(join(dir, 'SKILL.md'));
  return {
    name: skillName,
    size: stat.size,
    mtime: stat.mtime.toISOString(),
    path: join(dir, 'SKILL.md'),
  };
}

/** 删除某技能文件夹 */
export function deleteSkill(chatId, skillName) {
  const dir = skillDir(chatId, skillName);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/** hermes 全局技能目录（只读参考，供 UI 展示"可参考的技能"） */
export function listGlobalSkills() {
  const hermesSkills = process.env.HERMES_SKILLS_ROOT || '/root/.hermes/skills';
  const result = {};
  try {
    for (const category of readdirSync(hermesSkills, { withFileTypes: true })) {
      if (!category.isDirectory()) continue;
      const categoryDir = join(hermesSkills, category.name);
      try {
        const names = readdirSync(categoryDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && existsSync(join(categoryDir, entry.name, 'SKILL.md')))
          .map((entry) => entry.name);
        if (names.length) result[category.name] = names;
      } catch {
        // 单个分类不可读则跳过
      }
    }
  } catch {
    // hermes 技能目录不可读时返回空
  }
  return result;
}
