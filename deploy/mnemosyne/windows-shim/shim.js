import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Mnemosyne Lightweight Shim for Windows / Pure Local Single-Machine Mode
 * 监听 18010 端口，使用 Node 22 内置的 node:sqlite 提供轻量记忆存储，
 * 100% 模拟官方 Mnemosyne REST API，彻底告别 Docker & PostgreSQL。
 */

function ensureDbDirectory(dbPath) {
  const dir = dirname(resolve(dbPath));
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function initDatabase(dbPath = './data/memory.sqlite') {
  ensureDbDirectory(dbPath);
  const db = new DatabaseSync(resolve(dbPath));

  // 初始化基础表结构
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT 'default',
      content TEXT NOT NULL,
      category TEXT DEFAULT 'general',
      source TEXT,
      owner TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS beliefs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT 'default',
      content TEXT NOT NULL,
      category TEXT DEFAULT 'general',
      owner TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT 'default',
      title TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT,
      content TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  return db;
}

function parseJsonBody(req) {
  return new Promise((resolveBody, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (!body.trim()) return resolveBody({});
      try {
        resolveBody(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export function createMnemosyneShimServer({ dbPath = './data/memory.sqlite', port = 18010, host = '127.0.0.1' } = {}) {
  const db = initDatabase(dbPath);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname;

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // 1. GET /api/v1/memories/stats
      if (req.method === 'GET' && pathname === '/api/v1/memories/stats') {
        const userId = url.searchParams.get('user_id') || 'default';
        const countRow = db.prepare('SELECT COUNT(*) as count FROM memories WHERE user_id = ?').get(userId);
        const categories = {};
        const catRows = db.prepare('SELECT category, COUNT(*) as count FROM memories WHERE user_id = ? GROUP BY category').all(userId);
        for (const r of catRows) {
          categories[r.category || 'general'] = r.count;
        }

        res.writeHead(200);
        res.end(JSON.stringify({
          status: 'ok',
          total: countRow ? countRow.count : 0,
          categories,
          backend: 'sqlite-shim',
        }));
        return;
      }

      // 2. GET /api/v1/memories/tree
      if (req.method === 'GET' && pathname === '/api/v1/memories/tree') {
        const userId = url.searchParams.get('user_id') || 'default';
        const catRows = db.prepare('SELECT DISTINCT category FROM memories WHERE user_id = ?').all(userId);
        const nodes = catRows.map((r) => ({ id: r.category || 'general', label: r.category || '通用记忆' }));
        res.writeHead(200);
        res.end(JSON.stringify({
          nodes: nodes.length ? nodes : [{ id: 'general', label: '通用记忆' }],
          edges: [],
        }));
        return;
      }

      // 3. POST /api/v1/memories/search (语义/关键词检索) 或 GET /api/v1/memories/search
      if ((req.method === 'POST' || req.method === 'GET') && pathname === '/api/v1/memories/search') {
        const body = req.method === 'POST' ? await parseJsonBody(req) : {};
        const userId = body.user_id || url.searchParams.get('user_id') || 'default';
        const query = String(body.query || url.searchParams.get('q') || url.searchParams.get('query') || '').trim();
        const limit = Math.min(Number(body.limit || url.searchParams.get('limit')) || 10, 100);
        const category = body.category || url.searchParams.get('category');
        const owner = body.owner || url.searchParams.get('owner');

        let sql = 'SELECT * FROM memories WHERE user_id = ?';
        const params = [userId];

        if (query) {
          sql += ' AND content LIKE ?';
          params.push(`%${query}%`);
        }
        if (category) {
          sql += ' AND category = ?';
          params.push(category);
        }
        if (owner) {
          sql += ' AND owner = ?';
          params.push(owner);
        }

        sql += ' ORDER BY created_at DESC LIMIT ?';
        params.push(limit);

        const rows = db.prepare(sql).all(...params);
        res.writeHead(200);
        res.end(JSON.stringify({
          results: rows,
          memories: rows,
          total: rows.length,
          mode: 'keyword-shim',
        }));
        return;
      }

      // 4. GET /api/v1/memories (条件列表与过滤)
      if (req.method === 'GET' && pathname === '/api/v1/memories') {
        const userId = url.searchParams.get('user_id') || 'default';
        const search = url.searchParams.get('search');
        const source = url.searchParams.get('source');
        const owner = url.searchParams.get('owner');
        const category = url.searchParams.get('category');
        const limit = Math.min(Number(url.searchParams.get('limit')) || 20, 100);

        let sql = 'SELECT * FROM memories WHERE user_id = ?';
        const params = [userId];

        if (search) {
          sql += ' AND content LIKE ?';
          params.push(`%${search}%`);
        }
        if (source) {
          sql += ' AND source = ?';
          params.push(source);
        }
        if (owner) {
          sql += ' AND owner = ?';
          params.push(owner);
        }
        if (category) {
          sql += ' AND category = ?';
          params.push(category);
        }

        sql += ' ORDER BY created_at DESC LIMIT ?';
        params.push(limit);

        const rows = db.prepare(sql).all(...params);
        const countRow = db.prepare('SELECT COUNT(*) as total FROM memories WHERE user_id = ?').get(userId);

        res.writeHead(200);
        res.end(JSON.stringify({
          memories: rows,
          total: countRow ? countRow.total : rows.length,
        }));
        return;
      }

      // 5. POST /api/v1/memories (新增记忆)
      if (req.method === 'POST' && pathname === '/api/v1/memories') {
        const body = await parseJsonBody(req);
        const id = body.id || 'mem_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const userId = body.user_id || 'default';
        const content = String(body.content || '').trim();
        const category = body.category || 'general';
        const source = body.source || null;
        const owner = body.owner || null;

        if (!content) {
          res.writeHead(400);
          res.end(JSON.stringify({ detail: 'content is required' }));
          return;
        }

        db.prepare(`
          INSERT INTO memories (id, user_id, content, category, source, owner)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(id, userId, content, category, source, owner);

        res.writeHead(201);
        res.end(JSON.stringify({ id, status: 'created' }));
        return;
      }

      // 6. GET /api/v1/sessions (会话列表)
      if (req.method === 'GET' && pathname === '/api/v1/sessions') {
        const limit = Math.min(Number(url.searchParams.get('limit')) || 20, 100);
        const rows = db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?').all(limit);
        res.writeHead(200);
        res.end(JSON.stringify({ sessions: rows, total: rows.length }));
        return;
      }

      // 7. GET /api/v1/sessions/:id/messages
      const sessionMatch = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/messages$/);
      if (req.method === 'GET' && sessionMatch) {
        const sessionId = decodeURIComponent(sessionMatch[1]);
        const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 500);
        const rows = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?').all(sessionId, limit);
        res.writeHead(200);
        res.end(JSON.stringify({ messages: rows, total: rows.length }));
        return;
      }

      // 8. POST /api/v1/beliefs/search (联系人画像检索)
      if (req.method === 'POST' && pathname === '/api/v1/beliefs/search') {
        const body = await parseJsonBody(req);
        const userId = body.user_id || 'default';
        const query = String(body.query || '').trim();
        const limit = Math.min(Number(body.limit) || 10, 50);

        let sql = 'SELECT * FROM beliefs WHERE user_id = ?';
        const params = [userId];

        if (query) {
          sql += ' AND (content LIKE ? OR owner LIKE ?)';
          params.push(`%${query}%`, `%${query}%`);
        }

        sql += ' ORDER BY created_at DESC LIMIT ?';
        params.push(limit);

        const rows = db.prepare(sql).all(...params);
        res.writeHead(200);
        res.end(JSON.stringify({
          beliefs: rows,
          results: rows,
          total: rows.length,
        }));
        return;
      }

      // 404 Fallback
      res.writeHead(404);
      res.end(JSON.stringify({ detail: `Route ${pathname} not found in Shim` }));
    } catch (err) {
      console.error('[MnemosyneShim] Error:', err);
      res.writeHead(500);
      res.end(JSON.stringify({ detail: err.message || 'Internal Shim Error' }));
    }
  });

  return {
    server,
    db,
    listen: () => new Promise((resolveListen, reject) => {
      server.listen(port, host, () => {
        console.log(`[MnemosyneShim] SQLite Memory Shim listening at http://${host}:${port} (db: ${dbPath})`);
        resolveListen(server);
      });
      server.on('error', reject);
    }),
    close: () => new Promise((resolveClose) => {
      server.close(() => {
        try { db.close(); } catch {}
        resolveClose();
      });
    }),
  };
}

// 允许独立启动测试: node src/mnemosyne-shim.js
if (process.argv[1] && (process.argv[1].endsWith('mnemosyne-shim.js') || process.argv[1].endsWith('mnemosyne-shim'))) {
  const port = Number(process.env.MNEMOSYNE_PORT || 18010);
  const dbPath = process.env.MNEMOSYNE_SQLITE_PATH || './data/memory.sqlite';
  const shim = createMnemosyneShimServer({ port, dbPath });
  await shim.listen();
}
