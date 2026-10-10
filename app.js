/* ============================================================
   Сперанский AI — Mini App v2: полноценный ИИ-клиент.
   Чаты (история на сервере), выбор модели, диалог с красивым
   рендером формул (KaTeX) и markdown.

   Безопасность: страница не знает ключей API; каждый запрос к
   Render несёт Telegram initData, подпись проверяется сервером.
   ============================================================ */
'use strict';
window.__APP_V = '20261011b';
const FALL_REASON = {
  rate: 'кончился лимит',
  cooldown: 'на кулдауне',
  error: 'сбой',
  unfit: 'не подходит',
  empty: 'пустой ответ',
};

const state = {
  pendingImage: null,
  abortCtl: null,
  thinkTimer: null,
  models: [],
  chats: [],
  current: null,          // {id, title, provider, model, messages: []}
  busy: false,
  modelTab: 'text',       // активная вкладка категорий в шторке моделей
  chatReady: null,        // промис фонового создания чата на сервере
  tempMap: {},            // local-id → серверный id (после сохранения)
  tempCancel: new Set(),  // local-id удалённых до сохранения чатов
  theme: 'system',        // system | dark | light
  accent: 'blue',         // blue | violet | green | orange
  haptics: true,
  pins: [],               // закреплённые чаты
  quota: null,            // {left_day, unlimited} с сервера
  chatFilter: '',         // фильтр списка чатов в drawer
};

/* ================= UI helpers ================= */
function warn(text) {
  const w = $('#warn');
  w.hidden = false;
  w.textContent = text;
  clearTimeout(warn._t);
  warn._t = setTimeout(() => { w.hidden = true; }, 6000);
}

function showFatal(text) {
  $('#boot').hidden = true;
  $('#head').hidden = true;
  $('#messages').hidden = true;
  $('#empty').hidden = true;
  $('#composer').hidden = true;
  $('#fatal').hidden = false;
  $('#fatal-text').textContent = text;
}

function shortModel(m) {
  return (m || '').split('/').pop().split(':')[0];
}

function updateHead() {
  document.title = state.current
    ? (state.current.title || 'Чат') + ' — Сперанский AI'
    : 'Сперанский AI';
  const inp = $('#input');
  if (inp) inp.placeholder = 'Спроси Сперанского…';
  const chip = $('#btn-model');
  if (state.current && state.current.provider) {
    chip.innerHTML = IC.sparkFill + esc(shortModel(state.current.model));
  } else {
    chip.innerHTML = IC.sparkFill + 'модель';
  }
  /* правая кнопка хедера меняет роль: инфо о данных → меню чата */
  const ctx = $('#btn-ctx');
  if (ctx) {
    const has = !!(state.current && state.current.messages.length);
    ctx.title = has ? 'Меню чата' : 'Как хранятся данные';
    ctx.setAttribute('aria-label', ctx.title);
    ctx.innerHTML = has ? IC.dots : IC.sparkO;
  }
}

function scrollBottom() {
  const m = $('#messages');
  requestAnimationFrame(() => { m.scrollTop = m.scrollHeight; });
}

function fallbackLine(fallbacks, finalProvider, finalModel) {
  const row = document.createElement('div');
  row.className = 'fall-line';
  // служебное не мозолит: показываем только осмысленные причины
  const shown = (fallbacks || []).filter((f) => f.code === 'rate' || f.code === 'cooldown');
  const list = shown.length ? shown : (fallbacks || []).slice(0, 1);
  for (const f of list) {
    const chip = document.createElement('span');
    chip.className = 'fall-chip';
    const reason = f.code === 'rate' || f.code === 'cooldown'
      ? ' · ' + esc(FALL_REASON[f.code]) : '';
    chip.innerHTML = logoHtml(f.provider) + ' ' + esc(shortModel(f.model)) + reason;
    row.appendChild(chip);
    const ar = document.createElement('span');
    ar.className = 'fall-arrow';
    ar.textContent = '→';
    row.appendChild(ar);
  }
  const fin = document.createElement('span');
  fin.className = 'fall-chip final';
  fin.innerHTML = logoHtml(finalProvider) + ' ' + esc(shortModel(finalModel));
  row.appendChild(fin);
  return row;
}

function addMessageEl(role, text, opts = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + (role === 'user' ? 'user' : 'bot');
  if (opts.mi != null) wrap.dataset.mi = opts.mi;
  if (role !== 'user' && opts.fallbacks && opts.fallbacks.length) {
    wrap.appendChild(fallbackLine(opts.fallbacks, opts.provider, opts.model));
  }
  const bubble = document.createElement('div');
  bubble.className = 'bubble' + (opts.pending ? ' pending' : '');
  if (role === 'user') {
    if (opts.image) {
      const im = document.createElement('img');
      im.className = 'msg-img';
      im.src = opts.image;
      bubble.appendChild(im);
    } else if (opts.hasImage) {
      const ph = document.createElement('div');
      ph.className = 'msg-img-ph';
      ph.textContent = '📷 фото прикреплялось (в истории не хранится)';
      bubble.appendChild(ph);
    }
    if (text) bubble.appendChild(document.createTextNode(text));
  } else if (opts.pending) {
    bubble.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
  } else {
    renderRich(bubble, text);
  }
  wrap.appendChild(bubble);
  if (role !== 'user' && !opts.pending && opts.model) {
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.innerHTML = logoHtml(opts.provider) + ' ' + esc(opts.model);
    wrap.appendChild(meta);
  }
  if (role !== 'user' && !opts.pending && text) {
    wrap.appendChild(buildActions(text, !!opts.__canRegen));
  }
  $('#messages').appendChild(wrap);
  scrollBottom();
  return bubble;
}

/* ---------------- действия под ответом: копировать / заново ---------------- */
async function copyText(t) {
  try {
    await navigator.clipboard.writeText(t);
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e2) { /* совсем без буфера */ }
    ta.remove();
  }
  warn('Скопировано в буфер обмена.');
}

