/**
 * user-ai.js — Юзерский AI генератор историй (фронт)
 * Подключается в index.html через <script src="user-ai.js"></script>
 * ПЕРЕД этим тегом должны быть определены: API, DEVICE_ID, currentUser, apiFetch, toast
 */

/* ═══════════════════════════════════════════════════════
   CSS — инжектируем в <head> программно
═══════════════════════════════════════════════════════ */
(function injectStyles() {
  const style = document.createElement('style');
  style.textContent = `
    .ai-modal {
      position: fixed; inset: 0; z-index: 350;
      background: rgba(13,13,15,.88); backdrop-filter: blur(6px);
      display: flex; align-items: center; justify-content: center; padding: 1rem;
    }
    .ai-box {
      background: var(--ink); color: var(--paper);
      border: 1px solid rgba(255,255,255,.1);
      border-radius: 10px; width: 100%; max-width: 420px;
      padding: 1.8rem; box-shadow: 0 8px 40px rgba(0,0,0,.4);
      animation: slideUp .25s ease;
    }
    .ai-box h3 {
      font-family: var(--display); font-size: 1.3rem;
      margin-bottom: .3rem; color: var(--gold-lt);
    }
    .ai-box .ai-desc {
      font-size: .82rem; color: rgba(245,240,232,.45);
      margin-bottom: 1.3rem; line-height: 1.55;
    }
    .ai-box .ai-label {
      display: block; font-family: var(--mono); font-size: .7rem;
      letter-spacing: .1em; text-transform: uppercase;
      color: rgba(245,240,232,.4); margin-bottom: .35rem;
    }
    .ai-box input {
      width: 100%; background: rgba(255,255,255,.07);
      border: 1px solid rgba(255,255,255,.13); border-radius: 6px;
      padding: .58rem .9rem; color: var(--paper);
      font-family: var(--mono); font-size: .85rem; outline: none;
      margin-bottom: .8rem; transition: border-color .18s;
    }
    .ai-box input:focus { border-color: var(--gold-lt); }
    .ai-interval-row {
      display: flex; align-items: center; gap: .6rem; margin-bottom: .9rem;
    }
    .ai-interval-row input {
      width: 72px; margin: 0; text-align: center;
    }
    .ai-interval-row span {
      font-family: var(--mono); font-size: .78rem;
      color: rgba(245,240,232,.4);
    }
    .ai-btn {
      width: 100%; padding: .58rem 1rem;
      border: none; border-radius: 6px; cursor: pointer;
      font-family: var(--mono); font-size: .85rem; font-weight: 700;
      transition: opacity .15s, transform .1s; margin-bottom: .45rem;
    }
    .ai-btn:active { transform: scale(.98); }
    .ai-btn-start {
      background: linear-gradient(135deg, var(--gold), var(--gold-lt));
      color: var(--ink);
    }
    .ai-btn-start:hover { opacity: .9; }
    .ai-btn-stop {
      background: rgba(248,113,113,.12); color: #f87171;
      border: 1px solid rgba(248,113,113,.25);
    }
    .ai-btn-stop:hover { background: rgba(248,113,113,.2); }
    .ai-status {
      font-family: var(--mono); font-size: .78rem;
      color: var(--gold-lt); margin-top: .7rem;
      min-height: 1.1rem; text-align: center;
    }
    .ai-counter {
      text-align: center; font-family: var(--mono); font-size: .7rem;
      color: rgba(245,240,232,.3); margin-top: .3rem;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .ai-close-btn {
      display: block; margin-top: 1rem; width: 100%;
      background: none; border: none; color: rgba(245,240,232,.25);
      font-family: var(--mono); font-size: .78rem;
      cursor: pointer; transition: color .15s;
    }
    .ai-close-btn:hover { color: rgba(245,240,232,.6); }

    /* Бейдж рядом с аватаром в хедере */
    .ai-running-badge {
      display: inline-flex; align-items: center; gap: .45rem;
      padding: .28rem .75rem; border-radius: 20px;
      background: rgba(184,134,11,.12); border: 1px solid rgba(184,134,11,.3);
      font-family: var(--mono); font-size: .72rem; color: var(--gold-lt);
      cursor: pointer; transition: background .15s; white-space: nowrap;
      text-decoration: none;
    }
    .ai-running-badge:hover { background: rgba(184,134,11,.22); }
    .ai-running-badge::before {
      content: ''; width: 6px; height: 6px; border-radius: 50%;
      background: var(--gold-lt);
      animation: devPulse 1.5s ease-in-out infinite; flex-shrink: 0;
    }
  `;
  document.head.appendChild(style);
})();

/* ═══════════════════════════════════════════════════════
   HTML модалки — инжектируем в <body>
═══════════════════════════════════════════════════════ */
(function injectModal() {
  const modal = document.createElement('div');
  modal.id        = 'aiModal';
  modal.className = 'ai-modal';
  modal.style.display = 'none';
  modal.innerHTML = `
    <div class="ai-box">
      <h3>🤖 AI генератор историй</h3>
      <p class="ai-desc">
        Вставь свой Gemini API ключ — ИИ будет автоматически писать истории
        и публиковать их на сайте. Работает 24/7 даже после закрытия браузера.
        Ключ хранится на сервере только для генерации.
      </p>

      <label class="ai-label">Gemini API Key</label>
      <input type="password" id="aiKeyInput" placeholder="AIza...">

      <label class="ai-label">Интервал генерации</label>
      <div class="ai-interval-row">
        <input type="number" id="aiIntervalInput" value="60" min="5" max="1440">
        <span>минут (мин: 5, макс: 1440)</span>
      </div>

      <button class="ai-btn ai-btn-start" onclick="UserAI.start()">
        ⚡ Запустить генератор
      </button>
      <button class="ai-btn ai-btn-stop" onclick="UserAI.stop()">
        ⏹ Остановить
      </button>

      <div class="ai-status"  id="aiStatus"></div>
      <div class="ai-counter" id="aiCounter"></div>

      <button class="ai-close-btn" onclick="UserAI.close()">Закрыть</button>
    </div>
  `;
  // Клик на фон — закрыть
  modal.addEventListener('click', e => { if (e.target === modal) UserAI.close(); });
  document.body.appendChild(modal);
})();

