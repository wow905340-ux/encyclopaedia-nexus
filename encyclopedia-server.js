/**
 * ENCYCLOPAEDIA NEXUS — Backend Server
 * Node.js + Express + MariaDB
 * 
 * Setup:
 *   npm install express mariadb multer sharp cors helmet express-rate-limit
 * 
 * MariaDB schema — run once:
 *   CREATE DATABASE encyclopaedia CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
 *   USE encyclopaedia;
 * 
 *   CREATE TABLE articles (
 *     id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 *     slug         VARCHAR(220) NOT NULL UNIQUE,
 *     title        VARCHAR(300) NOT NULL,
 *     summary      TEXT,
 *     cover_url    VARCHAR(500),
 *     author       VARCHAR(150) DEFAULT 'Anonymous',
 *     status       ENUM('draft','published','archived') DEFAULT 'draft',
 *     views        INT UNSIGNED DEFAULT 0,
 *     created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
 *     updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 *     FULLTEXT idx_ft (title, summary)
 *   ) ENGINE=InnoDB;
 * 
 *   CREATE TABLE chunks (
 *     id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 *     article_id   INT UNSIGNED NOT NULL,
 *     position     SMALLINT UNSIGNED NOT NULL,
 *     type         ENUM('text','heading','image','code','quote','table','divider') DEFAULT 'text',
 *     content      MEDIUMTEXT,
 *     meta         JSON,
 *     FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE,
 *     INDEX idx_article_pos (article_id, position)
 *   ) ENGINE=InnoDB;
 * 
 *   CREATE TABLE tags (
 *     id    SMALLINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 *     name  VARCHAR(80) NOT NULL UNIQUE,
 *     color VARCHAR(7) DEFAULT '#6366f1'
 *   ) ENGINE=InnoDB;
 * 
 *   CREATE TABLE article_tags (
 *     article_id INT UNSIGNED NOT NULL,
 *     tag_id     SMALLINT UNSIGNED NOT NULL,
 *     PRIMARY KEY (article_id, tag_id),
 *     FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE,
 *     FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
 *   ) ENGINE=InnoDB;
 * 
 *   CREATE TABLE media (
 *     id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 *     filename   VARCHAR(260) NOT NULL,
 *     mime       VARCHAR(80),
 *     size_bytes INT UNSIGNED,
 *     url        VARCHAR(500),
 *     uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
 *   ) ENGINE=InnoDB;
 */

'use strict';

const express    = require('express');
const mariadb    = require('mariadb');
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const crypto     = require('crypto');

// ─── CONFIG ────────────────────────────────────────────────────────────────
const CONFIG = {
  port: process.env.PORT || 8080,
  db: {
    host:     process.env.MYSQLHOST     || process.env.DB_HOST     || '127.0.0.1',
    port:     parseInt(process.env.MYSQLPORT || process.env.DB_PORT || '3306'),
    user:     process.env.MYSQLUSER     || process.env.DB_USER     || 'root',
    password: process.env.MYSQLPASSWORD || process.env.DB_PASS     || 'password',
    database: process.env.MYSQLDATABASE || process.env.DB_NAME     || 'railway',
    connectionLimit: 10,
    acquireTimeout: 10000,
    charset: 'utf8mb4',
  },
  upload: {
    dir:      path.resolve('./uploads'),
    maxSizeMB: 10,
    allowed:  ['image/jpeg','image/png','image/webp','image/gif','image/avif'],
  },
  chunk: {
    maxPerArticle: 500,   // hard cap per article
    pageSize: 20,         // chunks per lazy-load page
  },
  search: {
    minLength: 2,
    maxResults: 50,
  }
};

// ─── DB POOL ───────────────────────────────────────────────────────────────
const pool = mariadb.createPool(CONFIG.db);