function buildActions(text, canRegen) {
  const acts = document.createElement('div');
  acts.className = 'msg-actions';
  const mk = (cls, title, icon, fn) => {
    const b = document.createElement('button');
    b.className = 'act-btn' + (cls ? ' ' + cls : '');
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.innerHTML = icon;
    b.onclick = (e) => { e.stopPropagation(); fn(b); };
    acts.appendChild(b);
    return b;
  };
  mk('', 'Скопировать ответ', IC.copy, () => { haptic('light'); copyText(text); });
  if (canRegen) {
    mk('act-regen', 'Перегенерировать ответ', IC.regen, () => {
      hapticSel(); regenerateLast();
    });
  }
  mk('', 'Поделиться ответом', IC.shareIc, () => { haptic('light'); shareText(text); });
  return acts;
}

function shareText(text) {
  const t = String(text || '').slice(0, 4000);
  if (navigator.share) { navigator.share({ text: t }).catch(() => {}); return; }
  copyText(t);
}

/* кнопка «заново» имеет смысл только у последнего ответа —
   убираем устаревшие, когда ниже появился новый ответ */
function dedupeRegen() {
  const acts = document.querySelectorAll('#messages .msg-actions');
  acts.forEach((a, i) => {
    const rg = a.querySelector('.act-regen');
    if (rg && i !== acts.length - 1) rg.remove();
  });
}

/* «заново» = заменяем ТОЛЬКО ответ: вопрос остаётся на месте,
   ничего не удаляется и не отправляется повторно */
function regenerateLast() {
  if (state.busy || !state.current) return;
  const msgs = state.current.messages;
  while (msgs.length && msgs[msgs.length - 1].role === 'assistant') msgs.pop();
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') {
    return warn('Не нашёл вопрос для перегенерации.');
  }
  paintMessages();          // вопрос на месте, старый ответ уже снят
  send({ regen: true });
}

function paintMessages() {
  const box = $('#messages');
  box.innerHTML = '';
  const msgs = state.current ? state.current.messages : [];
  $('#empty').hidden = msgs.length > 0;
  const cta = $('#btn-start-cta');
  const et = $('#empty-title');
  const ex = $('#empty-text');
  if (cta) cta.hidden = !!state.current;
  if (et && ex && msgs.length === 0 && state.current) {
    et.textContent = 'Чат готов';
    ex.innerHTML = 'Модель ' + esc(shortModel(state.current.model)) +
      ' на связи. Напиши первый вопрос или прикрепи фото плюсом.';
  }
  box.hidden = false;
  let lastBot = -1;
  msgs.forEach((m, i) => { if (m.role !== 'user') lastBot = i; });
  msgs.forEach((m, i) => addMessageEl(
    m.role, m.content,
    Object.assign({}, m, { mi: i },
      i === lastBot ? { __canRegen: !state.busy } : {})));
}

/* ================= чаты и модели ================= */
async function loadModels() {
  const j = await api('GET', '/api/models');
  state.models = j.models || [];
}

async function loadChats() {
  const j = await api('GET', '/api/chats');
  state.chats = j.chats || [];
}

function parseModel(str) {
  const idx = String(str || '').indexOf('/');
  if (idx < 0) return { provider: '', model: str || '' };
  return { provider: str.slice(0, idx), model: str.slice(idx + 1) };
}

async function openChat(id) {
  if (String(id).startsWith('local-')) {
    // чат ещё создаётся на сервере — дожидаемся и берём настоящий id
    if (state.chatReady) {
      try { await state.chatReady; }
      catch (e) { return warn('Чат ещё создаётся — попробуй чуть позже.'); }
    }
    id = state.tempMap[id] || id;
  }
  const row = await api('GET', `/api/chats/${id}`);
  const pm = parseModel(row.model);
  state.current = {
    id: row.id, title: row.title || 'Чат',
    provider: pm.provider, model: pm.model,
    messages: row.messages || [],
  };
  closeSheets();
  updateHead();
  paintMessages();
}

async function createChat() {
  const def = state.models.find(m => m.available) || state.models[0] || {};
  const row = await api('POST', '/api/chats', {
    title: 'Новый чат', model: `${def.provider || ''}/${def.model || ''}`,
  });
  state.chats.unshift(row);
  const pm = parseModel(row.model);
  state.current = { id: row.id, title: row.title, provider: pm.provider,
                    model: pm.model, messages: [] };
  updateHead();
  paintMessages();
}

async function deleteChat(id) {
  if (String(id).startsWith('local-')) {
    const real = state.tempMap[id];
    if (real) id = real;                    // уже сохранился — удаляем как обычно
    else {                                  // ещё летит на сервер — отменяем
      state.tempCancel.add(id);
      state.chats = state.chats.filter((c) => c.id !== id);
      if (state.current && state.current.id === id) {
        state.current = null;
        updateHead();
        paintMessages();
        $('#messages').hidden = true;
        $('#empty').hidden = false;
      }
      renderChatsList();
      return;
    }
  }
  await api('DELETE', `/api/chats/${id}`);
  state.chats = state.chats.filter(c => c.id !== id);
  if (state.current && state.current.id === id) {
    state.current = null;
    updateHead();
    paintMessages();
    $('#messages').hidden = true;
    $('#empty').hidden = false;
  }
  renderChatsList();
}

