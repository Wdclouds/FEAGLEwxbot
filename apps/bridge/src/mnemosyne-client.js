/**
 * MnemosyneClient — Dashboard → Mnemosyne 记忆服务（127.0.0.1:18010）的轻量代理。
 * 同机 HTTP 直连，无鉴权。所有方法失败时抛出带 message 的 Error。
 */
const DEFAULT_BASE = process.env.MNEMOSYNE_BASE_URL || 'http://127.0.0.1:18010';
const DEFAULT_USER = process.env.MNEMOSYNE_USER_ID || 'default';
const TIMEOUT_MS = 15_000;

async function request(base, method, path, body, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(base + path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!response.ok) {
      const detail = data?.detail
        ? (Array.isArray(data.detail) ? data.detail.map((d) => d.msg).join('; ') : data.detail)
        : String(data || response.statusText);
      const error = new Error(`Mnemosyne ${method} ${path}: ${detail}`);
      error.code = 'MNEMOSYNE_ERROR';
      throw error;
    }
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Mnemosyne ${path} 超时 (${timeoutMs}ms)`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export class MnemosyneClient {
  constructor({ base = DEFAULT_BASE, userId = DEFAULT_USER } = {}) {
    this.base = base;
    this.userId = userId;
  }

  async stats(userId = this.userId) {
    return request(this.base, 'GET', '/api/v1/memories/stats?user_id=' + encodeURIComponent(userId));
  }

  async tree(userId = this.userId) {
    return request(this.base, 'GET', '/api/v1/memories/tree?user_id=' + encodeURIComponent(userId));
  }

  async search(query, { userId = this.userId, limit = 10, category, source = null, owner = null } = {}) {
    if (source) {
      // 按聊天检索：list 接口原生支持 search(ILIKE) + source + owner 过滤
      let path = '/api/v1/memories?user_id=' + encodeURIComponent(userId)
        + '&limit=' + limit + '&search=' + encodeURIComponent(query)
        + '&source=' + encodeURIComponent(source);
      if (owner) path += '&owner=' + encodeURIComponent(owner);
      if (category) path += '&category=' + encodeURIComponent(category);
      const data = await request(this.base, 'GET', path);
      return { results: data?.memories || [], total: data?.total || 0, mode: 'keyword' };
    }
    const data = await request(this.base, 'POST', '/api/v1/memories/search', {
      user_id: userId,
      query,
      limit,
      ...(category ? { category } : {}),
      ...(owner ? { owner } : {}),
    }, 30_000);
    const memories = data?.results || data?.memories || [];
    return { results: memories.slice(0, limit), total: memories.length, mode: 'semantic' };
  }

  async recent({ userId = this.userId, limit = 20, source = null, owner = null } = {}) {
    // mnemosyne list 接口原生支持 source/owner/visibility 过滤（metadata->>）
    let path = '/api/v1/memories?user_id=' + encodeURIComponent(userId) + '&limit=' + limit;
    if (source) path += '&source=' + encodeURIComponent(source);
    if (owner) path += '&owner=' + encodeURIComponent(owner);
    const data = await request(this.base, 'GET', path);
    return { memories: data?.memories || [], total: data?.total || 0 };
  }

  async sessions(limit = 20) {
    return request(this.base, 'GET', '/api/v1/sessions?limit=' + limit);
  }

  async sessionMessages(sessionId, limit = 200) {
    return request(this.base, 'GET', '/api/v1/sessions/' + encodeURIComponent(sessionId) + '/messages?limit=' + limit);
  }

  /** 画像：围绕某人的信念 + 记忆检索。q 为人名/ID 关键词。 */
  async persona(q, { userId = this.userId, limit = 10 } = {}) {
    const [beliefs, memories] = await Promise.allSettled([
      request(this.base, 'POST', '/api/v1/beliefs/search', { user_id: userId, query: q, limit }, 20_000),
      request(this.base, 'POST', '/api/v1/memories/search', { user_id: userId, query: q, limit }, 20_000),
    ]);
    return {
      beliefs: beliefs.status === 'fulfilled' ? (beliefs.value?.beliefs || beliefs.value?.results || []) : [],
      memories: memories.status === 'fulfilled' ? (memories.value?.results || memories.value?.memories || []) : [],
      errors: [
        beliefs.status === 'rejected' ? beliefs.reason?.message : null,
        memories.status === 'rejected' ? memories.reason?.message : null,
      ].filter(Boolean),
    };
  }
}
