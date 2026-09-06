import net from 'node:net';
import os from 'node:os';
import { execSync } from 'node:child_process';

/**
 * 探测指定 host:port 的 TCP 连通性
 * @param {string} host
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
export function checkPort(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;

    socket.setTimeout(timeoutMs);

    socket.once('connect', () => {
      resolved = true;
      socket.destroy();
      resolve(true);
    });

    socket.once('timeout', () => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        resolve(false);
      }
    });

    socket.once('error', () => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        resolve(false);
      }
    });

    socket.connect(port, host);
  });
}

/**
 * 获取所有非回环的 IPv4 局域网地址
 */
export function getLanIps() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const netInfo of nets[name] || []) {
      if (netInfo.family === 'IPv4' && !netInfo.internal) {
        ips.push(netInfo.address);
      }
    }
  }
  return ips;
}

/**
 * 探测宿主机 Python 版本与命令
 */
export function detectPython() {
  const candidates = ['python', 'py -3', 'python3'];
  for (const cmd of candidates) {
    try {
      const output = execSync(`${cmd} --version`, {
        timeout: 1500,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      }).trim();
      if (output.toLowerCase().includes('python')) {
        return { available: true, command: cmd, version: output };
      }
    } catch {
      // try next
    }
  }
  return { available: false, command: null, version: null };
}

/**
 * 探测原生 Node.js 与 node:sqlite 支持情况
 */
export async function detectNodeRuntime() {
  let sqliteSupported = false;
  try {
    const sqlite = await import('node:sqlite');
    sqliteSupported = Boolean(sqlite?.DatabaseSync);
  } catch {
    sqliteSupported = false;
  }

  return {
    version: process.version,
    arch: process.arch,
    platform: process.platform,
    sqliteSupported,
  };
}

/**
 * 执行完整的系统与双大脑健康体检
 * @param {object} options
 * @param {object} [options.state] - RuntimeState 实例（可选）
 * @returns {Promise<object>}
 */
export async function runSystemDiagnosis({ state = null } = {}) {
  const dashPort = Number(process.env.BOT_DASHBOARD_PORT || 6190);
  const androidWsPort = Number(process.env.ANDROID_WS_HOST_PORT || process.env.ANDROID_WS_PORT || 6191);
  const hermesPort = Number(process.env.ONEBOT_REVERSE_WS_PORT || 6199);
  const astrbotPort = Number(process.env.ASTRBOT_PORT || 6185);
  const mnemosynePort = Number(process.env.MNEMOSYNE_PORT || 18010);

  // 并行端口连通性检查
  const [
    bridgeUp,
    androidWsUp,
    hermesUp,
    astrbotUp,
    mnemosyneUp,
    nodeInfo,
  ] = await Promise.all([
    checkPort('127.0.0.1', dashPort),
    checkPort('127.0.0.1', androidWsPort),
    checkPort('127.0.0.1', hermesPort),
    checkPort('127.0.0.1', astrbotPort),
    checkPort('127.0.0.1', mnemosynePort),
    detectNodeRuntime(),
  ]);

  const pythonInfo = detectPython();
  const lanIps = getLanIps();

  // 判定大脑存在状态
  let detectedBackend = 'none';
  if (hermesUp && astrbotUp) {
    detectedBackend = 'both';
  } else if (hermesUp) {
    detectedBackend = 'hermes';
  } else if (astrbotUp) {
    detectedBackend = 'astrbot';
  }

  const configuredBackend = process.env.BOT_BACKEND || (state ? state.snapshot()?.botBackend : 'hermes') || 'hermes';

  // 提取 Android 状态
  const snapshot = state ? state.snapshot() : {};
  const androidState = snapshot.android || {};
  const wechatState = snapshot.wechat || {};

  // 生成诊断建议
  const recommendations = [];
  if (!hermesUp && !astrbotUp) {
    recommendations.push({
      level: 'warning',
      code: 'NO_BACKEND_ONLINE',
      message: '未探测到活跃的大脑后端 (Hermes 6199 或 AstrBot 6185 未监听)。机器人将无法生成智能回复。',
      action: pythonInfo.available
        ? `系统已预装 ${pythonInfo.version}，可使用该 Python 启动 Hermes 或 AstrBot。`
        : '系统未检测到可用 Python 环境，请先安装 Python 3.10+。',
    });
  } else if (detectedBackend === 'both') {
    recommendations.push({
      level: 'info',
      code: 'DUAL_BACKEND_ACTIVE',
      message: '探测到 Hermes (6199) 与 AstrBot (6185) 同时在线。当前生效后端以 BOT_BACKEND 配置为准。',
      activeBackend: configuredBackend,
    });
  }

  if (!androidState.hookConnected) {
    recommendations.push({
      level: 'info',
      code: 'ANDROID_HOOK_WAITING',
      message: '三星平板微信 Hook 尚未建立长连接。',
      action: '请在控制台首页点击【扫码配对】，使用平板 Agent 对准二维码扫码 1 秒配对。',
    });
  }

  return {
    timestamp: new Date().toISOString(),
    overall: {
      healthy: bridgeUp && (hermesUp || astrbotUp),
      status: (hermesUp || astrbotUp) ? 'READY' : 'DEGRADED',
    },
    runtime: {
      node: nodeInfo,
      python: pythonInfo,
      os: {
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
        hostname: os.hostname(),
      },
    },
    network: {
      lanIps,
      primaryLanIp: lanIps[0] || '127.0.0.1',
    },
    services: {
      bridgeDashboard: {
        port: dashPort,
        listening: bridgeUp,
        desc: '微信网关 Web 控制台',
      },
      androidWs: {
        port: androidWsPort,
        listening: androidWsUp,
        desc: 'Android 平板 Hook 通信网关',
      },
      mnemosyneMemory: {
        port: mnemosynePort,
        listening: mnemosyneUp,
        type: process.env.MNEMOSYNE_LOCAL !== 'false' ? 'sqlite_shim_local' : 'remote_rest',
        desc: '长期记忆与画像服务',
      },
      hermesGateway: {
        port: hermesPort,
        listening: hermesUp,
        desc: 'Hermes Agent 智能体大脑 (OneBot v11 反向 WS)',
      },
      astrbot: {
        port: astrbotPort,
        listening: astrbotUp,
        desc: 'AstrBot 插件大脑 (Web & API)',
      },
    },
    backend: {
      configured: configuredBackend,
      detected: detectedBackend,
      hasHermes: hermesUp,
      hasAstrBot: astrbotUp,
    },
    device: {
      status: androidState.deviceStatus || 'UNKNOWN',
      hookConnected: Boolean(androidState.hookConnected),
      lastHeartbeatAt: androidState.lastHeartbeatAt || null,
      heartbeatAgeMs: androidState.heartbeatAgeMs || null,
      deviceIdMasked: androidState.deviceIdMasked || '--',
      wechatAccount: wechatState.account || '--',
    },
    recommendations,
  };
}