function renderChatsList() {
  const box = $('#chats-list');
  box.innerHTML = '';
  const q = (state.chatFilter || '').trim().toLowerCase();
  const list = state.chats
    .filter((c) => !q || String(c.title || '').toLowerCase().includes(q))
    .sort((a, b) => (state.pins.includes(b.id) ? 1 : 0) - (state.pins.includes(a.id) ? 1 : 0));
  if (!state.chats.length) {
    box.innerHTML = '<div class="sheet-empty">Чатов пока нет — нажми «Чат» внизу ' +
      'или просто напиши сообщение.</div>';
    return;
  }
  if (!list.length) {
    box.innerHTML = '<div class="sheet-empty">Ничего не нашлось по запросу «' +
      esc(q) + '».</div>';
    return;
  }
  for (const c of list) {
    const row = document.createElement('div');
    row.className = 'chat-row' + (state.current && state.current.id === c.id ? ' active' : '');
    const t = document.createElement('div');
    t.className = 'chat-row-title';
    t.innerHTML = (state.pins.includes(c.id)
      ? '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:5px;opacity:.7" aria-hidden="true"><path d="M9 4h6l-1 7 3 3v2H7v-2l3-3z"/><path d="M12 16v5"/></svg>'
      : '') + esc(c.title || 'Чат');
    const s = document.createElement('div');
    s.className = 'chat-row-sub';
    s.textContent = shortModel(c.model) + ' · ' + String(c.updated_at || '').slice(5, 16);
    const del = document.createElement('button');
    del.className = 'icon-btn chat-del';
    del.title = 'Удалить чат';
    del.innerHTML = IC.x;
    del.onclick = (e) => {
      e.stopPropagation();
      if (del.dataset.arm) {
        deleteChat(c.id).catch((e) => warn('Не удалось удалить чат: ' + e.message));
        return;
      }
      del.dataset.arm = '1';
      del.textContent = 'точно?';
      del.classList.add('armed');
      clearTimeout(del._t);
      del._t = setTimeout(() => {
        delete del.dataset.arm;
        del.classList.remove('armed');
        del.innerHTML = IC.x;
      }, 3000);
    };
    row.onclick = () => openChat(c.id)
      .catch((e) => warn('Не удалось открыть чат: ' + e.message));
    row.appendChild(t); row.appendChild(s); row.appendChild(del);
    box.appendChild(row);
  }
}

function createChatOptimistic(provider, model) {
  const tempId = 'local-' + Date.now().toString(36) + '-' +
                 Math.random().toString(36).slice(2, 7);
  const cur = { id: tempId, title: 'Новый чат', provider, model, messages: [] };
  const tempRow = { id: tempId, title: cur.title,
                    model: `${provider}/${model}`,
                    updated_at: new Date().toISOString() };
  state.current = cur;
  state.chats.unshift(tempRow);
  updateHead();
  paintMessages();
  if (model) warn(`Чат создан с моделью ${shortModel(model)}.`);
  pushChatToServer(cur, tempRow);
}

function pushChatToServer(cur, tempRow) {
  state.chatReady = api('POST', '/api/chats',
                        { title: cur.title, model: `${cur.provider}/${cur.model}` })
    .then((row) => {
      const tempId = cur.id;
      state.chatReady = null;
      if (state.tempCancel.has(tempId)) {   // чат удалили, пока POST летел
        state.tempCancel.delete(tempId);
        api('DELETE', `/api/chats/${row.id}`).catch(() => {});
        return null;
      }
      state.tempMap[tempId] = row.id;
      cur.id = row.id;
      const i = state.chats.indexOf(tempRow);
      if (i >= 0) state.chats[i] = row;
      return row;
    })
    .catch((e) => {
      state.chatReady = null;
      warn('Не удалось создать чат на сервере: ' + e.message +
           ' — повторю при отправке.');
      throw e;
    });
  state.chatReady.catch(() => {});   // отловлено — ждут потребители
}

/* Сохранение выбранной модели в фоне; UI к этому моменту уже обновлён */
function saveChatModel(cur) {
  const doPut = () => api('PUT', `/api/chats/${cur.id}`,
                          { model: `${cur.provider}/${cur.model}` })
    .catch(() => warn('Выбор модели не сохранился на сервере — попробуй ещё раз.'));
  if (state.chatReady) state.chatReady.then(doPut, () => {});
  else doPut();
}

/* Досоздание чата на сервере перед сохранением сообщений (если POST упал) */
async function syncTempChat(cur) {
  if (state.chatReady) { try { await state.chatReady; } catch (e) {} }
  if (!String(cur.id).startsWith('local-')) return;
  const tempId = cur.id;
  const row = await api('POST', '/api/chats',
                        { title: cur.title, model: `${cur.provider}/${cur.model}` });
  cur.id = row.id;
  state.tempMap[tempId] = row.id;
  const i = state.chats.findIndex((c) => c.id === tempId);
  if (i >= 0) state.chats[i] = row; else state.chats.unshift(row);
}

function openSheet(id) {
  if (id === '#chats-sheet') renderChatsList();
  if (id === '#model-sheet') { renderModelTabs(); renderModelsList(); }
  if (id === '#settings-sheet') renderSettings();
  $(id).hidden = false;
}
function closeSheets() {
  for (const id of ['#chats-sheet', '#model-sheet', '#settings-sheet',
                    '#data-sheet', '#files-sheet', '#find-sheet']) {
    const el = $(id);
    if (el) el.hidden = true;
  }
  closeChatMenu();
}

/* ================= «думает» с таймером и микрокопи ================= */
const THINK_PHRASES = ['читаю условие…', 'строю решение…', 'сверяю вычисления…',
                       'формулирую шаги…', 'думаю дальше…'];
function startThinking(bubble) {
  bubble.innerHTML = '<div class="think"><span class="dots"><i></i><i></i><i></i></span>' +
    '<span class="think-txt">' + THINK_PHRASES[0] + ' <b class="think-s">0с</b></span></div>';
  const t0 = Date.now();
  let pi = 0;
  state.thinkTimer = setInterval(() => {
    const sec = Math.round((Date.now() - t0) / 1000);
    const el = bubble.querySelector('.think-s');
    if (el) el.textContent = sec + 'с';
    if (sec % 5 === 0 && sec > 0) {
      pi = (pi + 1) % THINK_PHRASES.length;
      const tx = bubble.querySelector('.think-txt');
      if (tx) tx.firstChild.textContent = THINK_PHRASES[pi] + ' ';
    }
    if (sec === 25) {
      const tx = bubble.querySelector('.think-txt');
      if (tx) tx.firstChild.textContent = 'ответ длинный, всё ещё думаю… ';
    }
    if (sec === 75) {
      const tx = bubble.querySelector('.think-txt');
      if (tx) tx.firstChild.textContent = 'долго: модель с фото думает или сеть медленная — можно остановить стоп-кнопкой и повторить ';
    }
  }, 1000);
}
function stopThinking() {
  if (state.thinkTimer) { clearInterval(state.thinkTimer); state.thinkTimer = null; }
}

