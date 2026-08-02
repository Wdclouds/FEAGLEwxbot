import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import * as Lark from '@larksuiteoapi/node-sdk';

const DEFAULT_BINDING_PATH = '/app/data/feishu/binding.json';
const MAX_SEEN_MESSAGES = 100;

export function loadFeishuBinding(path = DEFAULT_BINDING_PATH) {
  if (!existsSync(path)) return null;
  const binding = JSON.parse(readFileSync(path, 'utf8'));
  if (
    binding?.receiveIdType !== 'open_id'
    || !/^ou_[a-zA-Z0-9]+$/.test(String(binding?.receiveId || ''))
  ) {
    throw new Error('Stored Feishu binding is invalid');
  }
  return binding;
}

export function saveFeishuBinding(openId, {
  path = DEFAULT_BINDING_PATH,
  now = () => Date.now(),
} = {}) {
  const normalized = String(openId || '').trim();
  if (!/^ou_[a-zA-Z0-9]+$/.test(normalized)) {
    throw new TypeError('Invalid Feishu open_id');
  }
  const binding = {
    version: 1,
    receiveIdType: 'open_id',
    receiveId: normalized,
    boundAt: new Date(now()).toISOString(),
  };
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(binding, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
  return binding;
}

export function parseBindingMessage(data) {
  if (data?.message?.chat_type !== 'p2p') return null;
  if (data?.message?.message_type !== 'text') return null;
  const openId = data?.sender?.sender_id?.open_id;
  if (!/^ou_[a-zA-Z0-9]+$/.test(String(openId || ''))) return null;
  let text;
  try {
    text = JSON.parse(data.message.content || '{}').text;
  } catch {
    return null;
  }
  const normalizedText = String(text || '').trim().toLowerCase();
  if (!['绑定', 'bind'].includes(normalizedText)) return null;
  return {
    openId,
    messageId: String(data.message.message_id || ''),
  };
}

export class FeishuBindingClient {
  constructor({
    state,
    notifier,
    appId = process.env.FEISHU_APP_ID,
    appSecret = process.env.FEISHU_APP_SECRET,
    bindingPath = process.env.FEISHU_BINDING_PATH || DEFAULT_BINDING_PATH,
    wsClientFactory = (options) => new Lark.WSClient(options),
    eventDispatcherFactory = () => new Lark.EventDispatcher({}),
    now = () => Date.now(),
  }) {
    this.state = state;
    this.notifier = notifier;
    this.appId = String(appId || '').trim();
    this.appSecret = String(appSecret || '').trim();
    this.bindingPath = bindingPath;
    this.wsClientFactory = wsClientFactory;
    this.eventDispatcherFactory = eventDispatcherFactory;
    this.now = now;
    this.wsClient = null;
    this.startPromise = null;
    this.stopping = false;
    this.seenMessages = new Set();
  }

  start() {
    if (!this.appId || !this.appSecret || this.wsClient) return;
    this.stopping = false;
    const eventDispatcher = this.eventDispatcherFactory().register({
      'im.message.receive_v1': async (data) => {
        this.handleMessage(data);
      },
    });
    this.state.patch('notifications', {
      connection: 'CONNECTING',
      detail: this.notifier.enabled
        ? '飞书长连接建立中，私聊通知已绑定'
        : '飞书长连接建立中，等待私聊发送“绑定”',
    });
    this.wsClient = this.wsClientFactory({
      appId: this.appId,
      appSecret: this.appSecret,
      domain: Lark.Domain.Feishu,
      loggerLevel: Lark.LoggerLevel.error,
      autoReconnect: true,
      handshakeTimeoutMs: 10_000,
      onReady: () => {
        if (this.stopping) return;
        this.state.patch('notifications', {
          connection: 'CONNECTED',
          status: this.notifier.enabled ? 'READY' : 'WAITING_BIND',
          detail: this.notifier.enabled
            ? '飞书长连接正常，私聊通知已绑定'
            : '飞书长连接正常，请在机器人私聊发送“绑定”',
        });
      },
      onReconnecting: () => {
        if (this.stopping) return;
        this.state.patch('notifications', {
          connection: 'RECONNECTING',
          detail: '飞书长连接断开，正在自动重连',
        });
      },
      onReconnected: () => {
        if (this.stopping) return;
        this.state.patch('notifications', {
          connection: 'CONNECTED',
          status: this.notifier.enabled ? 'READY' : 'WAITING_BIND',
          detail: '飞书长连接已恢复',
        });
      },
      onError: (error) => {
        if (this.stopping) return;
        this.state.patch('notifications', {
          connection: 'ERROR',
          status: 'ERROR',
          detail: String(error?.message || error).slice(0, 200),
        });
        this.state.addError('feishu-binding', error);
      },
    });
    this.startPromise = this.wsClient.start({ eventDispatcher }).catch((error) => {
      if (this.stopping) return;
      this.state.patch('notifications', {
        connection: 'ERROR',
        status: 'ERROR',
        detail: String(error?.message || error).slice(0, 200),
      });
      this.state.addError('feishu-binding', error);
    });
  }

  handleMessage(data) {
    const bindingRequest = parseBindingMessage(data);
    if (!bindingRequest) return false;
    if (
      bindingRequest.messageId
      && this.seenMessages.has(bindingRequest.messageId)
    ) return true;
    if (bindingRequest.messageId) {
      this.seenMessages.add(bindingRequest.messageId);
      while (this.seenMessages.size > MAX_SEEN_MESSAGES) {
        this.seenMessages.delete(this.seenMessages.values().next().value);
      }
    }

    let existing = null;
    try {
      existing = loadFeishuBinding(this.bindingPath);
    } catch (error) {
      this.state.addError('feishu-binding-store', error);
    }
    if (existing && existing.receiveId !== bindingRequest.openId) {
      this.state.addError(
        'feishu-binding',
        new Error('Ignored a binding request from a different Feishu user'),
      );
      return true;
    }

    let binding;
    try {
      binding = saveFeishuBinding(bindingRequest.openId, {
        path: this.bindingPath,
        now: this.now,
      });
    } catch (error) {
      this.state.addError('feishu-binding-store', error);
      return false;
    }
    this.notifier.setRecipient(binding.receiveIdType, binding.receiveId);
    this.state.patch('notifications', {
      connection: 'CONNECTED',
      bindingStatus: 'BOUND',
      status: 'READY',
      detail: existing ? '飞书私聊绑定已确认' : '飞书私聊绑定成功',
    });
    void this.notifier.enqueue('BOUND', () => this.notifier.sendText(
      '✅ Feagle WxBot 私聊绑定成功。以后微信掉线、自动恢复和登录二维码会发送到这里。',
    )).catch(() => {});
    return true;
  }

  stop() {
    this.stopping = true;
    this.wsClient?.close({ force: true });
    this.wsClient = null;
  }
}
