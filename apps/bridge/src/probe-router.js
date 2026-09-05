/**
 * ProbeRouter: 探针旁路变轨路由
 * 支持在本地开发/测试时将微信消息旁路拦截到探针队列，
 * 由外部测试探针（如本机 Hermes / 大模型）直接识别、调试并回发，避免污染主干上下文。
 *
 * 变轨 = 把某会话（或全部）的微信入站消息「从去 Hermes 的主干道上切下来」，
 * 排进内部事件队列，供探针经 HTTP API 拉取；探针处理后经 reply 把结果打回微信。
 * 带过期自动回轨（安全网），不影响主干任何逻辑。
 */
export class ProbeRouter {
  constructor({
    idMap,
    state,
    wechat,
    wechatSendGroup = null,
    wechatSendPrivate = null,
  } = {}) {
    this.idMap = idMap;
    this.state = state;
    this.wechat = wechat;
    this.wechatSendGroup = wechatSendGroup; // (onebotGroupId, text) => Promise
    this.wechatSendPrivate = wechatSendPrivate; // (onebotUserId, text) => Promise
    this.active = false;
    this.target = 'all'; // 'all' | 'group:<oid>' | 'private:<oid>'
    this.expiresAt = 0;
    this.timer = null;
    this.events = [];
    this.seq = 0;
    this.maxEvents = 100;
    this.waiters = [];
  }

  setWechat(wechat) {
    this.wechat = wechat;
  }

  /** 开启或关闭变轨（enabled=true 带 TTL 自动回轨） */
  setRoute({ enabled, target = 'all', timeoutMs = 300000 } = {}) {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.active = Boolean(enabled);
    this.target = String(target || 'all').trim();
    if (this.active) {
      const ttl = Math.min(Math.max(Number(timeoutMs) || 300000, 10000), 3600000);
      this.expiresAt = Date.now() + ttl;
      this.timer = setTimeout(() => {
        this.active = false;
        this.notifyWaiters();
        console.log('[probe] auto route off (expired)');
      }, ttl);
      this.timer.unref?.();
      console.log(`[probe] route ON target=${this.target} ttl=${ttl}ms`);
    } else {
      this.expiresAt = 0;
      console.log('[probe] route OFF');
    }
    this.notifyWaiters();
    return this.getStatus();
  }

  /** 当前变轨状态 */
  getStatus() {
    return {
      enabled: this.active && Date.now() < this.expiresAt,
      target: this.target,
      expiresAt: this.expiresAt ? new Date(this.expiresAt).toISOString() : null,
      remainingMs: Math.max(0, this.expiresAt - Date.now()),
      queued: this.events.length,
      lastSeq: this.seq,
    };
  }

  status() {
    return this.getStatus();
  }

  /** 判断某个会话是否命中旁路 */
  shouldBypass(convKey) {
    if (!this.active || Date.now() >= this.expiresAt) return false;
    if (this.target === 'all') return true;
    return this.target === String(convKey);
  }

  /** kind='group' 消息带 groupId；kind='private' 带 userId（均为 OneBot oid） */
  convKeyFor(kind, message) {
    if (kind === 'group') return message?.groupId ? `group:${message.groupId}` : '';
    if (kind === 'private') return message?.userId ? `private:${message.userId}` : '';
    return '';
  }

  /**
   * 入站拦截入口（index.js 的 on* 回调调用）。
   * 命中旁路 → 排队 + 通知等待者 + 返回 true（消息已截停，不再走主干）；
   * 未命中 → 返回 false（消息照常转发 Hermes）。
   */
  handleInbound(kind, message) {
    const convKey = this.convKeyFor(kind, message);
    if (!convKey || !this.shouldBypass(convKey)) return false;
    this.intercept(kind, convKey, message);
    return true;
  }