/* ================= фото задания ================= */
function clearAttach() {
  state.pendingImage = null;
  $('#attach-preview').hidden = true;
}

function compressImage(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const MAX = 1280;
      let w = img.width, h = img.height;
      const k = Math.min(1, MAX / Math.max(w, h));
      w = Math.round(w * k); h = Math.round(h * k);
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(img, 0, 0, w, h);
      state.pendingImage = cv.toDataURL('image/jpeg', 0.82);
      $('#attach-thumb').src = state.pendingImage;
      $('#attach-preview').hidden = false;
    };
    img.onerror = () => warn('Не удалось прочитать картинку.');
    img.src = reader.result;
  };
  reader.onerror = () => warn('Не удалось открыть файл.');
  reader.readAsDataURL(file);
}

/* ================= настройки пользователя (localStorage) ================= */
const PREFS_KEY = 'sp_prefs_v1';
function loadPrefs() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); } catch (e) {}
  state.theme = p.theme || 'system';
  state.accent = p.accent || 'blue';
  state.haptics = p.haptics !== false;
  state.pins = Array.isArray(p.pins) ? p.pins : [];
}
function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      theme: state.theme, accent: state.accent, haptics: state.haptics,
      pins: state.pins,
    }));
  } catch (e) { /* приватный режим — не страшно */ }
}
function applyPrefs() {
  const r = document.documentElement;
  if (state.theme === 'system') delete r.dataset.theme;
  else r.dataset.theme = state.theme;
  if (state.accent === 'blue') delete r.dataset.accent;
  else r.dataset.accent = state.accent;
}

/* ================= стриминг ================= */
async function readStream(res, bubble) {
  const reader = res.body.getReader();
  try {
    return await _readStreamInner(res, reader, bubble);
  } catch (e) {
    bubble.classList.remove('streaming');
    if (e && e.name === 'AbortError') { e.aborted = true; e.partial = bubble.__acc || ''; }
    throw e;
  }
}

async function _readStreamInner(res, reader, bubble) {
  const dec = new TextDecoder();
  let buf = '', acc = '', last = 0, meta = null;
  bubble.classList.remove('pending');
  bubble.classList.add('streaming');
  const paint = (force) => {
    const now = Date.now();
    if (!force && now - last < 120) return;
    last = now;
    renderRich(bubble, acc);
    scrollBottom();
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let j;
      try { j = JSON.parse(line); } catch (e) { continue; }
      if (j.d !== undefined) {
        acc += j.d;
        bubble.__acc = acc;
        // троттлинг перерисовки: на телефонах без этого «дёрганья»
        if (!bubble.__raf) {
          bubble.__raf = requestAnimationFrame(() => {
            bubble.__raf = 0;
            paint(false);
          });
        }
      }
      else if (j.error) { throw Object.assign(new Error(j.error), { code: 502 }); }
      else { meta = j; }
    }
  }
  bubble.classList.remove('streaming');
  paint(true);
  if (!meta) throw Object.assign(new Error('поток оборвался без мета-строки'),
                                 { code: 502 });
  meta.reply = meta.reply || acc;
  return meta;
}

async function chatRequest(cur, bubble) {
  state.abortCtl = new AbortController();
  let timedOut = false;
  let silence = setTimeout(() => { timedOut = true; state.abortCtl.abort(); }, 95000);
  let att = 0;
  /* Пауза перед повтором: возвращаем пузырёк в «ждём», перевешиваем
     AbortController и таймер тишины. Если за это время нажали «стоп» —
     выходим как отмена, а не молча стартуем новый запрос. */
  async function prepareRetry(delay, partial) {
    bubble.classList.add('pending');
    bubble.classList.remove('streaming');
    bubble.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
    delete bubble.__acc;        // хвост оборванного стрима всплыть не должен
    haptic('light');
    await new Promise((r) => setTimeout(r, delay));
    if (state.abortCtl.signal.aborted && !timedOut) {
      const err = new Error('остановлено');
      err.name = 'AbortError';
      err.aborted = true;
      err.partial = partial || '';
      throw err;
    }
    state.abortCtl = new AbortController();
    timedOut = false;
    clearTimeout(silence);
    silence = setTimeout(() => { timedOut = true; state.abortCtl.abort(); }, 95000);
  }
  for (;;) {
    let res;
    try {
      res = await fetch(API_BASE + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: state.abortCtl.signal,
        body: JSON.stringify({
          initData: INIT_DATA, provider: cur.provider, model: cur.model,
          messages: cur.messages, stream: !NO_STREAM,
        }),
      });
    } catch (e) {
      clearTimeout(silence);
      if (timedOut) {
        throw Object.assign(new Error('сервер молчит >95 секунд'), { code: 504 });
      }
      if (e && e.name === 'AbortError') {        // «стоп» — не сетевой сбой
        e.aborted = true;
        e.partial = bubble.__acc || '';
        throw e;
      }
      const net = /Load failed|Failed to fetch|NetworkError|network/i
        .test(String(e && e.message));
      if (!net || att >= 2) {
        throw Object.assign(
          new Error(net ? 'сеть сорвала запрос (LTE/WebView)' : String(e && e.message)),
          { code: 0, net: !!net });
      }
      att += 1;
      await prepareRetry(att === 1 ? 900 : 2200, bubble.__acc);
      continue;
    }
    clearTimeout(silence);
    const ct = res.headers.get('content-type') || '';
    if (res.ok && ct.includes('ndjson')) {
      try {
        return await readStream(res, bubble);
      } catch (e) {
        /* Тело ответа уже вычитано читателем, поэтому res.json() здесь
           ничего не даст (в лучшем случае — «body stream already read»),
           а на сорванной сети ещё и подвиснет. Про ошибку сервера мы всё
           равно не узнаем — единственный надёжный путь: перечитать запрос
           целиком. Надёжность важнее одного лишнего запроса. */
        const part = (e && e.partial) || bubble.__acc || '';
        if (e && e.name === 'AbortError' && !timedOut) {   // явная отмена
          e.aborted = true;
          e.partial = part;
          throw e;
        }
        if (att >= 2) {
          throw Object.assign(new Error('связь оборвалась на середине ответа'),
            { code: 502, net: true, streamBroken: true, partial: part });
        }
        att += 1;
        await prepareRetry(att === 1 ? 900 : 2200, part);
        continue;
      }
    }
    // не-стримовый ответ: тело ещё не тронуто, читаем как обычно
    const data = res.bodyUsed ? {} : await res.json().catch(() => ({}));
    if (!res.ok) {
      throw Object.assign(new Error(data.error || ('HTTP ' + res.status)),
                          { code: res.status });
    }
    bubble.classList.remove('pending');
    renderRich(bubble, data.reply);
    return data;
  }
}

