/**
 * ENCYCLOPAEDIA NEXUS — Backend Server
 * Node.js + Express + MariaDB
 * v2.0 — с фиксами багов и IP-based dev mode
 */

'use strict';

const express    = require('express');
const mysql      = require('mysql2/promise');
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const crypto     = require('crypto');
const bcrypt     = require('bcryptjs');

// ─── CONFIG ────────────────────────────────────────────────────────────────
const CONFIG = {
  port: process.env.PORT || 8080,
  // ★ Дев IP — только с этого адреса разрешены admin-роуты
  devIPs: (process.env.DEV_IPS || '5.34.113.82').split(',').map(s => s.trim()),
  db: {
    host:            process.env.MYSQLPRIVATEHOST || process.env.MYSQLHOST || '127.0.0.1',
    port:            parseInt(process.env.MYSQLPORT || '3306'),
    user:            process.env.MYSQLUSER     || 'root',
    password:        process.env.MYSQLPASSWORD || '',
    database:        process.env.MYSQLDATABASE || 'railway',
    connectionLimit: 5,
    connectTimeout:  60000,
  },
  upload: {
    dir:      path.resolve('./uploads'),
    maxSizeMB: 10,
    allowed:  ['image/jpeg','image/png','image/webp','image/gif','image/avif'],
  },
  chunk: {
    maxPerArticle: 500,
    pageSize: 20,
  },
  search: {
    minLength: 2,
    maxResults: 50,
  }
};

// ─── DB POOL ───────────────────────────────────────────────────────────────
const pool = mysql.createPool(CONFIG.db);

async function query(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

// ─── UPLOAD SETUP ──────────────────────────────────────────────────────────
if (!fs.existsSync(CONFIG.upload.dir)) fs.mkdirSync(CONFIG.upload.dir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, CONFIG.upload.dir),
  filename:    (_, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    const name = crypto.randomBytes(12).toString('hex') + ext;
    cb(null, name);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: CONFIG.upload.maxSizeMB * 1024 * 1024 },
  fileFilter: (_, file, cb) =>
    CONFIG.upload.allowed.includes(file.mimetype)
      ? cb(null, true)
      : cb(new Error('Unsupported file type'))
});

// ─── APP ───────────────────────────────────────────────────────────────────
const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/uploads', express.static(CONFIG.upload.dir));

// Rate limiting
const limiter = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false });
app.use('/api', limiter);

// ─── HELPERS ───────────────────────────────────────────────────────────────

/**
 * Получить реальный IP клиента.
 * На Railway запросы идут через прокси, поэтому берём x-forwarded-for.
 */
function getClientIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    // x-forwarded-for может содержать цепочку: "client, proxy1, proxy2"
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * Проверить, является ли IP дев-адресом.
 */
function isDevIP(req) {
  const ip = getClientIP(req);
  return CONFIG.devIPs.includes(ip);
}

/**
 * Middleware: разрешить только дев IP.
 * Если не дев — 403.
 */
function requireDev(req, res, next) {
  if (!isDevIP(req)) {
    return res.status(403).json({ error: 'Forbidden: dev only' });
  }
  next();
}

function slugify(str) {
  return str.toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 200);
}

function paginate(page = 1, limit = 20) {
  const p = Math.max(1, parseInt(page));
  const l = Math.min(100, Math.max(1, parseInt(limit)));
  return { limit: l, offset: (p - 1) * l, page: p };
}

function err(res, status, msg) {
  return res.status(status).json({ error: msg });
}

// ─── DEV CHECK ENDPOINT ────────────────────────────────────────────────────
// Фронт вызывает этот роут чтобы узнать, является ли текущий IP дев-адресом.
// Никаких внешних ipify не нужно — сервер сам знает IP клиента.
app.get('/api/dev/check', (req, res) => {
  const ip = getClientIP(req);
  res.json({ isDev: isDevIP(req), ip });
});

// ─── ARTICLES ──────────────────────────────────────────────────────────────