  /** 接收拦截的微信消息 */
  intercept(kind, convKey, item) {
    const seq = ++this.seq;
    const enriched = {
      ...item,
      kind,
      convKey,
      seq,
      receivedAt: new Date().toISOString(),
    };
    // 图片 body 体积保护：超大图剥离为元数据，探针需要时按 eventId 再取
    if (
      typeof enriched.imageBase64 === 'string'
      && enriched.imageBase64.length > 2 * 1024 * 1024
    ) {
      enriched.imageBase64Length = enriched.imageBase64.length;
      enriched.imageBase64 = '';
    }
    this.events.push(enriched);
    if (this.events.length > this.maxEvents) {
      this.events.shift();
    }
    console.log(`[probe] intercept ${kind} seq=${seq} text=${String(item?.text || item?.content || '(image)').slice(0, 40)}`);
    this.notifyWaiters();
  }

  /** 增量拉取：seq > since 的事件（默认最多 limit 条） */
  pullEvents(since = 0, limit = 10) {
    const count = Math.max(1, Math.min(Number(limit) || 10, 100));
    return this.events
      .filter((e) => e.seq > Number(since) || 0)
      .slice(-count);
  }

  /** 长轮询：等待 seq > since 的新事件；超时返回当前增量（可能为空） */
  async waitForEvents(since = 0, timeoutMs = 15000) {
    if (this.events.some((e) => e.seq > Number(since) || 0)) {
      return this.pullEvents(since, 100);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i !== -1) this.waiters.splice(i, 1);
        resolve(this.pullEvents(since, 100));
      }, Math.min(Number(timeoutMs) || 15000, 30000));
      const waiter = () => {
        clearTimeout(timer);
        const i = this.waiters.indexOf(waiter);
        if (i !== -1) this.waiters.splice(i, 1);
        resolve(this.pullEvents(since, 100));
      };
      this.waiters.push(waiter);
    });
  }

  /** 兼容旧版 poll/waitForNext（清空式拉取） */
  poll() {
    const msgs = [...this.events];
    this.events = [];
    return { status: this.getStatus(), messages: msgs };
  }

  async waitForNext(timeoutMs = 15000) {
    const base = this.seq;
    if (this.events.length > 0) return this.poll();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i !== -1) this.waiters.splice(i, 1);
        resolve(this.poll());
      }, Math.min(Number(timeoutMs) || 15000, 30000));
      const waiter = () => {
        clearTimeout(timer);
        const i = this.waiters.indexOf(waiter);
        if (i !== -1) this.waiters.splice(i, 1);
        resolve(this.poll());
      };
      this.waiters.push(waiter);
    });
  }

  notifyWaiters() {
    const ws = [...this.waiters];
    this.waiters = [];
    for (const w of ws) {
      try {
        w();
      } catch {
        /* waiter 自身异常不影响其他等待者 */
      }
    }
  }

  /** 探针直接回发文字到指定会话：convKey = 'group:<oid>' | 'private:<oid>' */
  async sendReply(convKey, text) {
    const content = String(text || '').trim();
    if (!content) throw new Error('Text cannot be empty');
    const m = /^(group|private):(\d+)$/.exec(String(convKey || '').trim());
    if (!m) throw new Error(`Invalid convKey: ${convKey} (expected group:<oid> or private:<oid>)`);
    const [, type, id] = m;
    if (type === 'group') {
      if (this.wechatSendGroup) return await this.wechatSendGroup(id, content);
      if (this.wechat?.sendGroupText) return await this.wechat.sendGroupText(id, content);
    } else {
      if (this.wechatSendPrivate) return await this.wechatSendPrivate(id, content);
      if (this.wechat?.sendText) return await this.wechat.sendText(id, content);
    }
    throw new Error('Wechat client not available');
  }

  /** 兼容对象参数调用形式 */
  async reply(args) {
    if (args && typeof args === 'object' && !args.convKey && arguments.length === 1) {
      throw new Error('reply requires convKey');
    }
    if (args && typeof args === 'object' && args.convKey) {
      return this.sendReply(args.convKey, args.text);
    }
    return this.sendReply(args, arguments[1]);
  }
}