async function query(sql, params = []) {
  let conn;
  try {
    conn = await pool.getConnection();
    return await conn.query(sql, params);
  } finally {
    if (conn) conn.release();
  }
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

    sql += ` GROUP BY a.id ORDER BY ${orderCol} DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = await query(sql, params);

    const [[{ total }]] = [await query(
      `SELECT COUNT(*) AS total FROM articles WHERE status = ?`, [status]
    )];

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
      `SELECT a.*, GROUP_CONCAT(t.name ORDER BY t.name SEPARATOR ',') AS tags,
              GROUP_CONCAT(t.color ORDER BY t.name SEPARATOR ',') AS tag_colors
       FROM articles a
       LEFT JOIN article_tags at2 ON at2.article_id = a.id
       LEFT JOIN tags t ON t.id = at2.tag_id
       WHERE a.slug = ?
       GROUP BY a.id`,
      [req.params.slug]
    );
    if (!article) return err(res, 404, 'Not found');

    // increment views async
    query('UPDATE articles SET views = views + 1 WHERE id = ?', [article.id]).catch(() => {});

    res.json(article);
  } catch (e) {
    err(res, 500, 'DB error');
  }
});

// POST /api/articles — create article
app.post('/api/articles', async (req, res) => {
  try {
    const { title, summary, author, cover_url, tags = [], chunks = [] } = req.body;
    if (!title?.trim()) return err(res, 400, 'Title required');

    let slug = slugify(title);
    // make slug unique
    const existing = await query('SELECT id FROM articles WHERE slug LIKE ?', [`${slug}%`]);
    if (existing.length) slug += `-${Date.now()}`;

    const result = await query(
      `INSERT INTO articles (slug, title, summary, author, cover_url, status)
       VALUES (?, ?, ?, ?, ?, 'published')`,
      [slug, title.trim(), summary || null, author || 'Anonymous', cover_url || null]
    );
    const articleId = Number(result.insertId);

    // insert tags
    if (tags.length) {
      for (const tagName of tags.slice(0, 20)) {
        const name = String(tagName).slice(0, 80).trim();
        if (!name) continue;
        let [tag] = await query('SELECT id FROM tags WHERE name = ?', [name]);
        if (!tag) {
          const r = await query('INSERT INTO tags (name) VALUES (?)', [name]);
          tag = { id: Number(r.insertId) };
        }
        await query('INSERT IGNORE INTO article_tags VALUES (?, ?)', [articleId, tag.id]);
      }
    }

    // insert chunks (smart chunking: cap at maxPerArticle)
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

// PUT /api/articles/:id — update meta
app.put('/api/articles/:id', async (req, res) => {
  try {
    const { title, summary, author, cover_url, status, tags } = req.body;
    const id = parseInt(req.params.id);

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
          const r = await query('INSERT INTO tags (name) VALUES (?)', [name]);
          tag = { id: Number(r.insertId) };
        }
        await query('INSERT IGNORE INTO article_tags VALUES (?, ?)', [id, tag.id]);
      }
    }

    res.json({ ok: true });
  } catch (e) {
    err(res, 500, 'DB error');
  }
});

// DELETE /api/articles/:id
app.delete('/api/articles/:id', async (req, res) => {
  try {
    await query('DELETE FROM articles WHERE id = ?', [parseInt(req.params.id)]);
    res.json({ ok: true });
  } catch (e) {
    err(res, 500, 'DB error');
  }
});

// ─── CHUNKS ────────────────────────────────────────────────────────────────

// GET /api/articles/:id/chunks?page=1 — paginated lazy-load of chunks
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

    const [[{ total }]] = [await query(
      'SELECT COUNT(*) AS total FROM chunks WHERE article_id = ?', [articleId]
    )];

    res.json({ page, limit, total: Number(total), chunks });
  } catch (e) {
    err(res, 500, 'DB error');
  }
});

// POST /api/articles/:id/chunks — append chunks
app.post('/api/articles/:id/chunks', async (req, res) => {
  try {
    const articleId = parseInt(req.params.id);
    const { chunks = [] } = req.body;

    // current count
    const [[{ cnt }]] = [await query(
      'SELECT COUNT(*) AS cnt FROM chunks WHERE article_id = ?', [articleId]
    )];
    const current = Number(cnt);
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

// PUT /api/chunks/:id — update single chunk
app.put('/api/chunks/:id', async (req, res) => {
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

// DELETE /api/chunks/:id
app.delete('/api/chunks/:id', async (req, res) => {
  try {
    await query('DELETE FROM chunks WHERE id = ?', [parseInt(req.params.id)]);
    res.json({ ok: true });
  } catch (e) {
    err(res, 500, 'DB error');
  }
});

// ─── SEARCH ────────────────────────────────────────────────────────────────

// GET /api/search?q=...&tag=...
app.get('/api/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < CONFIG.search.minLength) return res.json({ results: [] });

    const tag    = req.query.tag || null;
    const { limit, offset } = paginate(req.query.page, Math.min(20, CONFIG.search.maxResults));

    // Full-text search on title+summary, fallback LIKE
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

app.put('/api/tags/:id', async (req, res) => {
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
    await query(
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
    const [[a]] = [await query('SELECT COUNT(*) AS total, SUM(views) AS views FROM articles WHERE status="published"')];
    const [[c]] = [await query('SELECT COUNT(*) AS total FROM chunks')];
    const [[t]] = [await query('SELECT COUNT(*) AS total FROM tags')];
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

// ─── SERVE FRONTEND ────────────────────────────────────────────────────────
// Railway не умеет отдавать статику сам — сервер делает это вместо него.

app.use(express.static(__dirname));

// SPA fallback — все маршруты кроме /api отдают index.html
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── AUTO MIGRATE ──────────────────────────────────────────────────────────
// При старте сервера автоматически создаёт все таблицы если их нет.
// Руками в БД лезть не нужно.

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

  // FULLTEXT добавляем отдельно — IF NOT EXISTS для индекса не поддерживается
  try {
    await query(`ALTER TABLE articles ADD FULLTEXT idx_ft (title, summary)`);
  } catch (e) { /* уже существует — ок */ }

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

  console.log('✅ Migrations done');
}

// ─── START ─────────────────────────────────────────────────────────────────

// Сервер стартует СРАЗУ — не ждёт базу
// Если база недоступна при старте — сайт всё равно поднимется
app.listen(CONFIG.port, '0.0.0.0', () => {
  console.log(`📚 Encyclopaedia NEXUS running on port ${CONFIG.port}`);
  // Миграции запускаем в фоне после старта
  migrate()
    .then(() => console.log('✅ DB ready'))
    .catch(e => console.error('⚠️ DB not ready yet:', e.message));
});

module.exports = app;