/* ================= отправка ================= */
async function send(opts = {}) {
  if (state.busy) return;
  const regen = !!opts.regen;
  const input = $('#input');
  const lastU = regen && state.current
    ? state.current.messages[state.current.messages.length - 1]
    : null;
  const text = regen ? ((lastU && lastU.content) || '')
    : (opts.text != null ? String(opts.text) : input.value.trim());
  if (!text && !(regen && lastU && lastU.image)) return;
  if (!INIT_DATA) return showFatal('Нет данных Telegram. Открой приложение из чата с ботом.');
  try {
    if (!state.current) await createChat();
    else if (state.chatReady) {
      // чат создан оптимистично — дожидаемся фонового POST
      try { await state.chatReady; } catch (e) { /* повторю при сохранении */ }
    }
  } catch (e) {
    return warn('Не удалось создать чат: ' + e.message);
  }
  const cur = state.current;
  const img = regen ? ((lastU && lastU.image) || null) : state.pendingImage;
  if (!regen) {
    cur.messages.push({ role: 'user', content: text, image: img || undefined });
    clearAttach();
    if (opts.text == null) { input.value = ''; autosize(); }
    if (cur.title === 'Новый чат') {
      cur.title = text.slice(0, 40) + (text.length > 40 ? '…' : '');
      updateHead();
    }
    $('#empty').hidden = true;
    $('#messages').hidden = false;
    addMessageEl('user', text, { image: img });
  }
  const pending = addMessageEl('assistant', '', { pending: true });
  startThinking(pending);
  state.busy = true;
  setSendUI(true);
  haptic('light');
  try {
    let r;
    try {
      r = await chatRequest(cur, pending);
    } catch (e) {
      if (e.name === 'AbortError') { e.aborted = true; e.partial = pending.__acc || ''; }
      if (e.code === 504) e.timedOut504 = true;
      throw e;
    }
    stopThinking();
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.innerHTML = logoHtml(r.provider) + ' ' + esc(r.model);
    pending.parentNode.appendChild(meta);
    if (r.fallbacks && r.fallbacks.length) {
      pending.parentNode.insertBefore(fallbackLine(r.fallbacks, r.provider, r.model),
                                      pending.parentNode.firstChild);
    }
    pending.parentNode.appendChild(buildActions(r.reply || pending.__acc || '', true));
    dedupeRegen();
    scrollBottom();
    if (state.quota && !state.quota.unlimited && state.quota.left_day > 0) {
      state.quota.left_day -= 1;
      renderQuota();
    }
    if (r.fallbacks && r.fallbacks.length &&
        (r.provider !== cur.provider || r.model !== cur.model)) {
      const from = r.fallbacks[r.fallbacks.length - 1];
      cur.provider = r.provider;
      cur.model = r.model;
      updateHead();
      warn(`⚡ ${shortModel(from.model)}: ${FALL_REASON[from.code] || from.code} → ` +
           `переключил на ${shortModel(r.model)}. Выбор обновлён.`);
      api('GET', '/api/models').then((j) => { state.models = j.models || []; })
        .catch(() => {});
    }
    cur.messages.push({ role: 'assistant', content: r.reply,
                        provider: r.provider, model: r.model,
                        fallbacks: r.fallbacks || [] });
    // на сервер история уходит с окном из 4 последних картинок,
    // старшие самоудаляются, оставляя метку hasImage
    const clean = cur.messages.map((m) => ({ ...m }));
    applyImageWindow(clean);
    try {
      if (String(cur.id).startsWith('local-')) await syncTempChat(cur);
      await api('PUT', `/api/chats/${cur.id}`,
                { messages: clean, title: cur.title,
                  model: `${cur.provider}/${cur.model}` });
      const row = state.chats.find(c => c.id === cur.id);
      if (row) { row.title = cur.title; row.updated_at = new Date().toISOString(); }
    } catch (e) { warn('Ответ получен, но не сохранился в историю: ' + e.message); }
  } catch (e) {
    stopThinking();
    pending.classList.remove('pending', 'streaming');
    if ((e.aborted && !e.timedOut504) || (e.streamBroken && e.partial)) {
      const part = e.partial || '';
      const stopped = !!e.aborted;
      if (part) {
        renderRich(pending, part);
        const note = document.createElement('div');
        note.className = 'stop-note';
        note.textContent = stopped
          ? '■ остановлено — сохранил сгенерированную часть'
          : '■ связь оборвалась на середине — сохранил готовую часть';
        pending.appendChild(note);
        cur.messages.push({ role: 'assistant', content: part });
        warn(stopped
          ? 'Генерацию остановили: сохранил то, что успело напечататься.'
          : 'Ответ оборвался, повторить не удалось — дописал готовую часть.');
      } else {
        pending.remove();
        warn('Генерацию остановили.');
      }
      return;
    }
    hapticNotify('error');
    if (state.quota && state.quota.unlimited) {
      // владельцу — в консоль, наружу служебное не показываем
      try {
        const d = await api('GET', '/api/debug');
        console.info('[diag]', d.last_chat, d.models);
      } catch (e2) { /* старый сервер без /api/debug */ }
    }
    pending.textContent = '⚠️ ' + (e.code === 401
      ? 'Сессия протухла: закрой и открой приложение заново.'
      : e.code === 504
        ? 'Сервер не ответил вовремя.'
        : e.net
          ? 'Не удалось отправить: связь мигнула.'
          : 'Не получилось ответить.');
    const rb = document.createElement('button');
    rb.className = 'retry-btn';
    rb.textContent = 'Повторить';
    rb.onclick = () => { rb.remove(); send({ regen: true }); };
    pending.appendChild(rb);
    warn('');
    $('#warn').hidden = true;
  } finally {
    stopThinking();
    state.busy = false;
    setSendUI(false);
    state.abortCtl = null;
  }
}