// GET /api/articles — list with pagination, filter by tag, sort
app.get('/api/articles', async (req, res) => {
  try {
    const { page, limit, offset } = paginate(req.query.page, req.query.limit);
    const { tag, sort = 'created_at', status = 'published' } = req.query;

    const allowedSorts = { created_at: 'a.created_at', views: 'a.views', title: 'a.title' };
    const orderCol = allowedSorts[sort] || 'a.created_at';

    let sql = `
      SELECT a.id, a.slug, a.title, a.summary, a.cover_url, a.author,
             a.views, a.created_at,
             GROUP_CONCAT(t.name ORDER BY t.name SEPARATOR ',') AS tags,
             GROUP_CONCAT(t.color ORDER BY t.name SEPARATOR ',') AS tag_colors
      FROM articles a
      LEFT JOIN article_tags at2 ON at2.article_id = a.id
      LEFT JOIN tags t ON t.id = at2.tag_id
      WHERE a.status = ?
    `;
    const params = [status];

    if (tag) {
      sql += ` AND EXISTS (
        SELECT 1 FROM article_tags at3
        JOIN tags t2 ON t2.id = at3.tag_id
        WHERE at3.article_id = a.id AND t2.name = ?
      )`;
      params.push(tag);
    }

    sql += ` GROUP BY a.id, a.slug, a.title, a.summary, a.cover_url, a.author, a.views, a.created_at ORDER BY ${orderCol} DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = await query(sql, params);

    const countRows = await query(`SELECT COUNT(*) AS total FROM articles WHERE status = ?`, [status]);
    const total = countRows[0].total;

    res.json({ page, limit, total: Number(total), articles: rows });
  } catch (e) {
    console.error(e);
    err(res, 500, 'DB error');
  }
});

// GET /api/articles/:slug — single article meta (no chunks)
app.get('/api/articles/:slug', async (req, res) => {
  try {
    const [article] = await query(
      `SELECT a.id, a.slug, a.title, a.summary, a.cover_url, a.author,
              a.status, a.views, a.created_at, a.updated_at,
              GROUP_CONCAT(t.name ORDER BY t.name SEPARATOR ',') AS tags,
              GROUP_CONCAT(t.color ORDER BY t.name SEPARATOR ',') AS tag_colors
       FROM articles a
       LEFT JOIN article_tags at2 ON at2.article_id = a.id
       LEFT JOIN tags t ON t.id = at2.tag_id
       WHERE a.slug = ?
       GROUP BY a.id, a.slug, a.title, a.summary, a.cover_url, a.author,
                a.status, a.views, a.created_at, a.updated_at`,
      [req.params.slug]
    );
    if (!article) return err(res, 404, 'Not found');

    // Инкремент просмотров — уникально по IP раз в час
    const ip = getClientIP(req);
    (async () => {
      try {
        const recent = await query(
          'SELECT id FROM article_views WHERE article_id=? AND ip=? AND viewed_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)',
          [article.id, ip]
        );
        if (!recent.length) {
          await pool.query('INSERT INTO article_views (article_id, ip) VALUES (?,?)', [article.id, ip]);
          await pool.query('UPDATE articles SET views = views + 1 WHERE id = ?', [article.id]);
        }
      } catch (e) {
        console.error('Views tracking error:', e.message);
      }
    })();

    res.json(article);
  } catch (e) {
    console.error(e);
    err(res, 500, 'DB error');
  }
});

// POST /api/articles — create article
app.post('/api/articles', async (req, res) => {
  try {
    const { title, summary, author, cover_url, tags = [], chunks = [] } = req.body;
    if (!title?.trim()) return err(res, 400, 'Title required');

    // ★ FIX: правильная проверка уникальности slug — точное совпадение, не LIKE
    let slug = slugify(title);
    const exactMatch = await query('SELECT id FROM articles WHERE slug = ?', [slug]);
    if (exactMatch.length) {
      // Добавляем случайный суффикс только если slug реально занят
      slug += '-' + crypto.randomBytes(3).toString('hex');
    }

    const insertResult = await pool.query(
      `INSERT INTO articles (slug, title, summary, author, cover_url, status)
       VALUES (?, ?, ?, ?, ?, 'published')`,
      [slug, title.trim(), summary || null, author || 'Anonymous', cover_url || null]
    );
    const articleId = Number(insertResult[0].insertId);

    // insert tags
    if (tags.length) {
      for (const tagName of tags.slice(0, 20)) {
        const name = String(tagName).slice(0, 80).trim();
        if (!name) continue;
        let [tag] = await query('SELECT id FROM tags WHERE name = ?', [name]);
        if (!tag) {
          const [tagRes] = await pool.query('INSERT INTO tags (name) VALUES (?)', [name]);
          tag = { id: Number(tagRes.insertId) };
        }
        await query('INSERT IGNORE INTO article_tags VALUES (?, ?)', [articleId, tag.id]);
      }
    }

    // insert chunks
    if (chunks.length) {
      const limited = chunks.slice(0, CONFIG.chunk.maxPerArticle);
      for (let i = 0; i < limited.length; i++) {
        const c = limited[i];
        await query(
          `INSERT INTO chunks (article_id, position, type, content, meta)
           VALUES (?, ?, ?, ?, ?)`,
          [articleId, i, c.type || 'text', c.content || '', JSON.stringify(c.meta || null)]
        );
      }
    }

    res.status(201).json({ id: articleId, slug });
  } catch (e) {
    console.error(e);
    err(res, 500, 'DB error: ' + e.message);
  }
});

// PUT /api/articles/:id — update meta (только дев или свой автор)
app.put('/api/articles/:id', async (req, res) => {
  try {
    const { title, summary, author, cover_url, status, tags } = req.body;
    const id = parseInt(req.params.id);

    // ★ Проверяем права: либо дев IP, либо передали device_id автора
    if (!isDevIP(req)) {
      // Для обычных юзеров можно добавить проверку device_id позже
      // Пока просто блокируем смену статуса на archived/draft от анонимов
      if (status && status !== 'published') {
        return err(res, 403, 'Only dev can change article status');
      }
    }

    const fields = [];
    const vals   = [];
    if (title)     { fields.push('title = ?');     vals.push(title); }
    if (summary !== undefined) { fields.push('summary = ?'); vals.push(summary); }
    if (author)    { fields.push('author = ?');    vals.push(author); }
    if (cover_url !== undefined) { fields.push('cover_url = ?'); vals.push(cover_url); }
    if (status)    { fields.push('status = ?');    vals.push(status); }

    if (fields.length) {
      vals.push(id);
      await query(`UPDATE articles SET ${fields.join(', ')} WHERE id = ?`, vals);
    }

    // replace tags
    if (Array.isArray(tags)) {
      await query('DELETE FROM article_tags WHERE article_id = ?', [id]);
      for (const tagName of tags.slice(0, 20)) {
        const name = String(tagName).slice(0, 80).trim();
        if (!name) continue;
        let [tag] = await query('SELECT id FROM tags WHERE name = ?', [name]);
        if (!tag) {
          const [tagRes] = await pool.query('INSERT INTO tags (name) VALUES (?)', [name]);
          tag = { id: Number(tagRes.insertId) };
        }
        await query('INSERT IGNORE INTO article_tags VALUES (?, ?)', [id, tag.id]);
      }
    }

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    err(res, 500, 'DB error');
  }
});

// ★ DELETE /api/articles/:id — только дев
app.delete('/api/articles/:id', requireDev, async (req, res) => {
  try {
    await query('DELETE FROM articles WHERE id = ?', [parseInt(req.params.id)]);
    res.json({ ok: true });
  } catch (e) {
    err(res, 500, 'DB error');
  }
});

// ─── CHUNKS ────────────────────────────────────────────────────────────────

// GET /api/articles/:id/chunks?page=1
app.get('/api/articles/:id/chunks', async (req, res) => {
  try {
    const articleId = parseInt(req.params.id);
    const { page, limit, offset } = paginate(req.query.page, CONFIG.chunk.pageSize);

    const chunks = await query(
      `SELECT id, position, type, content, meta
       FROM chunks WHERE article_id = ?
       ORDER BY position ASC LIMIT ? OFFSET ?`,
      [articleId, limit, offset]
    );

    const totalRows = await query('SELECT COUNT(*) AS total FROM chunks WHERE article_id = ?', [articleId]);

    res.json({ page, limit, total: Number(totalRows[0].total), chunks });
  } catch (e) {
    err(res, 500, 'DB error');
  }
});

// POST /api/articles/:id/chunks — append chunks
app.post('/api/articles/:id/chunks', async (req, res) => {
  try {
    const articleId = parseInt(req.params.id);
    const { chunks = [] } = req.body;

    const cntRows = await query('SELECT COUNT(*) AS cnt FROM chunks WHERE article_id = ?', [articleId]);
    const current = Number(cntRows[0].cnt);
    const space   = CONFIG.chunk.maxPerArticle - current;
    if (space <= 0) return err(res, 400, 'Chunk limit reached');

    const toInsert = chunks.slice(0, space);
    let pos = current;
    for (const c of toInsert) {
      await query(
        'INSERT INTO chunks (article_id, position, type, content, meta) VALUES (?,?,?,?,?)',
        [articleId, pos++, c.type || 'text', c.content || '', JSON.stringify(c.meta || null)]
      );
    }
    res.json({ inserted: toInsert.length });
  } catch (e) {
    err(res, 500, 'DB error');
  }
});

// ★ PUT /api/chunks/:id — только дев
app.put('/api/chunks/:id', requireDev, async (req, res) => {
  try {
    const { type, content, meta } = req.body;
    await query(
      'UPDATE chunks SET type = ?, content = ?, meta = ? WHERE id = ?',
      [type, content, JSON.stringify(meta || null), parseInt(req.params.id)]
    );
    res.json({ ok: true });
  } catch (e) {
    err(res, 500, 'DB error');
  }
});

// ★ DELETE /api/chunks/:id — только дев
app.delete('/api/chunks/:id', requireDev, async (req, res) => {
  try {
    await query('DELETE FROM chunks WHERE id = ?', [parseInt(req.params.id)]);
    res.json({ ok: true });
  } catch (e) {
    err(res, 500, 'DB error');
  }
});

// ─── SEARCH ────────────────────────────────────────────────────────────────

app.get('/api/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < CONFIG.search.minLength) return res.json({ results: [] });

    const tag    = req.query.tag || null;
    const { limit, offset } = paginate(req.query.page, Math.min(20, CONFIG.search.maxResults));

    let sql = `
      SELECT a.id, a.slug, a.title, a.summary, a.cover_url, a.author, a.views, a.created_at,
             MATCH(a.title, a.summary) AGAINST(? IN BOOLEAN MODE) AS score,
             GROUP_CONCAT(t.name ORDER BY t.name SEPARATOR ',') AS tags
      FROM articles a
      LEFT JOIN article_tags at2 ON at2.article_id = a.id
      LEFT JOIN tags t ON t.id = at2.tag_id
      WHERE a.status = 'published'
        AND (MATCH(a.title, a.summary) AGAINST(? IN BOOLEAN MODE)
             OR a.title LIKE ? OR a.summary LIKE ?)
    `;
    const like = `%${q}%`;
    const params = [q, q, like, like];

    if (tag) {
      sql += ` AND EXISTS (
        SELECT 1 FROM article_tags at3 JOIN tags t2 ON t2.id = at3.tag_id
        WHERE at3.article_id = a.id AND t2.name = ?
      )`;
      params.push(tag);
    }

    sql += ` GROUP BY a.id ORDER BY score DESC, a.views DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const results = await query(sql, params);
    res.json({ results });
  } catch (e) {
    console.error(e);
    err(res, 500, 'DB error');
  }
});

