#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import crypto from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '../../');

// 终端颜色格式化
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

function banner() {
  console.clear();
  console.log(`${C.cyan}${C.bold}`);
  console.log('  ███████╗███████╗ █████╗  ██████╗ ██╗     ███████╗');
  console.log('  ██╔════╝██╔════╝██╔══██╗██╔════╝ ██║     ██╔════╝');
  console.log('  █████╗  █████╗  ███████║██║  ███╗██║     █████╗  ');
  console.log('  ██╔══╝  ██╔══╝  ██╔══██║██║   ██║██║     ██╔══╝  ');
  console.log('  ██║     ███████╗██║  ██║╚██████╔╝███████╗███████╗');
  console.log('  ╚═╝     ╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚══════╝');
  console.log('   FEAGLE WxBot Windows 本地独立交互式部署向导 (Setup Wizard)');
  console.log(`${C.reset}`);
  console.log(` ${C.bold}方案理念${C.reset}: 100% 纯本地 Windows 运行 · 0 依赖服务器 / 0 Docker / 0 PostgreSQL`);
  console.log(` ${C.dim}全栈解耦 · 自由选大脑 · 平板局域网直连 · 工业级内核进程守护${C.reset}`);
  console.log(`${C.cyan}----------------------------------------------------------------------${C.reset}\n`);
}

async function testUrlLatency(urlStr, timeoutMs = 1500) {
  const start = Date.now();
  return new Promise((resolveResult) => {
    try {
      const parsed = new URL(urlStr);
      const mod = parsed.protocol === 'https:' ? https : http;
      const req = mod.request(
        parsed,
        {
          method: 'HEAD',
          timeout: timeoutMs,
          headers: { 'User-Agent': 'FEAGLE-Setup-Agent/1.0' },
        },
        (res) => {
          res.resume();
          resolveResult(Date.now() - start);
        },
      );
      req.on('timeout', () => {
        req.destroy();
        resolveResult(99999);
      });
      req.on('error', () => resolveResult(99999));
      req.end();
    } catch {
      resolveResult(99999);
    }
  });
}

function checkPort(host, port, timeoutMs = 600) {
  return new Promise((resolveResult) => {
    const socket = new net.Socket();
    let status = false;
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      status = true;
      socket.destroy();
    });
    socket.once('timeout', () => socket.destroy());
    socket.once('error', () => {});
    socket.once('close', () => resolveResult(status));
    socket.connect(port, host);
  });
}

function getLanIps() {
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

function detectPythonCommand() {
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
    } catch {}
  }
  return { available: false, command: null, version: null };
}

function detectGitCommand() {
  try {
    const output = execSync('git --version', {
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    }).trim();
    return { available: true, version: output };
  } catch {
    return { available: false, version: null };
  }
}

function updateEnvFile(filePath, keyValues) {
  let content = '';
  if (existsSync(filePath)) {
    content = readFileSync(filePath, 'utf8');
  } else {
    const examplePath = resolve(PROJECT_ROOT, '.env.example');
    if (existsSync(examplePath)) {
      content = readFileSync(examplePath, 'utf8');
    }
  }

  for (const [key, value] of Object.entries(keyValues)) {
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
    } else {
      content += `\n${key}=${value}`;
    }
  }
  writeFileSync(filePath, content.trim() + '\n', 'utf8');
}

function getEnvValue(filePath, key, fallback = '') {
  if (!existsSync(filePath)) return fallback;
  const content = readFileSync(filePath, 'utf8');
  const match = content.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return match ? match[1].trim() : fallback;
}

