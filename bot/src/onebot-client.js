import WebSocket from 'ws';

const HEARTBEAT_INTERVAL_MS = 15_000;
const RECONNECT_INTERVAL_MS = 3_000;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function ok(data, echo) {
  return { status: 'ok', retcode: 0, data, echo };
}

function failed(message, echo, retcode = 100) {
  return {
    status: 'failed',
    retcode,
    data: null,
    message,
    wording: message,
    echo,
  };
}

export function extractPlainText(message) {
  if (typeof message === 'string') return message;
  if (!Array.isArray(message)) return '';
  return message
    .filter((segment) => segment?.type === 'text')
    .map((segment) => String(segment?.data?.text || ''))
    .join('');
}

export class OneBotClient {
  constructor({
    state,
    idMap,
    wechat,
    isSleeping,
    maxInFlight = positiveInteger(process.env.BOT_MAX_INFLIGHT, 3),
    maxInFlightPerUser = positiveInteger(process.env.BOT_MAX_INFLIGHT_PER_USER, 1),
    requestTimeoutMs = positiveInteger(process.env.BOT_REQUEST_TIMEOUT_MS, 180_000),
    connectionWaitMs = positiveInteger(process.env.BOT_CONNECTION_WAIT_MS, 45_000),
  }) {
    this.state = state;
    this.idMap = idMap;
    this.wechat = wechat;
    this.isSleeping = isSleeping;
    this.ws = null;
    this.stopping = false;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.maxInFlight = maxInFlight;
    this.maxInFlightPerUser = maxInFlightPerUser;
    this.requestTimeoutMs = requestTimeoutMs;
    this.connectionWaitMs = connectionWaitMs;
    this.nextPendingId = 1;
    this.pendingRequests = new Map();
    this.pendingByUser = new Map();
    this.connectionWaiters = new Set();
  }

  start() {
    this.connect();
  }

  connect() {
    if (this.stopping || !this.wechat.selfId) {
      this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_INTERVAL_MS);
      this.reconnectTimer.unref();
      return;
    }

    this.state.patch('onebot', {
      status: 'CONNECTING',
      detail: '连接 ws://127.0.0.1:6199/ws',
    });

    this.ws = new WebSocket(
      process.env.ONEBOT_WS_URL || 'ws://127.0.0.1:6199/ws',
      {
        headers: {
          'X-Self-ID': String(this.wechat.selfId),
          'X-Client-Role': 'Universal',
        },
      },
    );

    this.ws.on('open', () => {
      this.state.patch('onebot', {
        status: 'CONNECTED',
        detail: 'AstrBot aiocqhttp 已连接',
      });
      this.resolveConnectionWaiters();
      this.sendEvent({
        time: Math.floor(Date.now() / 1000),
        self_id: this.wechat.selfId,
        post_type: 'meta_event',
        meta_event_type: 'lifecycle',
        sub_type: 'connect',
      });
      this.startHeartbeat();
    });

    this.ws.on('message', (data) => {
      void this.handleAction(data);
    });

    this.ws.on('error', (error) => {
      this.state.patch('onebot', {
        status: 'ERROR',
        detail: error.message,
      });
    });