// ─── TAGS ──────────────────────────────────────────────────────────────────

app.get('/api/tags', async (_, res) => {
  try {
    const tags = await query(
      `SELECT t.id, t.name, t.color, COUNT(at2.article_id) AS count
       FROM tags t
       LEFT JOIN article_tags at2 ON at2.tag_id = t.id
       GROUP BY t.id ORDER BY count DESC`
    );
    res.json(tags);
  } catch (e) {
    err(res, 500, 'DB error');
  }
});

// ★ PUT /api/tags/:id — только дев
app.put('/api/tags/:id', requireDev, async (req, res) => {
  try {
    const { color } = req.body;
    await query('UPDATE tags SET color = ? WHERE id = ?', [color, parseInt(req.params.id)]);
    res.json({ ok: true });
  } catch (e) {
    err(res, 500, 'DB error');
  }
});

// ─── MEDIA UPLOAD ──────────────────────────────────────────────────────────

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return err(res, 400, 'No file');
    const url = `/uploads/${req.file.filename}`;
    await pool.query(
      'INSERT INTO media (filename, mime, size_bytes, url) VALUES (?,?,?,?)',
      [req.file.filename, req.file.mimetype, req.file.size, url]
    );
    res.json({ url, filename: req.file.filename, size: req.file.size });
  } catch (e) {
    err(res, 500, 'Upload error: ' + e.message);
  }
});