async function main() {
  banner();
  const rl = createInterface({ input, output });

  try {
    // =========================================================================
    // STEP 1: 宿主机运行环境检查
    // =========================================================================
    console.log(`${C.bold}${C.green}[步骤 1/7] 基础运行环境健康检查${C.reset}`);
    let sqliteSupported = false;
    try {
      const sqlite = await import('node:sqlite');
      sqliteSupported = Boolean(sqlite?.DatabaseSync);
    } catch {}

    console.log(`  - Node.js 运行时:  ${C.cyan}${process.version}${C.reset} (${process.arch}) ${sqliteSupported ? `${C.green}[OK 原生支持 node:sqlite]${C.reset}` : `${C.yellow}[缺少 node:sqlite]${C.reset}`}`);

    const py = detectPythonCommand();
    if (py.available) {
      console.log(`  - Python 运行时:   ${C.cyan}${py.version}${C.reset} (${py.command}) ${C.green}[OK 就绪]${C.reset}`);
    } else {
      console.log(`  - Python 运行时:   ${C.red}[未检测到系统 Python 3.10+]${C.reset}`);
      console.log(`    ${C.yellow}提示: 若运行 AstrBot 或 Hermes，建议先安装 Python 3.10+ (可在 python.org 下载)。${C.reset}`);
    }

    const git = detectGitCommand();
    console.log(`  - Git 版本管理:    ${git.available ? `${C.cyan}${git.version}${C.reset} ${C.green}[OK 就绪]${C.reset}` : `${C.yellow}[未检测到 Git 命令行]${C.reset}`}`);

    const lanIps = getLanIps();
    console.log(`  - 本机局域网 IPv4: ${C.cyan}${lanIps.join(', ') || '127.0.0.1 (仅本机)'}${C.reset}\n`);

    // 检查 apps/bridge 依赖
    const bridgeModules = resolve(PROJECT_ROOT, 'apps/bridge/node_modules');
    if (!existsSync(bridgeModules)) {
      console.log(`  ${C.yellow}[!] 检测到 Bridge 依赖尚未安装，正在自动执行 npm install...${C.reset}`);
      try {
        execSync('npm install --no-audit --prefer-offline', {
          cwd: resolve(PROJECT_ROOT, 'apps/bridge'),
          stdio: 'inherit',
        });
        console.log(`  ${C.green}[OK] Bridge 依赖安装完成！${C.reset}\n`);
      } catch (err) {
        console.log(`  ${C.red}[错误] npm install 失败: ${err.message}${C.reset}\n`);
      }
    }

    // =========================================================================
    // STEP 2: 网络环境测速与高速镜像矩阵探测
    // =========================================================================
    console.log(`${C.bold}${C.green}[步骤 2/7] 全局网络延迟测试 (1秒极速探测)${C.reset}`);
    process.stdout.write('  正在探测 GitHub、npm 与 PyPI 网络延迟...');

    const [ghLatency, ghFastLatency, npmOffLatency, npmMirLatency] = await Promise.all([
      testUrlLatency('https://github.com', 1500),
      testUrlLatency('https://ghfast.top', 1500),
      testUrlLatency('https://registry.npmjs.org', 1500),
      testUrlLatency('https://registry.npmmirror.com', 1500),
    ]);

    process.stdout.write('\r                                                     \r');
    console.log(`  - GitHub 官方延迟:      ${ghLatency < 90000 ? `${ghLatency} ms` : `${C.red}超时/不可达${C.reset}`}`);
    console.log(`  - GitHub 国内加速代理:  ${C.cyan}${ghFastLatency < 90000 ? `${ghFastLatency} ms` : '不可达'}${C.reset} (ghfast.top)`);
    console.log(`  - npm 官方源延迟:       ${npmOffLatency < 90000 ? `${npmOffLatency} ms` : `${C.red}超时${C.reset}`}`);
    console.log(`  - npm 国内镜像延迟:     ${C.cyan}${npmMirLatency < 90000 ? `${npmMirLatency} ms` : '超时'}${C.reset} (npmmirror.com)`);

    const isChinaNetwork = ghLatency > 2000 || ghFastLatency < ghLatency || npmOffLatency > 1500;
    console.log(`\n  检测推断当前网络环境: ${isChinaNetwork ? `${C.yellow}${C.bold}国内网络环境 (推荐开启加速)${C.reset}` : `${C.green}国际互联网环境${C.reset}`}`);

    const mirrorPrompt = isChinaNetwork ? '是否启用国内高速镜像矩阵加速？ [Y/n] (默认: Y): ' : '是否启用国内高速镜像矩阵加速？ [y/N] (默认: N): ';
    const mirrorAns = (await rl.question(`  ${mirrorPrompt}`)).trim().toLowerCase();
    const useMirror = isChinaNetwork ? (mirrorAns !== 'n') : (mirrorAns === 'y');

    const networkProfile = {
      useMirror,
      ghProxy: useMirror ? 'https://ghfast.top/' : '',
      npmRegistry: useMirror ? 'https://registry.npmmirror.com' : 'https://registry.npmjs.org',
      pypiIndex: useMirror ? 'https://mirrors.aliyun.com/pypi/simple/' : 'https://pypi.org/simple',
    };
    console.log(`  ${C.green}[OK] 镜像加速策略生效:${C.reset} Git代理=${networkProfile.ghProxy || '无'}, PyPI=${networkProfile.pypiIndex}\n`);

    // =========================================================================
    // STEP 3: 智能大脑选择 (Hermes vs AstrBot)
    // =========================================================================
    console.log(`${C.bold}${C.green}[步骤 3/7] 智能体核心大脑形态选择${C.reset}`);
    console.log('  FEAGLE WxBot 架构遵循全栈物理级解耦，支持两种截然不同的大脑：');
    console.log(`    ${C.bold}[1] AstrBot 丰富社群插件生态${C.reset} ${C.green}(推荐新手/轻量运营)${C.reset}`);
    console.log(`        - 内存占用仅 ~150MB，自带丰富娱乐游戏/早报搜歌/违禁词管理插件生态`);
    console.log(`        - 自带独立 6185 可视化管理面板与插件应用市场`);
    console.log(`    ${C.bold}[2] Hermes 深度自主思考智能体${C.reset} ${C.magenta}(推荐极客/高阶知识库)${C.reset}`);
    console.log(`        - 面向高阶多步规划、ReAct 思考循环与自主工具调用 (Tool/Function Calling)`);
    console.log(`        - 挂载 Mnemosyne 长期记忆与群聊技能库 (SKILL.md)`);

    let selectedBrain = 'astrbot';
    while (true) {
      const choice = (await rl.question(`\n  请选择要部署的智能体大脑 [1: AstrBot / 2: Hermes] (默认: 1): `)).trim();
      if (choice === '2') {
        selectedBrain = 'hermes';
        break;
      } else if (choice === '1' || choice === '') {
        selectedBrain = 'astrbot';
        break;
      }
      console.log(`  ${C.yellow}请输入有效选项 1 或 2${C.reset}`);
    }
    console.log(`  ${C.green}[OK] 已选择智能大脑: ${C.bold}${selectedBrain.toUpperCase()}${C.reset}\n`);

    // =========================================================================
    // STEP 4: 安装位置与目录指定
    // =========================================================================
    console.log(`${C.bold}${C.green}[步骤 4/7] 组件安装位置选择与 Git 隔离确认${C.reset}`);
    console.log(`  ${C.cyan}[目录存放说明]${C.reset}`);
    console.log(`  放进 FEAGLEwxbot 的子文件夹（如 ${C.bold}deploy\\${selectedBrain}${C.reset}）完全可行且强烈推荐！`);
    console.log(`  因为根目录 .gitignore 已经对 deploy/${selectedBrain}/、.venv/ 实现了物理级隔离，`);
    console.log(`  既能保持单机纯绿色便携，又绝对${C.bold}不会污染主 Git 代码库${C.reset}。`);
    console.log(`  当然，您也可以自由输入任意磁盘外部路径（如 D:\\AI\\${selectedBrain}）。`);

    const defaultInstallDir = resolve(PROJECT_ROOT, `deploy/${selectedBrain}`);
    const dirInput = (await rl.question(`\n  请输入安装目标目录 [直接回车使用默认推荐路径: ${C.cyan}deploy\\${selectedBrain}${C.reset}]: `)).trim();

    let targetDir = defaultInstallDir;
    if (dirInput) {
      targetDir = isAbsolute(dirInput) ? dirInput : resolve(PROJECT_ROOT, dirInput);
    }
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }
    console.log(`  ${C.green}[OK] 安装目标路径已确认: ${C.bold}${targetDir}${C.reset}\n`);

    // =========================================================================
    // STEP 5: 自动下载、虚拟环境配置与依赖安装
    // =========================================================================
    console.log(`${C.bold}${C.green}[步骤 5/7] 下载组件与配置独立 Python 隔离环境${C.reset}`);

    if (selectedBrain === 'astrbot') {
      const astrbotRepoDir = join(targetDir, 'AstrBot');
      const hasAstrBot = existsSync(join(astrbotRepoDir, 'main.py')) || existsSync(join(targetDir, 'main.py'));

      if (!hasAstrBot) {
        console.log(`  正在克隆 AstrBot 官方仓库到 ${targetDir}...`);
        const gitUrl = `${networkProfile.ghProxy}https://github.com/Soulter/AstrBot.git`;
        try {
          execSync(`git clone ${gitUrl} "${astrbotRepoDir}"`, { stdio: 'inherit' });
          console.log(`  ${C.green}[OK] AstrBot 源码克隆成功！${C.reset}`);
        } catch (err) {
          console.log(`  ${C.yellow}[!] git clone 失败，将尝试直接使用已有源码或离线目录...${C.reset}`);
        }
      } else {
        console.log(`  ${C.green}[OK] 检测到目标路径已存在 AstrBot 源码，跳过重复克隆。${C.reset}`);
      }

      // 创建 Python 虚拟环境 (venv)
      const venvDir = join(targetDir, '.venv');
      const venvPython = join(venvDir, 'Scripts/python.exe');
      const venvPip = join(venvDir, 'Scripts/pip.exe');

      if (py.available) {
        if (!existsSync(venvPython)) {
          console.log(`  正在为 AstrBot 创建独立 Python 虚拟环境: ${venvDir}...`);
          try {
            execSync(`${py.command} -m venv "${venvDir}"`, { stdio: 'inherit' });
            console.log(`  ${C.green}[OK] 虚拟环境创建完成！${C.reset}`);
          } catch (err) {
            console.log(`  ${C.yellow}[!] 虚拟环境创建失败: ${err.message}，将回退使用系统 Python。${C.reset}`);
          }
        }

        const pipCmd = existsSync(venvPip) ? `"${venvPip}"` : `${py.command} -m pip`;
        const reqFile = existsSync(join(astrbotRepoDir, 'requirements.txt'))
          ? join(astrbotRepoDir, 'requirements.txt')
          : (existsSync(join(targetDir, 'requirements.txt')) ? join(targetDir, 'requirements.txt') : null);

        if (reqFile) {
          console.log(`  正在安装 AstrBot 核心运行依赖 (使用镜像源: ${networkProfile.pypiIndex})...`);
          try {
            execSync(`${pipCmd} install -r "${reqFile}" -i ${networkProfile.pypiIndex}`, { stdio: 'inherit' });
            console.log(`  ${C.green}[OK] AstrBot Python 依赖就绪！${C.reset}`);
          } catch (err) {
            console.log(`  ${C.yellow}[!] pip install 产生警告或提示，可稍后检查: ${err.message}${C.reset}`);
          }
        }
      }
    } else {
      // Hermes 部署分支
      const hermesTemplate = resolve(PROJECT_ROOT, 'deploy/hermes/config.yaml.template');
      const hermesConfigFile = join(targetDir, 'config.yaml');
      if (existsSync(hermesTemplate) && !existsSync(hermesConfigFile)) {
        const tplContent = readFileSync(hermesTemplate, 'utf8');
        writeFileSync(hermesConfigFile, tplContent, 'utf8');
        console.log(`  ${C.green}[OK] 已生成 Hermes 默认配置: ${hermesConfigFile}${C.reset}`);
      }

      // 虚拟环境
      const venvDir = join(targetDir, '.venv');
      const venvPython = join(venvDir, 'Scripts/python.exe');
      const venvPip = join(venvDir, 'Scripts/pip.exe');
      if (py.available) {
        if (!existsSync(venvPython)) {
          console.log(`  正在为 Hermes 创建独立 Python 虚拟环境...`);
          try {
            execSync(`${py.command} -m venv "${venvDir}"`, { stdio: 'inherit' });
            console.log(`  ${C.green}[OK] Hermes 虚拟环境创建完成！${C.reset}`);
          } catch {}
        }
        const reqFile = resolve(PROJECT_ROOT, 'deploy/hermes/requirements.txt');
        if (existsSync(reqFile)) {
          const pipCmd = existsSync(venvPip) ? `"${venvPip}"` : `${py.command} -m pip`;
          console.log(`  正在安装 Hermes 运行依赖...`);
          try {
            execSync(`${pipCmd} install -r "${reqFile}" -i ${networkProfile.pypiIndex}`, { stdio: 'inherit' });
            console.log(`  ${C.green}[OK] Hermes Python 依赖就绪！${C.reset}`);
          } catch {}
        }
      }
    }
    console.log('');

    // =========================================================================
    // STEP 6: 记忆系统引导与 Windows 原生 SQLite 伪装服务配置
    // =========================================================================
    console.log(`${C.bold}${C.green}[步骤 6/7] 记忆系统设置 (Mnemosyne 本地伴随伪装)${C.reset}`);

    if (selectedBrain === 'hermes') {
      console.log(`  ${C.cyan}[关于 Hermes 记忆系统]${C.reset}`);
      console.log('  Hermes 依赖 Mnemosyne 外置记忆系统提供短期会话与长期记忆检索。');
      console.log('  官方原版依赖 Docker 运行庞大的 PostgreSQL + pgvector (内存占用超 500MB)。');
      console.log(`  ${C.bold}${C.green}FEAGLE 创新设计${C.reset}: 为您提供了独创的 Windows 独立记忆伴随伪装服务 (Shim)！`);
      console.log(`  - 纯原生 Node 22 node:sqlite，0 外部数据库依赖，内存仅占用 ~30MB`);
      console.log(`  - 100% 模拟 Mnemosyne REST API (端口 18010)，数据单文件存储在 ./data/memory.sqlite`);
      console.log(`  - 无论是 Bridge 还是 Hermes，均能无缝读写会话树、联系人画像与记忆检索！`);

      const memoryDbDir = resolve(PROJECT_ROOT, 'data');
      if (!existsSync(memoryDbDir)) mkdirSync(memoryDbDir, { recursive: true });

      // 测试记忆伪装服务是否可自检通过
      try {
        const shimPath = resolve(PROJECT_ROOT, 'deploy/mnemosyne/windows-shim/shim.js');
        const shimModule = await import(pathToFileURL(shimPath).href);
        const db = shimModule.initDatabase(resolve(PROJECT_ROOT, 'data/memory.sqlite'));
        console.log(`  ${C.green}[OK] 本地 SQLite 记忆数据库初始化校验成功！${C.reset}`);
      } catch (err) {
        console.log(`  ${C.yellow}[!] SQLite 记忆桩快速校验: ${err.message}${C.reset}`);
      }
    } else {
      console.log('  AstrBot 内置自洽的轻量上下文记忆引擎，无需额外安装外部向量数据库。');
      console.log(`  ${C.dim}如未来需要，随时可在 Bridge 中按需启动 18010 伴随记忆服务。${C.reset}`);
    }
    console.log('');

    // =========================================================================
    // STEP 7: 全系统核心端口嗅探、配置落盘与平板直连指引
    // =========================================================================
    console.log(`${C.bold}${C.green}[步骤 7/7] 核心服务端口活跃诊断与平板配对拓扑${C.reset}`);

    const portsToScan = [
      { name: 'Bridge Web 控制台', port: 6190, desc: '主控面板与管理入口' },
      { name: 'Android Hook WS', port: 6191, desc: '实体平板/安卓设备长连接' },
      { name: 'OneBot 反向 WS', port: 6199, desc: 'Hermes/AstrBot 通信总线' },
      { name: 'AstrBot Web/API', port: 6185, desc: 'AstrBot 独立面板与插件市场' },
      { name: 'Mnemosyne 记忆服务', port: 18010, desc: 'Node 22 SQLite 记忆伴随' },
    ];

    for (const item of portsToScan) {
      const inUse = await checkPort('127.0.0.1', item.port);
      const mark = inUse ? `${C.yellow}[占用/运行中]${C.reset}` : `${C.green}[空闲 可用]${C.reset}`;
      console.log(`  - 端口 ${String(item.port).padEnd(6)} ${mark} ${item.name.padEnd(20)} (${item.desc})`);
    }

    // 更新 .env 配置文件
    const envPath = resolve(PROJECT_ROOT, '.env');
    let existingToken = getEnvValue(envPath, 'ANDROID_BRIDGE_TOKEN');
    if (!existingToken || existingToken.includes('replace_with')) {
      existingToken = crypto.randomBytes(16).toString('hex');
    }

    const updates = {
      BOT_BACKEND: selectedBrain,
      DASHBOARD_HOST_PORT: '6190',
      ANDROID_WS_HOST_PORT: '6191',
      ANDROID_WS_PORT: '6191',
      ASTRBOT_WEBUI_HOST_PORT: '6185',
      ONEBOT_WS_URL: 'ws://127.0.0.1:6199/ws',
      ANDROID_BRIDGE_TOKEN: existingToken,
      PYPI_INDEX_URL: networkProfile.pypiIndex,
      NPM_REGISTRY: networkProfile.npmRegistry,
      ASTRBOT_GITHUB_PROXY: networkProfile.ghProxy,
    };
    updateEnvFile(envPath, updates);
    console.log(`\n  ${C.green}[OK] 系统配置已持久化至 .env 文件！${C.reset}`);

    // 平板接入指南
    const primaryIp = lanIps[0] || '127.0.0.1';
    console.log(`\n${C.cyan}======================================================================${C.reset}`);
    console.log(`${C.bold}${C.green}              🎉 FEAGLE WxBot Windows 本地配置完成！                  ${C.reset}`);
    console.log(`${C.cyan}======================================================================${C.reset}`);
    console.log(`  ${C.bold}1. 启动方式 (推荐以下任一方式):${C.reset}`);
    console.log(`     - 双击运行根目录快捷脚本: ${C.cyan}start-windows.bat${C.reset}`);
    console.log(`     - 命令行运行:             ${C.cyan}.\\feagle.cmd start${C.reset}`);
    console.log('');
    console.log(`  ${C.bold}2. Web 控制台访问:${C.reset}`);
    console.log(`     - 本机浏览器: ${C.cyan}http://127.0.0.1:6190${C.reset}`);
    console.log(`     - 局域网其他设备: ${C.cyan}http://${primaryIp}:6190${C.reset}`);
    if (selectedBrain === 'astrbot') {
      console.log(`     - AstrBot 插件后台: ${C.cyan}http://127.0.0.1:6185${C.reset}`);
    }
    console.log('');
    console.log(`  ${C.bold}3. 三星平板 (SM-X200) 免密扫码配对:${C.reset}`);
    console.log(`     ① 确保平板与此电脑连接在【同一个 Wi-Fi / 局域网路由器】下；`);
    console.log(`     ② 启动系统后打开电脑浏览器访问 ${C.cyan}http://127.0.0.1:6190${C.reset}；`);
    console.log(`     ③ 点击控制台右上角【扫码配对】，使用平板端的 FEAGLE Agent 对准屏幕扫码即可瞬间免密连通！`);
    console.log(`     ${C.dim}(手动填写地址: ws://${primaryIp}:6191/android)${C.reset}`);
    console.log(`${C.cyan}======================================================================${C.reset}\n`);

    const startNow = (await rl.question(`  是否现在立即启动系统服务？ [Y/n] (默认: Y): `)).trim().toLowerCase();
    if (startNow !== 'n') {
      console.log(`\n  ${C.green}正在拉起 FEAGLE WxBot 核心服务栈...${C.reset}\n`);
      rl.close();
      const startScript = resolve(PROJECT_ROOT, 'tools/windows/start-local.js');
      // 调用本地一键启动管理
      await import(pathToFileURL(startScript).href);
      return;
    }
  } catch (err) {
    console.error(`\n${C.red}[向导异常]${C.reset}`, err);
  } finally {
    rl.close();
  }
}

main();
