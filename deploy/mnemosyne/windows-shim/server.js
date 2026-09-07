#!/usr/bin/env node
import { createMnemosyneShimServer } from './shim.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = Number(process.env.MNEMOSYNE_PORT || 18010);
const HOST = process.env.MNEMOSYNE_HOST || '127.0.0.1';
const DB_PATH = process.env.MNEMOSYNE_SQLITE_PATH || resolve(__dirname, '../../../data/memory.sqlite');

console.log('====================================================');
console.log(' FEAGLE WxBot - Windows 独立记忆伴随伪装服务 (Shim)');
console.log('====================================================');
console.log(`[配置] 监听地址: http://${HOST}:${PORT}`);
console.log(`[配置] 数据文件: ${DB_PATH}`);
console.log(`[技术] 原生 Node 22 node:sqlite (零 Docker / 零 PostgreSQL)`);
console.log('----------------------------------------------------');

const server = createMnemosyneShimServer({
  port: PORT,
  host: HOST,
  dbPath: DB_PATH,
});

server.listen().then(() => {
  console.log(`[状态] [OK] 记忆伪装服务已就绪并在端口 ${PORT} 持续监听中...`);
  console.log(`[提示] 现已 100% 模拟 Hermes 所需的 Mnemosyne REST API。`);
}).catch((err) => {
  console.error(`[错误] 记忆伪装服务启动失败:`, err);
  process.exit(1);
});

function shutdown(signal) {
  console.log(`\n[状态] 正在优雅关闭记忆伴随服务 (${signal})...`);
  server.close().then(() => {
    console.log('[状态] 记忆伴随服务已停止。');
    process.exit(0);
  }).catch(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