function applyImageWindow(msgs) {
  const idx = [];
  msgs.forEach((m, i) => { if (m.image) idx.push(i); });
  idx.slice(0, Math.max(0, idx.length - 4)).forEach((i) => {
    delete msgs[i].image;
    msgs[i].hasImage = true;
  });
}

function setSendUI(busy) {
  const b = $('#btn-send');
  const ico = $('#send-ico');
  b.classList.toggle('stopping', !!busy);
  if (ico) ico.innerHTML = busy ? IC.stop : IC.send;
  b.setAttribute('aria-label', busy ? 'остановить генерацию' : 'отправить');
}

function autosize() {
  const i = $('#input');
  i.style.height = 'auto';
  i.style.height = Math.min(i.scrollHeight, 140) + 'px';
  /* Кнопка отправки появляется, когда в поле есть текст. */
  const c = $('#composer');
  if (c) c.classList.toggle('has-text', !!i.value.trim());
}

/* ================= настройки (груп-карточки) ================= */
const THEMES = [['system', 'Системное'], ['dark', 'Тёмное'], ['light', 'Светлое']];
const ACCENTS = [['blue', 'Синий'], ['violet', 'Фиолетовый'],
                 ['green', 'Зелёный'], ['orange', 'Оранжевый']];
const ONOFF = (v) => (v ? 'Вкл' : 'Выкл');

function renderSettings() {
  const th = THEMES.find((t) => t[0] === state.theme) || THEMES[0];
  const ac = ACCENTS.find((a) => a[0] === state.accent) || ACCENTS[0];
  $('#set-theme-val').textContent = th[1];
  $('#set-accent-val').innerHTML = '<i class="acc-dot"></i>' + ac[1];
  $('#set-haptics-val').textContent = ONOFF(state.haptics);
  $('#set-model-val').textContent = state.current && state.current.provider
    ? shortModel(state.current.model) : 'Авто';
  const v = $('#set-version');
  if (v) v.textContent = __APP_V;
  /* секция владельца: статистика проекта */
  const statsCard = $('#set-stats');
  if (statsCard) {
    const owner = !!(state.quota && state.quota.unlimited);
    statsCard.hidden = !owner;
    const sec = $('#set-stats-sec');
    if (sec) sec.hidden = !owner;
    if (owner) loadStats();
  }
  /* профиль из Telegram initData */
  const u = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
  const name = u ? [u.first_name, u.last_name].filter(Boolean).join(' ') : '';
  $('#set-name').textContent = name || 'Гость Telegram';
  const initials = (u ? (u.first_name || '') + ' ' + (u.last_name || '') : '')
    .trim().split(/\s+/).map((w) => w[0] || '').join('').slice(0, 2).toUpperCase();
  $('#set-avatar').firstChild.textContent = initials || 'ГО';
}

/* ================= меню чата (карточка у правого верхнего угла) ========== */
function openChatMenu() {
  const cur = state.current;
  if (!cur) { openSheet('#data-sheet'); return; }
  $('#cm-title').textContent = cur.title || 'Чат';
  $('#cm-pin-tx').textContent = state.pins.includes(cur.id)
    ? 'Открепить' : 'Закрепить';
  $('#menu-scrim').hidden = false;
  $('#chat-menu').hidden = false;
}
function closeChatMenu() {
  const s = $('#menu-scrim');
  const m = $('#chat-menu');
  if (s) s.hidden = true;
  if (m) m.hidden = true;
}

function chatDigest() {
  const cur = state.current;
  if (!cur) return '';
  return (cur.title || 'Чат') + '\n\n' + cur.messages.slice(-8)
    .map((m) => (m.role === 'user' ? 'Я: ' : 'Сперанский: ') + m.content)
    .join('\n\n');
}

function openFilesSheet() {
  const box = $('#files-list');
  box.innerHTML = '';
  const cur = state.current;
  const imgs = (cur ? cur.messages : [])
    .map((m, i) => ({ m, i }))
    .filter((x) => x.m.image);
  if (!imgs.length) {
    box.innerHTML = '<div class="sheet-empty">В этом чате ещё нет файлов.</div>';
  }
  for (const x of imgs) {
    const row = document.createElement('div');
    row.className = 'file-row';
    const thumb = document.createElement('img');
    thumb.alt = '';
    thumb.src = x.m.image;
    const info = document.createElement('div');
    const name = document.createElement('div');
    name.textContent = 'фото к сообщению ' + (x.i + 1);
    const hint = document.createElement('small');
    hint.textContent = 'нажми, чтобы рассмотреть';
    info.appendChild(name);
    info.appendChild(hint);
    row.appendChild(thumb);
    row.appendChild(info);
    row.onclick = () => {
      haptic('light');
      box.innerHTML = '';
      const big = document.createElement('img');
      big.alt = '';
      big.src = x.m.image;
      big.style.cssText = 'width:100%;border-radius:16px;margin:8px 0';
      const back = document.createElement('div');
      back.className = 'find-row';
      back.textContent = '← ко всем файлам';
      back.onclick = openFilesSheet;
      box.appendChild(big);
      box.appendChild(back);
    };
    box.appendChild(row);
  }
  openSheet('#files-sheet');
}

