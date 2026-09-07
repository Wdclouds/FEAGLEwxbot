import { spawn, execSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import os from 'node:os';
import { EventEmitter } from 'node:events';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class ProcessManager extends EventEmitter {
  constructor(app) {
    super();
    this.app = app;
    this.isPackaged = app ? app.isPackaged : false;
    this.managedChildren = [];
    this.logs = [];
    this.maxLogs = 1000;
    this.isShuttingDown = false;

    this.initPaths();
    this.loadEnv();
  }

  initPaths() {
    if (this.isPackaged) {
      this.resourcesDir = process.resourcesPath || join(dirname(process.execPath), 'resources');
      this.coreRoot = join(this.resourcesDir, 'core');

      // 便携模式优先检测：若 exe 所在目录存在 data/ 或为 portable 运行环境
      const exeDir = dirname(process.execPath);
      const portableDataDir = join(exeDir, 'data');
      if (existsSync(portableDataDir) || process.env.PORTABLE_EXECUTABLE_DIR) {
        this.dataDir = portableDataDir;
      } else {
        this.dataDir = join(this.app.getPath('userData'), 'data');
      }

      this.bridgeDir = join(this.coreRoot, 'apps', 'bridge');
      this.mnemosyneDir = join(this.coreRoot, 'deploy', 'mnemosyne', 'windows-shim');
    } else {
      // 开发模式：项目根目录
      this.projectRoot = resolve(__dirname, '../../../');
      this.coreRoot = this.projectRoot;
      this.dataDir = resolve(this.projectRoot, 'data');
      this.bridgeDir = resolve(this.projectRoot, 'apps/bridge');
      this.mnemosyneDir = resolve(this.projectRoot, 'deploy/mnemosyne/windows-shim');
    }

    this.ensureDirs();
  }

  ensureDirs() {
    const dirs = [
      this.dataDir,
      join(this.dataDir, 'wechat'),
      join(this.dataDir, 'android'),
      join(this.dataDir, 'feishu'),
    ];
    for (const d of dirs) {
      if (!existsSync(d)) {
        try { mkdirSync(d, { recursive: true }); } catch {}
      }
    }
  }

  loadEnv() {
    this.env = { ...process.env };
    const candidates = [
      join(this.dataDir, '.env'),
      this.isPackaged ? join(this.coreRoot, '.env') : resolve(this.projectRoot, '.env'),
    ];

    for (const envPath of candidates) {
      if (existsSync(envPath)) {
        this.appendLog('system', `正在加载环境变量: ${envPath}`);
        try {
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
              if (!this.env[key]) {
                this.env[key] = val;
              }
            }
          }
        } catch (err) {
          this.appendLog('error', `加载 .env 出错: ${err.message}`);
        }
        break;
      }
    }

    // 端口定义
    this.dashboardPort = Number(this.env.BOT_DASHBOARD_PORT || this.env.DASHBOARD_HOST_PORT || 6190);
    this.androidPort = Number(this.env.ANDROID_WS_PORT || this.env.ANDROID_WS_HOST_PORT || 6191);
    this.mnemosynePort = Number(this.env.MNEMOSYNE_PORT || 18010);
    this.backend = this.env.BOT_BACKEND || 'hermes';
  }

  appendLog(tag, message) {
    const entry = {
      timestamp: new Date().toLocaleTimeString(),
      tag,
      message,
    };
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
    this.emit('log', entry);
  }

  checkPort(port, host = '127.0.0.1', timeoutMs = 600) {
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

  async waitForPort(port, host = '127.0.0.1', maxRetries = 30, intervalMs = 500) {
    for (let i = 0; i < maxRetries; i++) {
      const isUp = await this.checkPort(port, host, 300);
      if (isUp) return true;
      await new Promise(r => setTimeout(r, intervalMs));
    }
    return false;
  }

  resolveNodeRuntime() {
    // 检查系统是否有全局 node
    try {
      execSync('where node', { stdio: 'ignore' });
      return 'node';
    } catch {}

    // 如果没有全局 node，且是 Electron 环境，使用 process.execPath 并开启 ELECTRON_RUN_AS_NODE
    return process.execPath;
  }

  spawnChild(name, executable, args, cwd, extraEnv = {}) {
    const isElectronNode = executable === process.execPath;
    const spawnEnv = {
      ...this.env,
      ...extraEnv,
      ...(isElectronNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    };

    const child = spawn(executable, args, {
      cwd,
      env: spawnEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const pipeOutput = (stream, isErr) => {
      stream.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        const lines = text.split('\n');
        for (const line of lines) {
          const clean = line.replace(/\r/g, '').trimEnd();
          if (clean) {
            this.appendLog(isErr ? `${name}:err` : name, clean);
          }
        }
      });
    };

    if (child.stdout) pipeOutput(child.stdout, false);
    if (child.stderr) pipeOutput(child.stderr, true);

    child.on('error', (err) => {
      this.appendLog('error', `[${name}] 启动异常: ${err.message}`);
    });

    child.on('exit', (code, signal) => {
      this.appendLog('system', `[${name}] 进程退出 (代码: ${code}, 信号: ${signal})`);
    });

    this.managedChildren.push({ name, child });
    return child;
  }

  async startAll() {
    this.appendLog('system', '=== 正在拉起 FEAGLE WxBot 核心桌面服务组 ===');
    const nodeExe = this.resolveNodeRuntime();

    // 1. Mnemosyne 记忆垫片
    const enableMemory = this.backend === 'hermes' || this.env.MNEMOSYNE_ENABLED === 'true';
    if (enableMemory) {
      const memoryUp = await this.checkPort(this.mnemosynePort);
      if (memoryUp) {
        this.appendLog('system', `[记忆组件] 端口 ${this.mnemosynePort} 活跃，复用现有服务`);
      } else {
        const shimPath = join(this.mnemosyneDir, 'server.js');
        if (existsSync(shimPath)) {
          this.appendLog('system', `[记忆组件] 启动 Mnemosyne 垫片 (127.0.0.1:${this.mnemosynePort})...`);
          this.spawnChild('Memory', nodeExe, [shimPath], this.mnemosyneDir, {
            MNEMOSYNE_PORT: String(this.mnemosynePort),
            MNEMOSYNE_HOST: '127.0.0.1',
            MNEMOSYNE_SQLITE_PATH: join(this.dataDir, 'memory.sqlite'),
          });
        }
      }
    }

    // 2. WeChat Bridge 中枢
    const bridgeUp = await this.checkPort(this.dashboardPort);
    if (bridgeUp) {
      this.appendLog('system', `[中枢网关] 端口 ${this.dashboardPort} 已在监听，直接连接`);
    } else {
      const bridgeEntry = join(this.bridgeDir, 'src', 'index.js');
      if (existsSync(bridgeEntry)) {
        this.appendLog('system', `[中枢网关] 启动 WeChat Bridge (端口: ${this.dashboardPort})...`);
        this.spawnChild('Bridge', nodeExe, [bridgeEntry], this.bridgeDir, {
          DATA_DIR: this.dataDir,
          BOT_DASHBOARD_PORT: String(this.dashboardPort),
          ANDROID_WS_PORT: String(this.androidPort),
          MNEMOSYNE_BASE_URL: `http://127.0.0.1:${this.mnemosynePort}`,
        });
      } else {
        this.appendLog('error', `未找到 Bridge 入口文件: ${bridgeEntry}`);
      }
    }

    // 等待 Bridge 就绪
    const isReady = await this.waitForPort(this.dashboardPort);
    if (isReady) {
      this.appendLog('system', `[中枢网关] 核心已成功就绪 (http://127.0.0.1:${this.dashboardPort})`);
    } else {
      this.appendLog('error', `[中枢网关] 等待就绪超时，请检查实时日志输出`);
    }

    return isReady;
  }

  stopAll() {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    this.appendLog('system', '正在安全终止所有关联核心子进程树...');

    for (const { name, child } of this.managedChildren) {
      if (child && child.pid) {
        try {
          if (process.platform === 'win32') {
            execSync(`taskkill /F /T /PID ${child.pid} >nul 2>&1`);
          } else {
            process.kill(child.pid, 'SIGKILL');
          }
        } catch {}
      }
    }
    this.managedChildren = [];
    this.appendLog('system', '所有后台子进程已彻底销毁，零残留。');
  }
}