// ─── STATS ─────────────────────────────────────────────────────────────────

app.get('/api/stats', async (_, res) => {
  try {
    const aRows = await query('SELECT COUNT(*) AS total, SUM(views) AS views FROM articles WHERE status="published"');
    const cRows = await query('SELECT COUNT(*) AS total FROM chunks');
    const tRows = await query('SELECT COUNT(*) AS total FROM tags');
    const a = aRows[0], c = cRows[0], t = tRows[0];
    res.json({
      articles: Number(a.total),
      totalViews: Number(a.views || 0),
      chunks: Number(c.total),
      tags: Number(t.total),
    });
  } catch (e) {
    err(res, 500, 'DB error');
  }
});

// ─── HEALTHCHECK ───────────────────────────────────────────────────────────

app.get('/api/health', async (_, res) => {
  try {
    await query('SELECT 1');
    res.json({ status: 'ok', time: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ status: 'db_down' });
  }
});

// ─── AUTH ──────────────────────────────────────────────────────────────────

app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password, device_id } = req.body;
    if (!username?.trim() || !password || !device_id) return err(res, 400, 'Missing fields');
    if (username.length < 2 || username.length > 30) return err(res, 400, 'Username 2-30 chars');
    if (password.length < 4) return err(res, 400, 'Password min 4 chars');

    const existing = await query('SELECT id, username FROM users WHERE device_id = ?', [device_id]);
    if (existing.length) return err(res, 409, 'Device already registered as: ' + existing[0].username);

    const taken = await query('SELECT id FROM users WHERE username = ?', [username.trim()]);
    if (taken.length) return err(res, 409, 'Username taken');

    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (username, password, device_id) VALUES (?,?,?)',
      [username.trim(), hash, device_id]
    );
    const userId = Number(result[0].insertId);
    res.status(201).json({ id: userId, username: username.trim() });
  } catch (e) {
    console.error(e);
    err(res, 500, 'DB error: ' + e.message);
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password, device_id } = req.body;
    if (!username || !password || !device_id) return err(res, 400, 'Missing fields');

    const users = await query('SELECT * FROM users WHERE username = ?', [username.trim()]);
    if (!users.length) return err(res, 401, 'Wrong username or password');

    const user = users[0];
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return err(res, 401, 'Wrong username or password');

    if (user.device_id !== device_id) return err(res, 403, 'This account is locked to another device');

    res.json({ id: user.id, username: user.username, avatar_color: user.avatar_color, interests: user.interests });
  } catch (e) {
    err(res, 500, 'DB error');
  }
});

