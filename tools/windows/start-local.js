#!/usr/bin/env node
import { spawn, execSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import net from 'node:net';
import readline from 'node:readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '../../');

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
};

// 1. 加载并解析 .env 文件
function loadEnv() {
  const envPath = resolve(PROJECT_ROOT, '.env');
  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
}

loadEnv();

// 基础配置
const BOT_BACKEND = process.env.BOT_BACKEND || 'hermes';
const DASHBOARD_PORT = Number(process.env.BOT_DASHBOARD_PORT || process.env.DASHBOARD_HOST_PORT || 6190);
const ANDROID_PORT = Number(process.env.ANDROID_WS_PORT || process.env.ANDROID_WS_HOST_PORT || 6191);
const MNEMOSYNE_PORT = Number(process.env.MNEMOSYNE_PORT || 18010);
const ASTRBOT_PORT = Number(process.env.ASTRBOT_WEBUI_HOST_PORT || 6185);

// 检查本地 TCP 端口是否已有服务在监听
function checkPort(host, port, timeoutMs = 600) {
  return new Promise((resolvePromise) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => {
      socket.destroy();
      resolvePromise(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolvePromise(false);
    });
    socket.on('error', () => {
      resolvePromise(false);
    });
    socket.connect(port, host);
  });
}

// 提取内网网卡 IP
function getLanIps() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push(net.address);
      }
    }
  }
  return ips;
}

// 确保数据目录存在
function ensureDirs() {
  const dataDir = resolve(PROJECT_ROOT, 'data');
  const dirs = [
    dataDir,
    join(dataDir, 'wechat'),
    join(dataDir, 'android'),
    join(dataDir, 'feishu'),
  ];
  for (const d of dirs) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

// 确保 Bridge node_modules
function ensureBridgeModules() {
  const nodeModulesPath = resolve(PROJECT_ROOT, 'apps/bridge/node_modules');
  if (!existsSync(nodeModulesPath)) {
    console.log(`${C.yellow}[启动准备] 检测到 apps/bridge 依赖尚未安装，正在快速安装...${C.reset}`);
    const reg = process.env.NPM_REGISTRY ? `--registry=${process.env.NPM_REGISTRY}` : '';
    try {
      execSync(`npm install --no-audit --prefer-offline ${reg}`, {
        cwd: resolve(PROJECT_ROOT, 'apps/bridge'),
        stdio: 'inherit',
      });
      console.log(`${C.green}[启动准备] Bridge 依赖安装完成！${C.reset}`);
    } catch (err) {
      console.error(`${C.red}[启动准备] 依赖安装失败: ${err.message}${C.reset}`);
    }
  }
}

// 托管子进程池
const managedChildren = [];

function pipeChildOutput(child, prefix, color) {
  const format = (data, isErr = false) => {
    const text = data.toString('utf8');
    const lines = text.split('\n');
    for (const line of lines) {
      const clean = line.replace(/\r/g, '').trimEnd();
      if (clean.length > 0) {
        const streamColor = isErr ? C.red : color;
        console.log(`${streamColor}${prefix}${C.reset} ${clean}`);
      }
    }
  };

  if (child.stdout) child.stdout.on('data', (d) => format(d, false));
  if (child.stderr) child.stderr.on('data', (d) => format(d, true));
}

function killProcessTree(pid) {
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /F /T /PID ${pid} >nul 2>&1`);
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {}
}

let isShuttingDown = false;
function shutdownAll(signal = 'SIGINT') {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n${C.yellow}[系统] 收到退出信号 (${signal})，正在安全停止所有 FEAGLE 本地服务...${C.reset}`);

  for (const { name, child } of managedChildren) {
    if (child && child.pid) {
      try {
        console.log(`  - 正在停止 ${name} (PID: ${child.pid})...`);
        killProcessTree(child.pid);
      } catch {}
    }
  }
  console.log(`${C.green}[系统] 所有本地服务已安全退出。${C.reset}`);
  setTimeout(() => process.exit(0), 300).unref();
}

process.on('SIGINT', () => shutdownAll('SIGINT'));
process.on('SIGTERM', () => shutdownAll('SIGTERM'));