    this.ws.on('close', () => {
      this.stopHeartbeat();
      this.clearPendingRequests();
      if (this.stopping) return;
      const reconnects = this.state.onebot.reconnects + 1;
      this.state.patch('onebot', {
        status: 'DISCONNECTED',
        reconnects,
        detail: '连接断开，3 秒后重连',
      });
      this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_INTERVAL_MS);
      this.reconnectTimer.unref();
    });
  }

  startHeartbeat() {
    this.stopHeartbeat();
    const heartbeat = () => {
      if (this.ws?.readyState !== WebSocket.OPEN || !this.wechat.selfId) return;
      const now = new Date().toISOString();
      this.sendEvent({
        time: Math.floor(Date.now() / 1000),
        self_id: this.wechat.selfId,
        post_type: 'meta_event',
        meta_event_type: 'heartbeat',
        status: {
          online: this.wechat.loggedIn,
          good: this.wechat.loggedIn && !this.isSleeping(),
        },
        interval: HEARTBEAT_INTERVAL_MS,
      });
      this.state.patch('onebot', { lastHeartbeatAt: now });
    };
    heartbeat();
    this.heartbeatTimer = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  sendEvent(event) {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      throw new Error('OneBot WebSocket 未连接');
    }
    this.ws.send(JSON.stringify(event));
  }

  async sendPrivateText({ userId, nickname, text, wechatMessageId }) {
    await this.waitForConnection();
    if (this.ws?.readyState !== WebSocket.OPEN) {
      throw new Error('AstrBot OneBot WebSocket 未连接');
    }
    const pendingId = this.reserveRequest(userId);
    const event = {
      time: Math.floor(Date.now() / 1000),
      self_id: this.wechat.selfId,
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 0,
      user_id: userId,
      message: [{ type: 'text', data: { text } }],
      raw_message: text,
      font: 0,
      sender: {
        user_id: userId,
        nickname,
        sex: 'unknown',
        age: 0,
      },
    };
    try {
      const messageId = this.idMap.storeMessage(wechatMessageId, event);
      event.message_id = messageId;
      this.idMap.updateMessage(messageId, event);
      this.sendEvent(event);
      this.state.increment('forwarded');
    } catch (error) {
      this.releaseRequest(pendingId);
      throw error;
    }
    return pendingId;
  }

  async sendGroupText({
    groupId,
    groupName,
    userId,
    nickname,
    text,
    wechatMessageId,
  }) {
    await this.waitForConnection();
    if (this.ws?.readyState !== WebSocket.OPEN) {
      throw new Error('AstrBot OneBot WebSocket 未连接');
    }
    const pendingKey = `group:${groupId}`;
    const pendingId = this.reserveRequest(pendingKey);
    const event = {
      time: Math.floor(Date.now() / 1000),
      self_id: this.wechat.selfId,
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 0,
      group_id: Number(groupId),
      user_id: Number(userId),
      message: [
        { type: 'at', data: { qq: String(this.wechat.selfId) } },
        { type: 'text', data: { text } },
      ],
      raw_message: `[CQ:at,qq=${this.wechat.selfId}] ${text}`,
      font: 0,
      sender: {
        user_id: Number(userId),
        nickname,
        card: nickname,
        sex: 'unknown',
        age: 0,
        area: '',
        level: '',
        role: 'member',
        title: '',
      },
      anonymous: null,
      group_name: groupName,
    };
    try {
      const messageId = this.idMap.storeMessage(wechatMessageId, event);
      event.message_id = messageId;
      this.idMap.updateMessage(messageId, event);
      this.sendEvent(event);
      this.state.increment('forwarded');
    } catch (error) {
      this.releaseRequest(pendingId);
      throw error;
    }
    return pendingId;
  }

  waitForConnection() {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.stopping) {
      const error = new Error('OneBot client is stopping');
      error.code = 'UPSTREAM_UNAVAILABLE';
      return Promise.reject(error);
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: null,
      };
      waiter.timer = setTimeout(() => {
        this.connectionWaiters.delete(waiter);
        const error = new Error('AstrBot OneBot WebSocket connection timed out');
        error.code = 'UPSTREAM_UNAVAILABLE';
        reject(error);
      }, this.connectionWaitMs);
      waiter.timer.unref();
      this.connectionWaiters.add(waiter);
    });
  }

  resolveConnectionWaiters() {
    for (const waiter of this.connectionWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    this.connectionWaiters.clear();
  }

  rejectConnectionWaiters(message = 'OneBot client stopped') {
    for (const waiter of this.connectionWaiters) {
      clearTimeout(waiter.timer);
      const error = new Error(message);
      error.code = 'UPSTREAM_UNAVAILABLE';
      waiter.reject(error);
    }
    this.connectionWaiters.clear();
  }

  reserveRequest(userId) {
    const normalizedUserId = String(userId);
    const userPending = this.pendingByUser.get(normalizedUserId) || new Set();
    if (
      this.pendingRequests.size >= this.maxInFlight
      || userPending.size >= this.maxInFlightPerUser
    ) {
      const error = new Error('AstrBot 当前处理队列已满，请稍后再试');
      error.code = 'UPSTREAM_BUSY';
      throw error;
    }

    const id = this.nextPendingId++;
    const timer = setTimeout(() => this.releaseRequest(id), this.requestTimeoutMs);
    timer.unref();
    this.pendingRequests.set(id, {
      id,
      userId: normalizedUserId,
      createdAt: Date.now(),
      timer,
    });
    userPending.add(id);
    this.pendingByUser.set(normalizedUserId, userPending);
    this.state.patch('onebot', { inFlight: this.pendingRequests.size });
    return id;
  }

  releaseRequest(id) {
    const pending = this.pendingRequests.get(id);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pendingRequests.delete(id);
    const userPending = this.pendingByUser.get(pending.userId);
    userPending?.delete(id);
    if (!userPending?.size) this.pendingByUser.delete(pending.userId);
    this.state.patch('onebot', { inFlight: this.pendingRequests.size });
    return true;
  }

  releaseOldestForUser(userId) {
    const ids = this.pendingByUser.get(String(userId));
    const id = ids?.values().next().value;
    return id === undefined ? false : this.releaseRequest(id);
  }

  clearPendingRequests() {
    for (const pending of this.pendingRequests.values()) clearTimeout(pending.timer);
    this.pendingRequests.clear();
    this.pendingByUser.clear();
    if (this.state.onebot.inFlight !== 0) this.state.patch('onebot', { inFlight: 0 });
  }

  async handleAction(rawData) {
    let request;
    try {
      request = JSON.parse(rawData.toString());
    } catch {
      return;
    }
    if (!request?.action) return;

    const { action, params = {}, echo } = request;
    let response;
    try {
      switch (action) {
        case 'send_private_msg': {
          this.releaseOldestForUser(params.user_id);
          if (this.isSleeping()) {
            response = failed('机器人处于定时休眠时段', echo, 1403);
            break;
          }
          const text = extractPlainText(params.message);
          if (!text) {
            response = failed('首期仅支持私聊文本消息', echo, 1404);
            break;
          }
          const result = await this.wechat.sendText(params.user_id, text);
          response = ok({
            message_id: Number(result?.MsgID || result?.MsgId || Date.now() % 2_000_000_000),
          }, echo);
          break;
        }
        case 'send_group_msg': {
          this.releaseOldestForUser(`group:${params.group_id}`);
          if (this.isSleeping()) {
            response = failed('机器人处于定时休眠时段', echo, 1403);
            break;
          }
          const text = extractPlainText(params.message);
          if (!text) {
            response = failed('群聊当前仅支持文本回复', echo, 1404);
            break;
          }
          const result = await this.wechat.sendGroupText(params.group_id, text);
          response = ok({
            message_id: Number(result?.MsgID || result?.MsgId || Date.now() % 2_000_000_000),
          }, echo);
          break;
        }
        case 'send_msg': {
          const messageType = params.message_type
            || (params.group_id ? 'group' : 'private');
          if (messageType === 'group') {
            this.releaseOldestForUser(`group:${params.group_id}`);
            const text = extractPlainText(params.message);
            if (!text) {
              response = failed('群聊当前仅支持文本回复', echo, 1404);
              break;
            }
            const result = await this.wechat.sendGroupText(params.group_id, text);
            response = ok({
              message_id: Number(result?.MsgID || result?.MsgId || Date.now() % 2_000_000_000),
            }, echo);
          } else {
            this.releaseOldestForUser(params.user_id);
            const text = extractPlainText(params.message);
            if (!text) {
              response = failed('当前仅支持文本消息', echo, 1404);
              break;
            }
            const result = await this.wechat.sendText(params.user_id, text);
            response = ok({
              message_id: Number(result?.MsgID || result?.MsgId || Date.now() % 2_000_000_000),
            }, echo);
          }
          break;
        }
        case 'get_login_info':
          response = ok({
            user_id: this.wechat.selfId,
            nickname: this.state.wechat.account || 'WeChat',
          }, echo);
          break;
        case 'get_status':
          response = ok({
            online: this.wechat.loggedIn,
            good: this.wechat.loggedIn && !this.isSleeping(),
          }, echo);
          break;
        case 'get_version_info':
          response = ok({
            app_name: 'feagle-wechat-onebot',
            app_version: '0.3.0',
            protocol_version: 'v11',
          }, echo);
          break;
        case 'get_stranger_info': {
          const contact = this.idMap.contact(params.user_id);
          response = contact
            ? ok({
              user_id: Number(contact.onebot_id),
              nickname: contact.nickname || '微信用户',
              sex: 'unknown',
              age: 0,
            }, echo)
            : failed('未找到用户', echo, 1404);
          break;
        }
        case 'get_friend_list':
          response = ok(this.idMap.contacts('user').map((contact) => ({
            user_id: Number(contact.onebot_id),
            nickname: contact.nickname || '微信用户',
            remark: '',
          })), echo);
          break;
        case 'get_group_list':
          response = ok(this.idMap.contacts('group').map((group) => ({
            group_id: Number(group.onebot_id),
            group_name: group.nickname || '微信群',
            member_count: 0,
            max_member_count: 0,
          })), echo);
          break;
        case 'get_group_info': {
          const group = this.idMap.contact(params.group_id);
          response = group
            ? ok({
              group_id: Number(group.onebot_id),
              group_name: group.nickname || '微信群',
              member_count: 0,
              max_member_count: 0,
            }, echo)
            : failed('未找到群聊', echo, 1404);
          break;
        }
        case 'get_group_member_info': {
          const member = this.idMap.contact(params.user_id);
          response = member
            ? ok({
              group_id: Number(params.group_id),
              user_id: Number(member.onebot_id),
              nickname: member.nickname || '群成员',
              card: member.nickname || '群成员',
              sex: 'unknown',
              age: 0,
              area: '',
              join_time: 0,
              last_sent_time: 0,
              level: '',
              role: 'member',
              unfriendly: false,
              title: '',
              title_expire_time: 0,
              card_changeable: false,
            }, echo)
            : failed('未找到群成员', echo, 1404);
          break;
        }
        case 'get_msg': {
          const event = this.idMap.message(params.message_id);
          response = event
            ? ok(event, echo)
            : failed('未找到消息', echo, 1404);
          break;
        }
        default:
          response = failed(`首期暂不支持 OneBot action: ${action}`, echo, 1404);
      }
    } catch (error) {
      this.state.addError(`onebot-action:${action}`, error);
      response = failed(error.message || String(error), echo);
    }

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(response));
    }
  }

  stop() {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopHeartbeat();
    this.clearPendingRequests();
    this.rejectConnectionWaiters();
    this.ws?.close();
  }
}