app.get('/api/auth/device/:deviceId', async (req, res) => {
  try {
    const rows = await query('SELECT id, username, avatar_color, interests FROM users WHERE device_id = ?', [req.params.deviceId]);
    if (!rows.length) return res.json({ registered: false });
    res.json({ registered: true, user: rows[0] });
  } catch (e) {
    err(res, 500, 'DB error');
  }
});

app.put('/api/auth/interests', async (req, res) => {
  try {
    const { device_id, interests } = req.body;
    await query('UPDATE users SET interests = ? WHERE device_id = ?', [JSON.stringify(interests), device_id]);
    res.json({ ok: true });
  } catch (e) {
    err(res, 500, 'DB error');
  }
});

app.post('/api/push/subscribe', async (req, res) => {
  try {
    const { device_id, endpoint, p256dh, auth } = req.body;
    const users = await query('SELECT id FROM users WHERE device_id = ?', [device_id]);
    if (!users.length) return err(res, 401, 'Not registered');
    const userId = users[0].id;
    await pool.query(
      'INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE endpoint=VALUES(endpoint)',
      [userId, endpoint, p256dh, auth]
    );
    res.json({ ok: true });
  } catch (e) {
    err(res, 500, 'DB error');
  }
});

// ─── RATINGS ───────────────────────────────────────────────────────────────