async function main() {
  console.log(`${C.cyan}======================================================================${C.reset}`);
  console.log(`${C.bold}${C.green}           FEAGLE WxBot 微信 AI 智能体 (Windows 本地服务组)            ${C.reset}`);
  console.log(`${C.cyan}======================================================================${C.reset}`);
  console.log(`[运行环境] 0 Docker / 0 PostgreSQL / 100% 纯本地单机绿色托管`);
  console.log(`[当前大脑] ${C.bold}${BOT_BACKEND.toUpperCase()}${C.reset}`);

  ensureDirs();
  ensureBridgeModules();

  // ---------------------------------------------------------------------------
  // 1. 启动 Mnemosyne 记忆伴随伪装服务 (如果为 Hermes 或明确启用)
  // ---------------------------------------------------------------------------
  const enableMnemosyne = BOT_BACKEND === 'hermes' || process.env.MNEMOSYNE_ENABLED === 'true';
  if (enableMnemosyne) {
    const memoryAlreadyUp = await checkPort('127.0.0.1', MNEMOSYNE_PORT);
    if (memoryAlreadyUp) {
      console.log(`[记忆伴随] 端口 ${MNEMOSYNE_PORT} 已在运行中，复用现有记忆服务。`);
    } else {
      const shimServerPath = resolve(PROJECT_ROOT, 'deploy/mnemosyne/windows-shim/server.js');
      if (existsSync(shimServerPath)) {
        console.log(`[记忆伴随] 正在启动 Mnemosyne 本地伪装服务 (端口: ${MNEMOSYNE_PORT})...`);
        const memoryChild = spawn('node', [shimServerPath], {
          cwd: resolve(PROJECT_ROOT, 'deploy/mnemosyne/windows-shim'),
          env: {
            ...process.env,
            MNEMOSYNE_PORT: String(MNEMOSYNE_PORT),
            MNEMOSYNE_HOST: '127.0.0.1',
            MNEMOSYNE_SQLITE_PATH: resolve(PROJECT_ROOT, 'data/memory.sqlite'),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        managedChildren.push({ name: 'Mnemosyne Shim', child: memoryChild });
        pipeChildOutput(memoryChild, '[Memory]', C.magenta);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 2. 启动 WeChat Bridge 核心主中枢 (端口 6190 / 6191)
  // ---------------------------------------------------------------------------
  const bridgeAlreadyUp = await checkPort('127.0.0.1', DASHBOARD_PORT);
  if (bridgeAlreadyUp) {
    console.log(`[中枢网关] 端口 ${DASHBOARD_PORT} 已有服务在运行中 (如 Bridge 或端口映射)。`);
  } else {
    console.log(`[中枢网关] 正在启动 WeChat Bridge (Web: ${DASHBOARD_PORT} / Android: ${ANDROID_PORT})...`);
    const bridgeChild = spawn('node', ['src/index.js'], {
      cwd: resolve(PROJECT_ROOT, 'apps/bridge'),
      env: {
        ...process.env,
        DATA_DIR: resolve(PROJECT_ROOT, 'data'),
        BOT_DASHBOARD_PORT: String(DASHBOARD_PORT),
        ANDROID_WS_PORT: String(ANDROID_PORT),
        MNEMOSYNE_BASE_URL: `http://127.0.0.1:${MNEMOSYNE_PORT}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    managedChildren.push({ name: 'WeChat Bridge', child: bridgeChild });
    pipeChildOutput(bridgeChild, '[Bridge]', C.cyan);
  }

  // ---------------------------------------------------------------------------
  // 3. 启动 AI 大脑进程 (AstrBot 或 Hermes)
  // ---------------------------------------------------------------------------
  if (BOT_BACKEND === 'astrbot') {
    const astrbotDir = process.env.ASTRBOT_DIR
      ? resolve(process.env.ASTRBOT_DIR)
      : resolve(PROJECT_ROOT, 'deploy/astrbot');

    const venvPython = join(astrbotDir, '.venv/Scripts/python.exe');
    const pythonExe = existsSync(venvPython) ? venvPython : 'python';

    // 寻找入口 main.py
    const possibleEntries = [
      join(astrbotDir, 'main.py'),
      join(astrbotDir, 'AstrBot/main.py'),
    ];
    let entryPath = possibleEntries.find(p => existsSync(p));

    if (entryPath) {
      console.log(`[AI大脑] 正在拉起 AstrBot 插件生态平台 (Web: ${ASTRBOT_PORT})...`);
      const astrbotChild = spawn(pythonExe, [entryPath], {
        cwd: dirname(entryPath),
        env: {
          ...process.env,
          ASTRBOT_ROOT: astrbotDir,
          PYTHONPATH: dirname(entryPath),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      managedChildren.push({ name: 'AstrBot', child: astrbotChild });
      pipeChildOutput(astrbotChild, '[AstrBot]', C.green);
    } else {
      console.log(`  ${C.yellow}[提示] 未在 ${astrbotDir} 检测到 AstrBot 代码文件。${C.reset}`);
      console.log(`  ${C.dim}如需安装 AstrBot，请运行根目录下 setup-windows.bat，或在外部单独运行 AstrBot。${C.reset}`);
    }
  } else if (BOT_BACKEND === 'hermes') {
    const hermesDir = resolve(PROJECT_ROOT, 'deploy/hermes');
    const venvPython = join(hermesDir, '.venv/Scripts/python.exe');
    const pythonExe = existsSync(venvPython) ? venvPython : 'python';
    const hermesEntry = join(hermesDir, 'main.py');

    if (existsSync(hermesEntry)) {
      console.log(`[AI大脑] 正在拉起 Hermes 智能体引擎...`);
      const hermesChild = spawn(pythonExe, [hermesEntry], {
        cwd: hermesDir,
        env: {
          ...process.env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      managedChildren.push({ name: 'Hermes', child: hermesChild });
      pipeChildOutput(hermesChild, '[Hermes]', C.blue);
    } else {
      console.log(`  ${C.dim}[提示] Hermes 记忆伴随 (18010) 与 OneBot 网关 (ws://127.0.0.1:6199/ws) 持续就绪。${C.reset}`);
    }
  }

  // ---------------------------------------------------------------------------
  // 4. 打印拓扑信息与就绪访问指南
  // ---------------------------------------------------------------------------
  const lanIps = getLanIps();
  const primaryIp = lanIps[0] || '127.0.0.1';

  console.log(`\n${C.green}======================================================================${C.reset}`);
  console.log(`${C.bold}${C.green}              🚀 FEAGLE WxBot 全套服务启动就绪！                     ${C.reset}`);
  console.log(`${C.green}======================================================================${C.reset}`);
  console.log(`  ${C.bold}1. Web 管理控制台:${C.reset}`);
  console.log(`     - 本机地址:   ${C.cyan}http://127.0.0.1:${DASHBOARD_PORT}${C.reset}`);
  console.log(`     - 局域网地址: ${C.cyan}http://${primaryIp}:${DASHBOARD_PORT}${C.reset}`);
  if (BOT_BACKEND === 'astrbot') {
    console.log(`     - AstrBot 面板: ${C.cyan}http://127.0.0.1:${ASTRBOT_PORT}${C.reset}`);
  }
  if (enableMnemosyne) {
    console.log(`     - Mnemosyne 记忆接口: ${C.cyan}http://127.0.0.1:${MNEMOSYNE_PORT}/api/v1/memories/stats${C.reset}`);
  }
  console.log('');
  console.log(`  ${C.bold}2. 三星平板 (SM-X200) 免密配对:${C.reset}`);
  console.log(`     - 浏览器打开 ${C.cyan}http://127.0.0.1:${DASHBOARD_PORT}${C.reset}，点击【扫码配对】；`);
  console.log(`     - 或在平板 Hook 端填入: ${C.cyan}ws://${primaryIp}:${ANDROID_PORT}/android${C.reset}`);
  console.log('');
  console.log(`  ${C.dim}提示: 按 Ctrl + C 可安全停止全套服务。${C.reset}`);
  console.log(`${C.green}======================================================================${C.reset}\n`);

  // 自动打开浏览器控制台
  setTimeout(() => {
    try {
      execSync(`powershell -NoProfile -Command "Start-Process 'http://127.0.0.1:${DASHBOARD_PORT}'"`);
    } catch {}
  }, 2500).unref();
}

main().catch((err) => {
  console.error(`${C.red}[启动失败]${C.reset}`, err);
  process.exit(1);
});
