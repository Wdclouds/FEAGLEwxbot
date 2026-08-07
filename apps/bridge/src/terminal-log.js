/**
 * 终端日志环形缓冲（dashboard /logs SSE 的数据源）
 * - supervisor 把 AstrBot 子进程 stdout/stderr 行推进来
 * - dashboard 用 tailLogs 发尾部 + subscribeLogs 推增量
 * 行格式：[HH:MM:SS] [LEVEL] message（与 mock-server 对齐，前端 TERM_RE 同款解析）
 */
'use strict';

const MAX_LINES = 2000;
const buffer = [];
const subscribers = new Set();

const nowClock = () => new Date().toTimeString().slice(0, 8);

export function pushLog(level, message) {
  const line = `[${nowClock()}] [${String(level || 'INFO').toUpperCase()}] ${String(message || '').trimEnd()}`;
  buffer.push(line);
  if (buffer.length > MAX_LINES) buffer.shift();
  for (const subscriber of subscribers) subscriber(line);
}

export function tailLogs(count = 200) {
  return buffer.slice(-count);
}

export function subscribeLogs(callback) {
  subscribers.add(callback);
  return () => subscribers.delete(callback);
}

export function logBufferSize() {
  return buffer.length;
}