/* ═══════════════════════════════════════════════════════
   UserAI объект
═══════════════════════════════════════════════════════ */
const UserAI = {

  open() {
    if (typeof currentUser === 'undefined' || !currentUser) {
      toast('Сначала войди в аккаунт', 'error');
      return;
    }
    const saved = localStorage.getItem('nexus_user_gemini_key');
    if (saved) document.getElementById('aiKeyInput').value = saved;
    document.getElementById('aiModal').style.display = 'flex';
    this.refreshStatus();
  },

  close() {
    document.getElementById('aiModal').style.display = 'none';
  },

  async start() {
    const key      = document.getElementById('aiKeyInput').value.trim();
    const interval = parseInt(document.getElementById('aiIntervalInput').value) || 60;

    if (!key) { toast('Введи Gemini API ключ', 'error'); return; }
    if (!currentUser) { toast('Сначала войди', 'error'); return; }

    localStorage.setItem('nexus_user_gemini_key', key);
    this._status('<span class="pulse">⏳ Запускаю…</span>');

    try {
      await apiFetch('/user-ai/start', {
        method: 'POST',
        body: JSON.stringify({
          device_id:    DEVICE_ID,
          gemini_key:   key,
          interval_min: interval,
        })
      });
      this._status('✓ Запущен! Первая история появится через ~30 сек');
      this._counter('');
      this._updateBadge(true, 0);
      toast('🤖 AI генератор запущен!');
      // Обновляем список статей через 35 секунд
      setTimeout(() => {
        if (typeof loadSidebar === 'function') loadSidebar();
        if (typeof loadArticles === 'function') loadArticles();
      }, 35000);
    } catch (e) {
      this._status('❌ ' + e.message);
    }
  },

  async stop() {
    if (!currentUser) return;
    try {
      await apiFetch('/user-ai/stop', {
        method: 'POST',
        body: JSON.stringify({ device_id: DEVICE_ID })
      });
      this._status('⏹ Генератор остановлен');
      this._updateBadge(false);
      toast('AI генератор остановлен');
    } catch (e) {
      this._status('❌ ' + e.message);
    }
  },

  async refreshStatus() {
    if (!currentUser) return;
    try {
      const s = await apiFetch('/user-ai/status?device_id=' + DEVICE_ID);

      if (s.active) {
        this._status(`🟢 Работает · каждые ${s.interval_min} мин`);
        this._counter(
          `Написано: ${s.generated} историй` +
          (s.last_title ? ` · «${s.last_title.slice(0, 38)}…»` : '')
        );
        this._updateBadge(true, s.generated);
      } else {
        this._status(s.generated > 0
          ? `⏹ Остановлен · всего написано: ${s.generated}`
          : '⏹ Не запущен'
        );
        this._counter('');
        this._updateBadge(false);
      }
    } catch {}
  },

  // ─── INTERNAL ────────────────────────────────────────────────────────────

  _status(html) {
    const el = document.getElementById('aiStatus');
    if (el) el.innerHTML = html;
  },

  _counter(text) {
    const el = document.getElementById('aiCounter');
    if (el) el.textContent = text;
  },

  _updateBadge(active, count = 0) {
    let badge = document.getElementById('aiRunningBadge');

    if (active) {
      if (!badge) {
        badge = document.createElement('span');
        badge.id        = 'aiRunningBadge';
        badge.className = 'ai-running-badge';
        badge.title     = 'AI генератор работает — нажми чтобы управлять';
        badge.onclick   = () => UserAI.open();
        // Вставляем перед кнопкой "+ Статья"
        const addBtn = document.querySelector('.header-actions .btn-primary');
        if (addBtn) addBtn.parentNode.insertBefore(badge, addBtn);
      }
      badge.innerHTML = `🤖 AI · ${count}`;
    } else {
      badge?.remove();
    }
  }
};

/* ═══════════════════════════════════════════════════════
   Добавить пункт в дропдаун профиля после загрузки DOM
═══════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  const dropdown = document.getElementById('profileDropdown');
  if (dropdown) {
    const item = document.createElement('div');
    item.className = 'profile-dropdown-item';
    item.innerHTML = '🤖 AI генератор';
    item.onclick = () => {
      dropdown.style.display = 'none';
      UserAI.open();
    };
    // Вставляем после первого пункта (Мой профиль)
    const first = dropdown.querySelector('.profile-dropdown-item');
    if (first?.nextSibling) {
      dropdown.insertBefore(item, first.nextSibling);
    } else {
      dropdown.appendChild(item);
    }
  }
});

/* ═══════════════════════════════════════════════════════
   Проверить статус при загрузке страницы
   (вызывается из init в index.html)
═══════════════════════════════════════════════════════ */
async function initUserAI() {
  if (typeof currentUser !== 'undefined' && currentUser) {
    await UserAI.refreshStatus();
  }
}