function openFindSheet() {
  openSheet('#find-sheet');
  const inp = $('#find-input');
  inp.value = '';
  renderFind('');
  setTimeout(() => inp.focus(), 120);
}
function renderFind(q) {
  const box = $('#find-list');
  box.innerHTML = '';
  const cur = state.current;
  const qq = (q || '').trim().toLowerCase();
  if (!cur || !qq) {
    box.innerHTML = '<div class="sheet-empty">Печатай — найду по всем ' +
      'сообщениям этого чата.</div>';
    return;
  }
  let n = 0;
  (cur.messages || []).forEach((m, i) => {
    const tx = String(m.content || '');
    const at = tx.toLowerCase().indexOf(qq);
    if (at < 0) return;
    n++;
    const row = document.createElement('div');
    row.className = 'find-row';
    const snip = tx.slice(Math.max(0, at - 30), at + 60);
    row.innerHTML = '<div>' + esc(snip).replace(
      new RegExp(esc(qq).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
      '<b>$&</b>') + '</div><small>' +
      (m.role === 'user' ? 'твоё сообщение' : 'ответ') + ' #' + (i + 1) + '</small>';
    row.onclick = () => {
      closeSheets();
      const el = document.querySelector('[data-mi="' + i + '"]');
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.classList.add('flash');
        setTimeout(() => el.classList.remove('flash'), 1200);
      }
    };
    box.appendChild(row);
  });
  if (!n) box.innerHTML = '<div class="sheet-empty">Не нашлось.</div>';
}

/* ================= квота запросов ================= */
async function loadQuota() {
  try {
    state.quota = await api('GET', '/api/quota');
  } catch (e) {
    /* 404 — старый сервер без квот, пилюлю просто не показываем.
       Сетевой сбой (code 0) — оставляем последние известные цифры,
       чтобы пилюля не мигала при каждом провальном фоновом запросе. */
    if (e.code !== 0) state.quota = null;
  }
  renderQuota();
}

/* статистика проекта: сколько всего пользователей и кто заходил сегодня.
   Сервер считает по живым initData, эндпоинт отдаёт только владельцу. */
async function loadStats() {
  const tEl = $('#set-stat-total');
  const dEl = $('#set-stat-today');
  const qEl = $('#set-stat-quota');
  if (qEl) qEl.textContent = '∞ без лимитов';
  try {
    const j = await api('GET', '/api/stats');
    if (tEl) tEl.textContent = String(j.total != null ? j.total : '—');
    if (dEl) dEl.textContent = String(j.today != null ? j.today : '—');
  } catch (e) {
    if (tEl) tEl.textContent = '—';
    if (dEl) dEl.textContent = '—';
  }
}
function renderQuota() {
  const pill = $('#quota-pill');
  if (!pill) return;
  const q = state.quota;
  if (!q) { pill.hidden = true; return; }
  pill.hidden = false;
  if (q.unlimited) {
    pill.textContent = '∞ без лимитов';
    pill.className = 'quota-pill inf';
  } else {
    pill.textContent = 'сегодня осталось: ' + q.left_day;
    pill.className = 'quota-pill' + (q.left_day <= 5 ? ' low' : '');
  }
}

/* ================= быстрые действия на пустом экране ================= */
const QUICK = [
  { icon: 'solve', tx: 'Реши задачу по фото или тексту — с полным разбором',
    put: 'Реши задачу с полным разбором по шагам: ' },
  { icon: 'check2', tx: 'Проверь моё решение и найди ошибки',
    put: 'Проверь моё решение, укажи ошибки и объясни их: ' },
  { icon: 'bulb', tx: 'Объясни тему простыми словами',
    put: 'Объясни простыми словами, с примером: ' },
  { icon: 'cal', tx: 'Составь план подготовки к пробнику',
    put: 'Составь план подготовки к пробнику по предмету: ' },
];
function buildQuickActions() {
  const box = $('#quick-actions');
  if (!box) return;
  box.innerHTML = '';
  for (const q of QUICK) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'qa-row';
    const ic = q.icon === 'check2'
      ? '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/></svg>'
      : IC[q.icon];
    b.innerHTML = ic + '<span>' + esc(q.tx) + '</span>';
    b.onclick = () => {
      haptic('light');
      const inp = $('#input');
      inp.value = q.put;
      autosize();
      inp.focus();
      try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch (e) {}
    };
    box.appendChild(b);
  }
}

