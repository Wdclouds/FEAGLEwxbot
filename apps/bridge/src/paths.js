import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 获取跨平台数据根目录：
 * 1. 优先使用 DATA_DIR 环境变量；
 * 2. 在 Windows 或非 Docker 容器环境（/app 不存在）下，自动回退到本地相对路径 ./data；
 * 3. 在 Linux 容器内，保持标准 /app/data。
 */
export function getDefaultDataDir() {
  if (process.env.DATA_DIR) {
    return resolve(process.env.DATA_DIR);
  }
  if (process.platform === 'win32' || !existsSync('/app')) {
    return resolve('./data');
  }
  return '/app/data';
}

/**
 * 将相对子路径解析为跨平台绝对路径
 * @param {string} relativeOrAppPath 相对路径（如 "wechat/mapping.sqlite"）或原 Linux 路径（如 "/app/data/wechat/mapping.sqlite"）
 */
export function resolveDataPath(relativeOrAppPath) {
  const cleanPath = String(relativeOrAppPath || '')
    .replace(/^\/app\/data\/?/, '')
    .replace(/^data\/?/, '');
  return resolve(getDefaultDataDir(), cleanPath);
}
