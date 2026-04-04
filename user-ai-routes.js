'use strict';

/**
 * user-ai-routes.js — Юзерский AI генератор историй
 * 
 * Подключи в encyclopedia-server.js:
 *   require('./user-ai-routes')(app, pool, query, getClientIP);
 * 
 * И добавь в migrate() таблицу:
 *   await query(`
 *     CREATE TABLE IF NOT EXISTS user_ai_crons (
 *       id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 *       user_id      INT UNSIGNED NOT NULL UNIQUE,
 *       gemini_key   VARCHAR(500) NOT NULL,
 *       interval_min SMALLINT UNSIGNED DEFAULT 60,
 *       active       TINYINT(1) DEFAULT 1,
 *       generated    INT UNSIGNED DEFAULT 0,
 *       last_title   VARCHAR(300),
 *       last_run_at  DATETIME,
 *       created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
 *       FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
 *     ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
 *   `);
 * 
 * И вызови после migrate():
 *   migrate().then(() => restoreUserCrons()).catch(...)
 */

const crypto = require('crypto');

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

// Map активных кронов: userId → { timer }
const userCrons = new Map();

module.exports = function registerUserAIRoutes(app, pool, query) {

  // ─── HELPERS ─────────────────────────────────────────────────────────────

  function err(res, status, msg) {
    return res.status(status).json({ error: msg });
  }

  async function publishStory(story, userId, username) {
    const slug = story.title.toLowerCase()
      .replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').slice(0, 180)
      + '-' + crypto.randomBytes(3).toString('hex');

    const paragraphs = story.content.split(/\n\n+/).filter(p => p.trim());

    const [result] = await pool.query(
      `INSERT INTO articles (slug, title, summary, author, status) VALUES (?,?,?,?,'published')`,
      [slug, story.title, story.summary || '', `🤖 ${username}`]
    );
    const articleId = Number(result.insertId);

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

    for (let i = 0; i < paragraphs.length; i++) {
      await query(
        'INSERT INTO chunks (article_id, position, type, content, meta) VALUES (?,?,?,?,?)',
        [articleId, i, 'text', paragraphs[i].trim(), null]
      );
    }

    return articleId;
  }

  async function callGemini(prompt, key) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.95, maxOutputTokens: 8192 }
        })
      }
    );

    if (!res.ok) {
      const e = await res.json();
      const error = new Error(e.error?.message || 'Gemini API error');
      error.code = e.error?.code;
      throw error;
    }

    const data = await res.json();
    const raw  = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  }

  async function generateAndPublish(userId, username, geminiKey) {
    const genre = GENRES[Math.floor(Math.random() * GENRES.length)];
    console.log(`🤖 [${username}] generating · genre: ${genre}`);

    const prompt = `Ты — талантливый автор захватывающих историй.
Напиши историю на русском языке в жанре: ${genre}

ТРЕБОВАНИЯ:
- Минимум 900 слов (5+ минут чтения)
- Живые персонажи с характером и мотивацией
- Неожиданные повороты сюжета
- Атмосферные описания мира
- Сам реши нужны ли продолжения (2-3 части)
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
      const story = await callGemini(prompt, geminiKey);
      await publishStory(story, userId, username);

      await query(
        'UPDATE user_ai_crons SET generated = generated + 1, last_title = ?, last_run_at = NOW() WHERE user_id = ?',
        [story.title, userId]
      );

      console.log(`🤖 [${username}] published: ${story.title}`);

      // Продолжения
      if (story.hasContinuation && story.totalParts > 1) {
        for (let part = 2; part <= Math.min(story.totalParts, 3); part++) {
          await new Promise(r => setTimeout(r, 6000));
          const contPrompt = `Напиши часть ${part} из ${story.totalParts} истории "${story.title}" в жанре ${genre}.
Продолжи сюжет, сохрани персонажей. Минимум 900 слов.
${part === story.totalParts ? 'Финальная часть — дай достойную развязку.' : 'Заверши на интригующей ноте.'}

ФОРМАТ (строго JSON):
{
  "title": "${story.title} — Часть ${part}",
  "summary": "Краткое описание этой части",
  "tags": ["продолжение", "AI-история"],
  "content": "Текст минимум 900 слов",
  "hasContinuation": ${part < story.totalParts},
  "totalParts": ${story.totalParts}
}`;
          const cont = await callGemini(contPrompt, geminiKey);
          await publishStory(cont, userId, username);
          await query(
            'UPDATE user_ai_crons SET generated = generated + 1, last_title = ?, last_run_at = NOW() WHERE user_id = ?',
            [cont.title, userId]
          );
          console.log(`🤖 [${username}] part ${part} published`);
        }
      }

    } catch (e) {
      console.error(`🤖 [${username}] error:`, e.message);
      // Невалидный ключ — останавливаем крон
      if (e.code === 400 || e.code === 403) {
        console.error(`🤖 [${username}] bad key, stopping`);
        stopUserCron(userId);
        await query('UPDATE user_ai_crons SET active = 0 WHERE user_id = ?', [userId]).catch(() => {});
      }
    }
  }

  // ─── CRON MANAGEMENT ─────────────────────────────────────────────────────

  function stopUserCron(userId) {
    const c = userCrons.get(userId);
    if (c?.timer) clearInterval(c.timer);
    userCrons.delete(userId);
  }

  function startUserCron(userId, username, geminiKey, intervalMin) {
    stopUserCron(userId);
    const ms = intervalMin * 60 * 1000;

    // Первый запуск сразу
    generateAndPublish(userId, username, geminiKey);

    const timer = setInterval(() => generateAndPublish(userId, username, geminiKey), ms);
    userCrons.set(userId, { timer });
    console.log(`🤖 Cron started: ${username} · every ${intervalMin} min`);
  }

  // Восстановить все активные кроны после рестарта сервера
  async function restoreUserCrons() {
    try {
      const rows = await query(
        `SELECT uc.user_id, uc.gemini_key, uc.interval_min, u.username
         FROM user_ai_crons uc
         JOIN users u ON u.id = uc.user_id
         WHERE uc.active = 1`
      );
      for (const r of rows) {
        startUserCron(r.user_id, r.username, r.gemini_key, r.interval_min);
      }
      if (rows.length) console.log(`🤖 Restored ${rows.length} user cron(s)`);
    } catch (e) {
      console.error('restoreUserCrons error:', e.message);
    }
  }

  // Экспортируем для вызова после migrate()
  app.restoreUserCrons = restoreUserCrons;

  // ─── ROUTES ──────────────────────────────────────────────────────────────

  // POST /api/user-ai/start
  app.post('/api/user-ai/start', async (req, res) => {
    try {
      const { device_id, gemini_key, interval_min = 60 } = req.body;
      if (!device_id || !gemini_key) return err(res, 400, 'Missing fields');

      const users = await query('SELECT id, username FROM users WHERE device_id = ?', [device_id]);
      if (!users.length) return err(res, 401, 'Not registered');
      const { id: userId, username } = users[0];

      const interval = Math.min(1440, Math.max(5, parseInt(interval_min)));

      await pool.query(
        `INSERT INTO user_ai_crons (user_id, gemini_key, interval_min, active)
         VALUES (?,?,?,1)
         ON DUPLICATE KEY UPDATE
           gemini_key=VALUES(gemini_key),
           interval_min=VALUES(interval_min),
           active=1`,
        [userId, gemini_key, interval]
      );

      startUserCron(userId, username, gemini_key, interval);
      res.json({ ok: true, interval_min: interval });
    } catch (e) {
      console.error(e);
      err(res, 500, 'DB error: ' + e.message);
    }
  });

  // POST /api/user-ai/stop
  app.post('/api/user-ai/stop', async (req, res) => {
    try {
      const { device_id } = req.body;
      if (!device_id) return err(res, 400, 'Missing device_id');

      const users = await query('SELECT id FROM users WHERE device_id = ?', [device_id]);
      if (!users.length) return err(res, 401, 'Not registered');
      const userId = users[0].id;

      stopUserCron(userId);
      await query('UPDATE user_ai_crons SET active = 0 WHERE user_id = ?', [userId]);
      res.json({ ok: true });
    } catch (e) {
      err(res, 500, 'DB error');
    }
  });

  // GET /api/user-ai/status
  app.get('/api/user-ai/status', async (req, res) => {
    try {
      const { device_id } = req.query;
      if (!device_id) return res.json({ active: false });

      const users = await query('SELECT id FROM users WHERE device_id = ?', [device_id]);
      if (!users.length) return res.json({ active: false, generated: 0 });
      const userId = users[0].id;

      const rows = await query(
        'SELECT active, interval_min, generated, last_title, last_run_at FROM user_ai_crons WHERE user_id = ?',
        [userId]
      );
      if (!rows.length) return res.json({ active: false, generated: 0 });

      const r = rows[0];
      res.json({
        active:       !!r.active && userCrons.has(userId),
        interval_min: r.interval_min,
        generated:    r.generated,
        last_title:   r.last_title,
        last_run_at:  r.last_run_at,
      });
    } catch (e) {
      err(res, 500, 'DB error');
    }
  });
};