app.post('/api/ratings/bulk', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids?.length) return res.json({});
    const placeholders = ids.map(() => '?').join(',');
    const rows = await query(
      `SELECT article_id, AVG(stars) AS avg, COUNT(*) AS count FROM ratings WHERE article_id IN (${placeholders}) GROUP BY article_id`,
      ids
    );
    const result = {};
    rows.forEach(r => {
      result[r.article_id] = { avg: Math.round(parseFloat(r.avg) * 10) / 10, count: parseInt(r.count) };
    });
    res.json(result);
  } catch (e) {
    err(res, 500, 'DB error');
  }
});

app.get('/api/ratings/:articleId', async (req, res) => {
  try {
    const articleId = parseInt(req.params.articleId);
    const rows = await query(
      'SELECT AVG(stars) AS avg, COUNT(*) AS count FROM ratings WHERE article_id = ?',
      [articleId]
    );
    const avg = parseFloat(rows[0].avg) || 0;
    const count = parseInt(rows[0].count) || 0;
    res.json({ avg: Math.round(avg * 10) / 10, count });
  } catch (e) {
    err(res, 500, 'DB error');
  }
});

app.post('/api/ratings/:articleId', async (req, res) => {
  try {
    const articleId = parseInt(req.params.articleId);
    const stars = parseInt(req.body.stars);
    if (!stars || stars < 1 || stars > 5) return err(res, 400, 'Stars must be 1-5');
    const ip = getClientIP(req);
    await pool.query(
      'INSERT INTO ratings (article_id, ip, stars) VALUES (?,?,?) ON DUPLICATE KEY UPDATE stars=VALUES(stars)',
      [articleId, ip, stars]
    );
    const rows = await query(
      'SELECT AVG(stars) AS avg, COUNT(*) AS count FROM ratings WHERE article_id = ?',
      [articleId]
    );
    res.json({ avg: Math.round(parseFloat(rows[0].avg) * 10) / 10, count: parseInt(rows[0].count) });
  } catch (e) {
    err(res, 500, 'DB error');
  }
});

// ─── GEMINI STORY GENERATOR ────────────────────────────────────────────────

// ★ POST /api/gemini/key — ТОЛЬКО ДЕВ IP
app.post('/api/gemini/key', requireDev, async (req, res) => {
  const { key, interval_minutes } = req.body;
  if (!key) return err(res, 400, 'No key');
  GeminiCron.apiKey = key;
  GeminiCron.intervalMs = (interval_minutes || 4) * 60 * 1000;
  GeminiCron.start();
  res.json({ ok: true, interval: GeminiCron.intervalMs / 60000 + ' min' });
});

// ★ POST /api/gemini/stop — ТОЛЬКО ДЕВ IP
app.post('/api/gemini/stop', requireDev, (req, res) => {
  GeminiCron.stop();
  res.json({ ok: true });
});

// GET /api/gemini/status — публичный (только статус, без ключа)
app.get('/api/gemini/status', (req, res) => {
  res.json({
    running: !!GeminiCron.timer,
    interval_min: GeminiCron.intervalMs / 60000,
    generated: GeminiCron.count,
    last: GeminiCron.lastTitle
  });
});

const GENRES = [
  'фэнтези с магией и древними пророчествами',
  'постапокалипсис где выжившие строят новый мир',
  'детектив в викторианском городе с паровыми машинами',
  'космическая опера про экипаж старого грузового корабля',
  'мистика в маленьком городке где пропадают люди',
  'приключения путешественника во времени',
  'киберпанк где ИИ получил сознание',
  'история о последнем маге в мире без магии',
  'морское приключение с пиратами и затопленными городами',
  'романтическая история в антиутопическом государстве',
];

