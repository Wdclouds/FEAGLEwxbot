import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const protocolRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(protocolRoot, '..', '..');

const read = (relativePath) => readFile(path.join(repositoryRoot, relativePath), 'utf8');
const schema = JSON.parse(await read('packages/protocol/schemas/android-bridge-v1.schema.json'));
const compatibility = JSON.parse(await read('packages/protocol/compatibility.json'));
const bridgeSource = await read('apps/bridge/src/android-client.js');
const agentSource = await read(
  'apps/android-agent/app/src/main/java/io/github/wdclouds/feaglewxbot/agent/BridgeForegroundService.java',
);
const agentProtocol = await read(
  'apps/android-agent/app/src/main/java/io/github/wdclouds/feaglewxbot/agent/AgentProtocol.java',
);
const agentBuild = await read('apps/android-agent/app/build.gradle');
const bridgePackage = JSON.parse(await read('apps/bridge/package.json'));
const productVersion = (await read('VERSION')).trim();
const examples = [
  JSON.parse(await read('packages/protocol/examples/private-text.json')),
  JSON.parse(await read('packages/protocol/examples/send-text.json')),
];

const protocol = compatibility.protocol;
assert.equal(productVersion, compatibility.productVersion);
assert.equal(schema.properties.protocol.const, protocol);
assert.match(bridgeSource, new RegExp(`const PROTOCOL = ['\"]${protocol.replaceAll('.', '\\.')}`));
assert.match(agentSource, new RegExp(`put\\(event, ['\"]protocol['\"], ['\"]${protocol.replaceAll('.', '\\.')}`));
assert.match(agentProtocol, /MSG_GROUP_TEXT\s*=\s*6/);
assert.match(agentSource, /baseEnvelope\("group_text"\)/);
assert.match(bridgeSource, /case 'group_text':/);
assert.match(agentBuild, new RegExp(`versionName ['\"]${compatibility.androidAgentVersion.replaceAll('.', '\\.')}`));
assert.equal(bridgePackage.version, compatibility.bridgeVersion);

for (const example of examples) {
  assert.equal(example.protocol, protocol);
  assert(schema.properties.type.enum.includes(example.type));
}

for (const messageType of [
  'hello', 'heartbeat', 'private_text', 'group_text', 'event_ack',
  'event_nack', 'send_text', 'command_result',
]) {
  assert(schema.properties.type.enum.includes(messageType), `schema misses ${messageType}`);
}

console.log(`Protocol ${protocol} compatibility check passed.`);
