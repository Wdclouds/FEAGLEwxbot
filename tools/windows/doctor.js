import { runSystemDiagnosis } from '../../apps/bridge/src/doctor.js';

async function main() {
  console.log('\x1b[36m=====================================================\x1b[0m');
  console.log('\x1b[1m\x1b[32m     FEAGLE WxBot 系统环境与双大脑健康体检器 (Doctor)    \x1b[0m');
  console.log('\x1b[36m=====================================================\x1b[0m\n');

  try {
    const report = await runSystemDiagnosis();

    // 1. 基础运行时
    console.log('\x1b[1m[1] 宿主机运行时与依赖环境:\x1b[0m');
    const nodeStatus = report.runtime.node.sqliteSupported
      ? '\x1b[32m[就绪 - 原生内置 node:sqlite]\x1b[0m'
      : '\x1b[33m[缺少 node:sqlite 支持]\x1b[0m';
    console.log(`  - Node.js 运行时:  ${report.runtime.node.version} (${report.runtime.node.arch}) ${nodeStatus}`);

    const pyStatus = report.runtime.python.available
      ? `\x1b[32m[就绪 - ${report.runtime.python.version}]\x1b[0m`
      : '\x1b[31m[未检测到系统 Python]\x1b[0m';
    console.log(`  - Python 运行时:   ${pyStatus}`);

    console.log(`  - 宿主操作系统:    Windows (${report.runtime.os.hostname || 'LocalHost'})`);
    console.log(`  - 局域网可用 IPv4: ${report.network.lanIps.join(', ') || '仅回环 127.0.0.1'}\n`);

    // 2. 核心网络与服务端口检测
    console.log('\x1b[1m[2] 核心服务与组件端口主动嗅探:\x1b[0m');
    const svcs = report.services;
    const formatSvc = (name, item) => {
      const mark = item.listening ? '\x1b[32m[ 活跃 ONLINE ]\x1b[0m' : '\x1b[90m[ 离线 OFFLINE ]\x1b[0m';
      const portStr = `:${item.port}`.padEnd(8);
      console.log(`  - ${mark} ${name.padEnd(18)} 端口 ${portStr} (${item.desc})`);
    };

    formatSvc('Bridge Web 控制台', svcs.bridgeDashboard);
    formatSvc('Android WS 网关', svcs.androidWs);
    formatSvc('Mnemosyne 记忆桩', svcs.mnemosyneMemory);
    formatSvc('Hermes Gateway', svcs.hermesGateway);
    formatSvc('AstrBot 插件中枢', svcs.astrbot);
    console.log('');

    // 3. 双大脑识别判定
    console.log('\x1b[1m[3] 智能大脑判定 (Hermes vs AstrBot):\x1b[0m');
    console.log(`  - 当前生效配置 (BOT_BACKEND): \x1b[35m${report.backend.configured.toUpperCase()}\x1b[0m`);
    let detectedStr = '';
    if (report.backend.detected === 'both') {
      detectedStr = '\x1b[33m双大脑均在运行 (Hermes 6199 + AstrBot 6185)\x1b[0m';
    } else if (report.backend.detected === 'hermes') {
      detectedStr = '\x1b[32mHermes Agent (6199) 已在线并接管对话与工具调用\x1b[0m';
    } else if (report.backend.detected === 'astrbot') {
      detectedStr = '\x1b[32mAstrBot (6185) 已在线，支持插件生态与管理后台\x1b[0m';
    } else {
      detectedStr = '\x1b[31m未检测到任何大脑在线 (Hermes 与 AstrBot 均离线)\x1b[0m';
    }
    console.log(`  - 实时在线状态: ${detectedStr}\n`);

    // 4. 诊断与操作建议
    if (report.recommendations.length > 0) {
      console.log('\x1b[1m[4] 诊断建议与操作指南:\x1b[0m');
      for (const rec of report.recommendations) {
        const tag = rec.level === 'warning' ? '\x1b[33m[!]\x1b[0m' : '\x1b[36m[*]\x1b[0m';
        console.log(`  ${tag} ${rec.message}`);
        if (rec.action) {
          console.log(`     \x1b[2m-> 建议操作: ${rec.action}\x1b[0m`);
        }
      }
      console.log('');
    }

    console.log('\x1b[36m=====================================================\x1b[0m\n');
  } catch (err) {
    console.error('\x1b[31m[体检失败]\x1b[0m 无法完成系统体检:', err);
    process.exitCode = 1;
  }
}

main();