const GeminiCron = {
  timer: null,
  apiKey: '',
  intervalMs: 4 * 60 * 1000,
  count: 0,
  lastTitle: '',

  start() {
    if (this.timer) clearInterval(this.timer);
    console.log('🤖 Gemini Cron started, interval:', this.intervalMs / 60000, 'min');
    this.generate();
    this.timer = setInterval(() => this.generate(), this.intervalMs);
  },

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    console.log('🤖 Gemini Cron stopped');
  },

  async generate() {
    if (!this.apiKey) return;
    const genre = GENRES[Math.floor(Math.random() * GENRES.length)];
    console.log('🤖 Gemini generating story, genre:', genre);

    const SYSTEM = `Ты — талантливый автор захватывающих историй.
Напиши историю на русском языке в жанре: ${genre}

ТРЕБОВАНИЯ:
- Минимум 900 слов (5+ минут чтения)
- Живые персонажи с характером и мотивацией
- Неожиданные повороты сюжета
- Атмосферные описания мира
- Сам реши нужны ли продолжения (2-3 части) — если история большая, раздели на части
- Только художественный вымысел

ФОРМАТ (строго JSON без markdown):
{
  "title": "Название истории",
  "summary": "Одно предложение о чём история",
  "tags": ["${genre.split(' ')[0]}", "история", "AI-история"],
  "content": "Полный текст минимум 900 слов с абзацами разделёнными двойным переносом строки",
  "hasContinuation": false,
  "totalParts": 1
}`;

    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${this.apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: SYSTEM }] }],
            generationConfig: { temperature: 0.95, maxOutputTokens: 8192 }
          })
        }
      );

      if (!res.ok) {
        const e = await res.json();
        console.error('🤖 Gemini API error:', e.error?.message);
        return;
      }

      const data = await res.json();
      const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const clean = raw.replace(/```json|```/g, '').trim();
      const story = JSON.parse(clean);

      await this.publishStory(story);
      this.count++;
      this.lastTitle = story.title;
      console.log('🤖 Published:', story.title);

      if (story.hasContinuation && story.totalParts > 1) {
        for (let part = 2; part <= Math.min(story.totalParts, 3); part++) {
          await new Promise(r => setTimeout(r, 5000));
          await this.generateContinuation(story.title, part, story.totalParts, genre);
        }
      }
    } catch (e) {
      console.error('🤖 Gemini error:', e.message);
    }
  },

  async generateContinuation(title, part, total, genre) {
    console.log(`🤖 Generating part ${part}/${total} of "${title}"`);
    const prompt = `Напиши часть ${part} из ${total} истории "${title}" в жанре ${genre}.
Продолжи сюжет, сохрани персонажей. Минимум 900 слов.
${part === total ? 'Финальная часть — дай достойную развязку.' : 'Заверши на интригующей ноте.'}

ФОРМАТ (строго JSON):
{
  "title": "${title} — Часть ${part}",
  "summary": "Краткое описание этой части",
  "tags": ["продолжение", "AI-история"],
  "content": "Текст минимум 900 слов",
  "hasContinuation": ${part < total},
  "totalParts": ${total}
}`;

    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${this.apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.9, maxOutputTokens: 8192 }
          })
        }
      );
      const data = await res.json();
      const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const story = JSON.parse(raw.replace(/```json|```/g, '').trim());
      await this.publishStory(story);
      console.log(`🤖 Part ${part} published`);
    } catch (e) {
      console.error(`🤖 Part ${part} error:`, e.message);
    }
  },

  async publishStory(story) {
    const slug_base = story.title.toLowerCase()
      .replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').slice(0, 180) + '-' + crypto.randomBytes(3).toString('hex');

    const paragraphs = story.content.split(/\n\n+/).filter(p => p.trim());
    const chunks = paragraphs.map(p => ({ type: 'text', content: p.trim() }));

    const insertResult = await pool.query(
      `INSERT INTO articles (slug, title, summary, author, status) VALUES (?,?,?,?,'published')`,
      [slug_base, story.title, story.summary || '', '🤖 Gemini AI']
    );
    const articleId = Number(insertResult[0].insertId);

    const tags = [...(story.tags || []), 'AI-история'];
    for (const tagName of tags.slice(0, 10)) {
      const name = String(tagName).slice(0, 80).trim();
      if (!name) continue;
      let [tag] = await query('SELECT id FROM tags WHERE name = ?', [name]);
      if (!tag) {
        const [r] = await pool.query('INSERT INTO tags (name) VALUES (?)', [name]);
        tag = { id: Number(r.insertId) };
      }
      await query('INSERT IGNORE INTO article_tags VALUES (?,?)', [articleId, tag.id]);
    }

    for (let i = 0; i < chunks.length; i++) {
      await query(
        'INSERT INTO chunks (article_id, position, type, content, meta) VALUES (?,?,?,?,?)',
        [articleId, i, 'text', chunks[i].content, null]
      );
    }
  }
};

