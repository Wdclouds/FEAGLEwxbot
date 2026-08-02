import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REQUIRED_FEISHU_ADDONS,
  buildRegistrationOptions,
  credentialsEnv,
  registerFeishuApp,
} from '../src/feishu-register-cli.js';

test('registration requests only the bridge bot scopes and permits existing apps', () => {
  const options = buildRegistrationOptions();
  assert.deepEqual(options.addons, REQUIRED_FEISHU_ADDONS);
  assert.deepEqual(options.addons.scopes.tenant, [
    'im:message.p2p_msg:readonly',
    'im:message:send_as_bot',
  ]);
  assert.deepEqual(options.addons.events.items.tenant, ['im.message.receive_v1']);
  assert.equal(Object.hasOwn(options, 'createOnly'), false);
  assert.equal(Object.hasOwn(options, 'appId'), false);
});

test('QR registration stores credentials without printing the secret', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'feagle-feishu-register-'));
  const outputPath = join(directory, 'credentials.env');
  let capturedOptions;
  let terminal = '';
  const secret = 'test_secret_123456';

  const registerApp = (options) => {
    capturedOptions = options;
    options.onQRCodeReady({
      url: 'https://open.feishu.cn/example?user_code=TEST-CODE',
      expireIn: 600,
    });
    options.onStatusChange({ status: 'polling' });
    return Promise.resolve({
      client_id: 'cli_test_application',
      client_secret: secret,
    });
  };

  await registerFeishuApp({
    outputPath,
    registerApp,
    renderQr: async (url) => `[QR ${url}]`,
    stdout: { write(chunk) { terminal += chunk; } },
  });

  assert.equal(capturedOptions.createOnly, undefined);
  assert.match(terminal, /open\.feishu\.cn\/example/);
  assert.match(terminal, /\[QR /);
  assert.doesNotMatch(terminal, new RegExp(secret));
  assert.equal(await readFile(outputPath, 'utf8'), [
    'FEISHU_APP_ID=cli_test_application',
    `FEISHU_APP_SECRET=${secret}`,
    '',
  ].join('\n'));
  if (process.platform !== 'win32') {
    assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  }
});

test('invalid registration credentials fail closed', () => {
  assert.throws(() => credentialsEnv({
    client_id: 'not-an-app-id',
    client_secret: 'test_secret_123456',
  }), /App ID/);
  assert.throws(() => credentialsEnv({
    client_id: 'cli_valid',
    client_secret: 'short',
  }), /App Secret/);
});
