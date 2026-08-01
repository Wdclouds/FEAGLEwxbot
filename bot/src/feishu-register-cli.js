import { chmod, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Lark from '@larksuiteoapi/node-sdk';
import QRCode from 'qrcode';

export const REQUIRED_FEISHU_ADDONS = Object.freeze({
  preset: false,
  scopes: {
    tenant: [
      'im:message.p2p_msg:readonly',
      'im:message:send_as_bot',
    ],
  },
  events: {
    items: {
      tenant: ['im.message.receive_v1'],
    },
  },
});

export function buildRegistrationOptions({ onQRCodeReady, onStatusChange } = {}) {
  return {
    source: 'feagle-wxbot-bridge',
    appPreset: {
      name: 'FEAGLE WxBot - {user}',
      desc: 'FEAGLE 微信机器人掉线、扫码与恢复通知',
    },
    addons: REQUIRED_FEISHU_ADDONS,
    // Keep createOnly unset: the official landing page may create a new app
    // or let the administrator select an existing app.
    onQRCodeReady,
    onStatusChange,
  };
}

export function credentialsEnv(result) {
  const appId = String(result?.client_id || '').trim();
  const appSecret = String(result?.client_secret || '').trim();
  if (!/^cli_[A-Za-z0-9_-]+$/.test(appId)) {
    throw new Error('飞书返回了无效的 App ID');
  }
  if (!/^[A-Za-z0-9_-]{8,}$/.test(appSecret)) {
    throw new Error('飞书返回了无效的 App Secret');
  }
  return `FEISHU_APP_ID=${appId}\nFEISHU_APP_SECRET=${appSecret}\n`;
}

export async function registerFeishuApp({
  outputPath,
  registerApp = Lark.registerApp,
  renderQr = (url) => QRCode.toString(url, { type: 'terminal', small: true }),
  stdout = process.stdout,
} = {}) {
  if (!outputPath) throw new Error('缺少凭据输出路径');

  let resolveQr;
  let rejectQr;
  const qrReady = new Promise((resolvePromise, rejectPromise) => {
    resolveQr = resolvePromise;
    rejectQr = rejectPromise;
  });

  const registration = registerApp(buildRegistrationOptions({
    onQRCodeReady(info) {
      resolveQr(info);
    },
    onStatusChange(info) {
      if (info.status === 'domain_switched') {
        stdout.write('\n已切换到 Lark 国际版授权域名。\n');
      } else {
        stdout.write('.');
      }
    },
  }));
  registration.catch(rejectQr);

  const qrInfo = await qrReady;
  stdout.write('\n请使用飞书/Lark 扫描二维码，或在浏览器打开下面的链接：\n\n');
  stdout.write(`${await renderQr(qrInfo.url)}\n`);
  stdout.write(`${qrInfo.url}\n\n`);
  stdout.write(`授权链接约 ${qrInfo.expireIn} 秒后过期。正在等待授权`);

  const result = await registration;
  stdout.write('\n飞书应用授权完成。\n');
  const target = resolve(outputPath);
  await writeFile(target, credentialsEnv(result), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  await chmod(target, 0o600);
  return result;
}

function outputArgument(argv) {
  const index = argv.indexOf('--output');
  return index >= 0 ? argv[index + 1] : '';
}

const isMain = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  registerFeishuApp({ outputPath: outputArgument(process.argv.slice(2)) })
    .catch((error) => {
      const code = String(error?.code || 'registration_failed');
      const detail = String(error?.description || error?.message || error).slice(0, 300);
      process.stderr.write(`\n飞书扫码配置失败：${code} - ${detail}\n`);
      process.exitCode = 1;
    });
}