// ─── SERVE FRONTEND ────────────────────────────────────────────────────────
app.use(express.static(__dirname));

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── AUTO MIGRATE ──────────────────────────────────────────────────────────
async function migrate() {
  console.log('⚙️  Running migrations…');
  await query(`
    CREATE TABLE IF NOT EXISTS articles (
      id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      slug         VARCHAR(220) NOT NULL UNIQUE,
      title        VARCHAR(300) NOT NULL,
      summary      TEXT,
      cover_url    VARCHAR(500),
      author       VARCHAR(150) DEFAULT 'Anonymous',
      status       ENUM('draft','published','archived') DEFAULT 'draft',
      views        INT UNSIGNED DEFAULT 0,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  try {
    await query(`ALTER TABLE articles ADD FULLTEXT idx_ft (title, summary)`);
  } catch (e) { /* already exists */ }

  await query(`
    CREATE TABLE IF NOT EXISTS chunks (
      id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      article_id   INT UNSIGNED NOT NULL,
      position     SMALLINT UNSIGNED NOT NULL,
      type         ENUM('text','heading','image','code','quote','table','divider') DEFAULT 'text',
      content      MEDIUMTEXT,
      meta         JSON,
      FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE,
      INDEX idx_article_pos (article_id, position)
    ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS tags (
      id    SMALLINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      name  VARCHAR(80) NOT NULL UNIQUE,
      color VARCHAR(7) DEFAULT '#6366f1'
    ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS article_tags (
      article_id INT UNSIGNED NOT NULL,
      tag_id     SMALLINT UNSIGNED NOT NULL,
      PRIMARY KEY (article_id, tag_id),
      FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
    ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS media (
      id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      filename    VARCHAR(260) NOT NULL,
      mime        VARCHAR(80),
      size_bytes  INT UNSIGNED,
      url         VARCHAR(500),
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS ratings (
      id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      article_id INT UNSIGNED NOT NULL,
      ip         VARCHAR(64) NOT NULL,
      stars      TINYINT UNSIGNED NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_ip_article (article_id, ip),
      FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE
    ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      username     VARCHAR(80) NOT NULL UNIQUE,
      password     VARCHAR(255) NOT NULL,
      device_id    VARCHAR(128) NOT NULL UNIQUE,
      avatar_color VARCHAR(7) DEFAULT '#6366f1',
      interests    JSON,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id    INT UNSIGNED NOT NULL,
      endpoint   TEXT NOT NULL,
      p256dh     TEXT NOT NULL,
      auth       TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  // ★ article_views — теперь есть и в migrate (раньше была только в шапке)
  await query(`
    CREATE TABLE IF NOT EXISTS article_views (
      id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      article_id INT UNSIGNED NOT NULL,
      user_id    INT UNSIGNED,
      ip         VARCHAR(64),
      viewed_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_article (article_id),
      FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE
    ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  console.log('✅ Migrations done');
}

// ─── START ─────────────────────────────────────────────────────────────────
app.listen(CONFIG.port, '0.0.0.0', () => {
  console.log(`📚 Encyclopaedia NEXUS v2.0 running on port ${CONFIG.port}`);
  console.log(`⚡ Dev IPs: ${CONFIG.devIPs.join(', ')}`);
  migrate()
    .then(() => console.log('✅ DB ready'))
    .catch(e => console.error('⚠️ DB not ready yet:', e.message));
});

module.exports = app;