/* ================= старт ================= */
async function boot() {
  loadPrefs();
  applyPrefs();
  tgInit();
  const retry = $('#fatal-retry');
  if (retry) retry.onclick = () => location.reload();
  if (!INIT_DATA) {
    return showFatal('Открой меня из Telegram: в чате с ботом нажми кнопку ' +
      'меню (квадратик слева от поля ввода) или кнопку «📱 Открыть приложение».');
  }
  try {
    try {
      const b = await api('GET', '/api/boot');
      state.models = b.models || [];
      state.chats = b.chats || [];
    } catch (e) {
      await Promise.all([loadModels(), loadChats()]);
    }
  } catch (e) {
    if (e.code === 401) {
      return showFatal('Telegram не подтвердил сессию или тебя нет в списке ' +
        'доступа. Открой приложение заново из чата с ботом.');
    }
    return showFatal('Не удалось связаться с ботом: ' + e.message +
      '. Проверь интернет и попробуй ещё раз.');
  }
  $('#boot').hidden = true;
  $('#head').hidden = false;
  $('#composer').hidden = false;
  $('#messages').hidden = false;
  buildQuickActions();
  $('#btn-chats').onclick = () => { haptic('light'); openSheet('#chats-sheet'); };
  $('#btn-model').onclick = () => { haptic('light'); openSheet('#model-sheet'); };
  /* правая кнопка хедера: инфо о данных → меню чата */
  $('#btn-ctx').onclick = () => {
    haptic('light');
    if (state.current && state.current.messages.length) openChatMenu();
    else openSheet('#data-sheet');
  };
  $('#btn-new').onclick = () => {
    haptic('light');
    closeSheets();
    const def = state.models.find((m) => m.available) || state.models[0] || {};
    createChatOptimistic(def.provider || '', def.model || '');
  };
  document.querySelectorAll('.sheet-back, .sheet-close').forEach(el => {
    el.onclick = closeSheets;
  });
  const cta = $('#btn-start-cta');
  if (cta) cta.onclick = () => { haptic('light'); openSheet('#model-sheet'); };
  $('#btn-send').onclick = () => {
    if (state.busy) {
      haptic('light');
      if (state.abortCtl) state.abortCtl.abort();
    } else {
      send();
    }
  };
  const fileInput = $('#file-input');
  $('#btn-attach').onclick = () => fileInput.click();
  $('#attach-remove').onclick = () => clearAttach();
  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (f) compressImage(f);
  });
  const input = $('#input');
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  /* ---- drawer ---- */
  $('#btn-settings').onclick = () => { haptic('light'); openSheet('#settings-sheet'); };
  $('#btn-find-global').onclick = () => {
    const f = $('#drawer-filter');
    f.hidden = !f.hidden;
    if (!f.hidden) f.focus();
    else { state.chatFilter = ''; f.value = ''; renderChatsList(); }
  };
  $('#drawer-filter').addEventListener('input', (e) => {
    state.chatFilter = e.target.value;
    renderChatsList();
  });
  document.querySelectorAll('.soon-nav').forEach((el) => {
    el.onclick = () => {
      haptic('light');
      warn((el.dataset.soon || 'Раздел') + ' — появится в следующем обновлении.');
    };
  });

  /* ---- настройки ---- */
  $('#set-theme').onclick = () => {
    const i = THEMES.findIndex((t) => t[0] === state.theme);
    state.theme = THEMES[(i + 1) % THEMES.length][0];
    applyPrefs(); savePrefs(); renderSettings(); hapticSel();
  };
  $('#set-accent').onclick = () => {
    const i = ACCENTS.findIndex((a) => a[0] === state.accent);
    state.accent = ACCENTS[(i + 1) % ACCENTS.length][0];
    applyPrefs(); savePrefs(); renderSettings(); hapticSel();
  };
  $('#set-model').onclick = () => { closeSheets(); openSheet('#model-sheet'); };
  $('#set-haptics').onclick = () => {
    state.haptics = !state.haptics;
    savePrefs(); renderSettings(); hapticSel();
  };
  $('#set-data').onclick = () => { closeSheets(); openSheet('#data-sheet'); };
  $('#data-ok').onclick = () => { haptic('light'); closeSheets(); };
  const wipe = $('#btn-wipe');
  const wipeLabel = wipe.querySelector('span');
  wipe.onclick = async () => {
    if (!wipe.dataset.arm) {
      wipe.dataset.arm = '1';
      wipeLabel.textContent = 'точно стереть? нажми ещё раз';
      clearTimeout(wipe._t);
      wipe._t = setTimeout(() => {
        wipe.dataset.arm = '';
        wipeLabel.textContent = 'Стереть мою историю';
      }, 3000);
      return;
    }
    wipe.dataset.arm = '';
    clearTimeout(wipe._t);
    wipeLabel.textContent = 'Стереть мою историю';
    try {
      await api('DELETE', '/api/chats');
      state.chats = [];
      state.current = null;
      updateHead();
      paintMessages();
      renderChatsList();
      closeSheets();
      warn('Вся моя история удалена с сервера.');
    } catch (e) {
      warn('Не удалось удалить историю: ' + e.message);
    }
  };

  /* ---- меню чата ---- */
  $('#menu-scrim').onclick = closeChatMenu;
  $('#cm-share').onclick = () => { closeChatMenu(); shareText(chatDigest()); };
  $('#cm-pin').onclick = () => {
    const id = state.current && state.current.id;
    if (!id) return closeChatMenu();
    const i = state.pins.indexOf(id);
    if (i >= 0) state.pins.splice(i, 1); else state.pins.push(id);
    savePrefs(); renderChatsList(); closeChatMenu(); hapticSel();
  };
  $('#cm-project').onclick = () => {
    closeChatMenu();
    warn('Проекты — скоро. Допилим в следующем обновлении.');
  };
  $('#cm-files').onclick = () => { closeChatMenu(); openFilesSheet(); };
  $('#cm-find').onclick = () => { closeChatMenu(); openFindSheet(); };
  $('#cm-archive').onclick = () => {
    closeChatMenu();
    warn('Архив — скоро. Допилим в следующем обновлении.');
  };
  $('#cm-delete').onclick = () => {
    closeChatMenu();
    const id = state.current && state.current.id;
    if (!id) return;
    const yes = tg && tg.showConfirm
      ? tg.showConfirm('Удалить этот чат?')
      : window.confirm('Удалить этот чат?');
    Promise.resolve(yes).then((ok) => {
      if (!ok) return;
      deleteChat(id).catch((e) => warn('Не удалось удалить чат: ' + e.message));
    });
  };

  /* ---- поиск в чате ---- */
  $('#find-input').addEventListener('input', (e) => renderFind(e.target.value));

  if (state.chats.length) {
    try { await openChat(state.chats[0].id); } catch (e) { paintMessages(); }
  } else {
    updateHead();
    paintMessages();
  }
  loadQuota();
  /* «тёплый» пинг Render: лёгкий запрос раз в 4 минуты, чтобы бесплатная
     инстанса не засыпала между вопросами и не подвисала на холоде.
     Идём через api(), а не голым fetch(): так с запросом уходит initData,
     сервер отвечает 200 вместо 401, и заодно обновляется счётчик квоты. */
  setInterval(() => {
    if (INIT_DATA && !state.busy) loadQuota();
  }, 240000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
