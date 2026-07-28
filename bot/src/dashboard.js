import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};
const WECHAT_ADMIN_MODES = new Set(['RUNNING', 'PAUSED', 'MANUAL_OFFLINE']);
const GROUP_CHAT_MODES = new Set(['OFF', 'OBSERVE', 'MENTION_ONLY']);

export class DashboardServer {
  constructor({
    state,
    host = '0.0.0.0',
    port = 6190,
    setTestMode = () => state.snapshot(),
    sendNotificationTest = async () => state.snapshot(),
    forceWechatRelogin = async () => state.snapshot(),
    setWechatAdminMode = async () => state.snapshot(),
    setGroupChatConfig = async () => state.snapshot(),
    publicRoot = '/app/src/public',
  }) {
    this.state = state;
    this.host = host;
    this.port = port;
    this.setTestMode = setTestMode;
    this.sendNotificationTest = sendNotificationTest;
    this.forceWechatRelogin = forceWechatRelogin;
    this.setWechatAdminMode = setWechatAdminMode;
    this.setGroupChatConfig = setGroupChatConfig;
    this.clients = new Set();
    this.publicRoot = publicRoot;
    this.server = createServer((request, response) => {
      this.handle(request, response);
    });
    this.state.on('snapshot', (snapshot) => this.push(snapshot));
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.server.off('error', reject);
        console.log(`[Dashboard] listening on http://${this.host}:${this.port}`);
        resolve();
      });
    });
  }

  handle(request, response) {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (url.pathname === '/api/health/live') {
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(JSON.stringify({
        status: 'ok',
        startedAt: this.state.startedAt,
        now: new Date().toISOString(),
      }));
      return;
    }

    if (url.pathname === '/api/health/ready') {
      const snapshot = this.state.snapshot();
      const ready = snapshot.wechat.status === 'ONLINE'
        && snapshot.wechat.protocolHealth === 'HEALTHY'
        && snapshot.astrbot.status === 'READY'
        && snapshot.onebot.status === 'CONNECTED';
      response.writeHead(ready ? 200 : 503, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(JSON.stringify({
        status: ready ? 'ready' : 'not_ready',
        wechat: {
          status: snapshot.wechat.status,
          protocolHealth: snapshot.wechat.protocolHealth,
          lastSyncAt: snapshot.wechat.lastSyncAt,
        },
        astrbot: snapshot.astrbot.status,
        onebot: snapshot.onebot.status,
      }));
      return;
    }

    if (url.pathname === '/api/test-mode') {
      if (request.method !== 'POST') {
        response.writeHead(405, {
          Allow: 'POST',
          'Content-Type': 'application/json; charset=utf-8',
        });
        response.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
      }
      if (!String(request.headers['content-type'] || '').startsWith('application/json')) {
        response.writeHead(415, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'Content-Type must be application/json' }));
        return;
      }

      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1024) request.destroy();
      });
      request.on('end', () => {
        try {
          const payload = JSON.parse(body);
          if (typeof payload.enabled !== 'boolean') {
            throw new TypeError('enabled must be a boolean');
          }
          const snapshot = this.setTestMode(payload.enabled);
          response.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          response.end(JSON.stringify(snapshot));
        } catch (error) {
          response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: error.message }));
        }
      });
      return;
    }

    if (url.pathname === '/api/notifications/test') {
      if (request.method !== 'POST') {
        response.writeHead(405, {
          Allow: 'POST',
          'Content-Type': 'application/json; charset=utf-8',
        });
        response.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
      }
      Promise.resolve(this.sendNotificationTest())
        .then((snapshot) => {
          response.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          response.end(JSON.stringify(snapshot));
        })
        .catch((error) => {
          response.writeHead(502, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          response.end(JSON.stringify({
            error: String(error?.message || error).slice(0, 200),
          }));
        });
      return;
    }

    if (url.pathname === '/api/wechat/admin-mode') {
      if (request.method !== 'POST') {
        response.writeHead(405, {
          Allow: 'POST',
          'Content-Type': 'application/json; charset=utf-8',
        });
        response.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
      }
      if (!String(request.headers['content-type'] || '').startsWith('application/json')) {
        response.writeHead(415, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'Content-Type must be application/json' }));
        return;
      }

      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1024) request.destroy();
      });
      request.on('end', () => {
        let payload;
        try {
          payload = JSON.parse(body);
        } catch {
          response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: 'Invalid JSON body' }));
          return;
        }
        if (!WECHAT_ADMIN_MODES.has(payload.mode)) {
          response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: 'Unsupported WeChat admin mode' }));
          return;
        }
        if (
          payload.mode === 'MANUAL_OFFLINE'
          && payload.confirm !== 'MANUAL_OFFLINE'
        ) {
          response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: 'Explicit confirmation is required' }));
          return;
        }
        Promise.resolve(this.setWechatAdminMode(payload.mode))
          .then((snapshot) => {
            response.writeHead(202, {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'no-store',
            });
            response.end(JSON.stringify(snapshot));
          })
          .catch((error) => {
            response.writeHead(409, {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'no-store',
            });
            response.end(JSON.stringify({
              error: String(error?.message || error).slice(0, 200),
            }));
          });
      });
      return;
    }

    if (url.pathname === '/api/wechat/force-relogin') {
      if (request.method !== 'POST') {
        response.writeHead(405, {
          Allow: 'POST',
          'Content-Type': 'application/json; charset=utf-8',
        });
        response.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
      }
      if (!String(request.headers['content-type'] || '').startsWith('application/json')) {
        response.writeHead(415, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'Content-Type must be application/json' }));
        return;
      }

      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1024) request.destroy();
      });
      request.on('end', () => {
        let payload;
        try {
          payload = JSON.parse(body);
        } catch {
          response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: 'Invalid JSON body' }));
          return;
        }
        if (payload.confirm !== 'FORCE_LOGOUT') {
          response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: 'Explicit confirmation is required' }));
          return;
        }
        Promise.resolve(this.forceWechatRelogin())
          .then((snapshot) => {
            response.writeHead(202, {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'no-store',
            });
            response.end(JSON.stringify(snapshot));
          })
          .catch((error) => {
            const conflict = [
              'WECHAT_RELOGIN_IN_PROGRESS',
              'WECHAT_NOT_HEALTHY',
              'WECHAT_ADMIN_MODE_CONFLICT',
            ].includes(error?.code);
            response.writeHead(conflict ? 409 : 502, {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'no-store',
            });
            response.end(JSON.stringify({
              error: String(error?.message || error).slice(0, 200),
            }));
          });
      });
      return;
    }

    if (url.pathname === '/api/group-chat/config') {
      if (request.method !== 'POST') {
        response.writeHead(405, {
          Allow: 'POST',
          'Content-Type': 'application/json; charset=utf-8',
        });
        response.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
      }
      if (!String(request.headers['content-type'] || '').startsWith('application/json')) {
        response.writeHead(415, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'Content-Type must be application/json' }));
        return;
      }
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => {
        body += chunk;
        if (body.length > 8_192) request.destroy();
      });
      request.on('end', () => {
        let payload;
        try {
          payload = JSON.parse(body);
        } catch {
          response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: 'Invalid JSON body' }));
          return;
        }
        if (!GROUP_CHAT_MODES.has(payload.mode)) {
          response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: 'Unsupported group chat mode' }));
          return;
        }
        if (!Array.isArray(payload.allowlist)) {
          response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: 'allowlist must be an array' }));
          return;
        }
        const allowlist = Array.from(new Set(payload.allowlist
          .map((item) => String(item || '').trim())
          .filter((item) => /^\d+$/.test(item))));
        if (payload.blockedTerms !== undefined && !Array.isArray(payload.blockedTerms)) {
          response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: 'blockedTerms must be an array' }));
          return;
        }
        const blockedTerms = Array.from(new Set((payload.blockedTerms || [])
          .map((item) => String(item || '').trim().toLocaleLowerCase())
          .filter(Boolean)
          .map((item) => item.slice(0, 64))))
          .slice(0, 100);
        if (
          payload.mode === 'MENTION_ONLY'
          && payload.confirm !== 'ENABLE_GROUP_REPLY'
        ) {
          response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: 'Explicit confirmation is required' }));
          return;
        }
        Promise.resolve(this.setGroupChatConfig(payload.mode, allowlist, blockedTerms))
          .then((snapshot) => {
            response.writeHead(200, {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'no-store',
            });
            response.end(JSON.stringify(snapshot));
          })
          .catch((error) => {
            response.writeHead(409, {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'no-store',
            });
            response.end(JSON.stringify({
              error: String(error?.message || error).slice(0, 200),
            }));
          });
      });
      return;
    }

    if (url.pathname === '/api/status') {
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(JSON.stringify(this.state.snapshot()));
      return;
    }

    if (url.pathname === '/events') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      response.write(`data: ${JSON.stringify(this.state.snapshot())}\n\n`);
      this.clients.add(response);
      request.on('close', () => this.clients.delete(response));
      return;
    }

    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    const relative = normalize(requested).replace(/^([/\\])+/, '');
    const path = join(this.publicRoot, relative);
    if (!path.startsWith(this.publicRoot) || !existsSync(path)) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': CONTENT_TYPES[extname(path)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    createReadStream(path).pipe(response);
  }

  push(snapshot) {
    const payload = `data: ${JSON.stringify(snapshot)}\n\n`;
    for (const client of this.clients) client.write(payload);
  }

  stop() {
    for (const client of this.clients) client.end();
    this.clients.clear();
    this.server.close();
  }
}
