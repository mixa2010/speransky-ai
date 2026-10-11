/* Категории и список моделей в шторке выбора. Выделено из app.js; загружается до app.js
   и разделяет с ним глобальную область (обычный скрипт). */
'use strict';
const CATS = [
  { id: 'text', title: 'Текстовые и задачи', short: 'Текст', icon: 'catText' },
  { id: 'code', title: 'Коддинг', short: 'Код', icon: 'catCode',
    filter: /code|coder|codestral|leanstral|coder480b/i },
  { id: 'image', title: 'Генерация изображений', short: 'Картинки',
    icon: 'catImage', soon: true },
  { id: 'video', title: 'Генерация видео', short: 'Видео', icon: 'catVideo', soon: true },
];

function modelRow(m) {
  const mine = !!(state.current && state.current.provider === m.provider &&
    state.current.model === m.model);
  const row = document.createElement('div');
  row.className = 'model-row ' + (m.state || 'ok') + (mine ? ' active' : '');
  const t = document.createElement('div');
  t.className = 'model-row-title';
  t.innerHTML = logoHtml(m.provider) + ' ' + esc(m.model) +
    (mine ? '<span class="mr-check" aria-label="выбрана">' + IC.check + '</span>' : '') +
    (m.vision ? ' <span class="vis-dot" title="понимает фото"></span>' : '');
  const s2 = document.createElement('div');
  s2.className = 'model-row-sub';
  s2.textContent = m.provider + ' · ' + (STATE_RU[m.state] || m.state);
  const dot = document.createElement('span');
  dot.className = 'st-dot st-' + (m.state || 'ok');
  dot.title = STATE_TT[m.state] || 'Статус неизвестен';
  dot.setAttribute('aria-label', dot.title);
  row.onclick = () => {
    hapticSel();
    closeSheets();                       // мгновенно, не ждём сервер
    if (state.current) {
      state.current.provider = m.provider;
      state.current.model = m.model;
      updateHead();                      // чип обновляется сразу
      saveChatModel(state.current);      // сохранение — в фоне
    } else {
      createChatOptimistic(m.provider, m.model);
    }
  };
  row.appendChild(t); row.appendChild(dot); row.appendChild(s2);
  return row;
}

/* Вкладки категорий: Текст / Код / Картинки / Видео */
function renderModelTabs() {
  const box = $('#model-tabs');
  if (!box) return;
  box.innerHTML = '';
  for (const cat of CATS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cat-tab' + (state.modelTab === cat.id ? ' active' : '') +
                  (cat.soon ? ' soon' : '');
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', state.modelTab === cat.id ? 'true' : 'false');
    b.innerHTML = (IC[cat.icon] || '') + '<span>' + esc(cat.short) + '</span>' +
      (cat.soon ? '<i class="tab-lock">' + IC.lock + '</i>' : '');
    b.onclick = () => {
      if (state.modelTab === cat.id) return;
      state.modelTab = cat.id;
      /* переход по вкладкам сбрасывает поиск — иначе список «залипает» */
      state.modelQuery = '';
      const ms = $('#model-search');
      const mc = $('#model-search-clear');
      if (ms) ms.value = '';
      if (mc) mc.hidden = true;
      haptic('light');
      renderModelTabs();
      renderModelsList();
    };
    box.appendChild(b);
  }
}

function renderModelsList() {
  const box = $('#models-list');
  box.innerHTML = '';
  const cat = CATS.find((c) => c.id === state.modelTab) || CATS[0];
  const q = (state.modelQuery || '').trim().toLowerCase();
  /* пока сервер не отдал список — показываем скелетон, а не пустоту */
  if (!state.models.length && !cat.soon) {
    if (!state.booted) {
      for (let i = 0; i < 4; i++) {
        const sk = document.createElement('div');
        sk.className = 'sk-row';
        box.appendChild(sk);
      }
    } else {
      const none = document.createElement('div');
      none.className = 'sheet-empty';
      none.textContent = 'Сервер не вернул список моделей. Закрой шторку и попробуй ещё раз.';
      box.appendChild(none);
    }
    return;
  }
  /* поиск ищет по всем категориям — так быстрее найти нужную модель */
  if (q) {
    const found = state.models.filter((m) =>
      String(m.model || '').toLowerCase().includes(q) ||
      String(m.provider || '').toLowerCase().includes(q));
    const note = document.createElement('div');
    note.className = 'soon-row';
    note.textContent = found.length
      ? 'Поиск по всем категориям' : 'Ничего не нашлось — попробуй другое название.';
    box.appendChild(note);
    const sorted = found.slice().sort((a, b) =>
      (STATE_RANK[a.state] ?? 3) - (STATE_RANK[b.state] ?? 3));
    for (const m of sorted) box.appendChild(modelRow(m));
    box.querySelectorAll('.model-row').forEach((el, i) => {
      el.classList.add('tab-in');
      el.style.animationDelay = Math.min(i * 22, 220) + 'ms';
    });
    return;
  }
  if (cat.soon) {
    const soon = document.createElement('div');
    soon.className = 'soon-tile soon-tile-big tab-in';
    soon.innerHTML = '<span class="soon-tile-ico">' + (IC[cat.icon] || '') + '</span>' +
      '<span class="soon-tile-tx"><b>' + esc(cat.title) + '</b>' +
      '<small>в разработке — появится в следующих обновлениях</small></span>' +
      '<span class="soon-badge">' + IC.lock + ' скоро</span>';
    box.appendChild(soon);
    return;
  }
  const sorted = state.models.slice().sort((a, b) =>
    (STATE_RANK[a.state] ?? 3) - (STATE_RANK[b.state] ?? 3));
  // категория с фильтром — свои модели; без фильтра — все, кроме
  // попавших в другие категории (иначе кодинг-модели дублируются)
  const list = cat.filter
    ? sorted.filter((m) => cat.filter.test(m.model))
    : sorted.filter((m) => !CATS.some((c) => c.filter && c.filter.test(m.model)));
  if (!list.length) {
    const none = document.createElement('div');
    none.className = 'soon-row';
    none.textContent = 'В этой категории пока нет доступных моделей.';
    box.appendChild(none);
    return;
  }
  for (const m of list) box.appendChild(modelRow(m));
  // мягкое появление списка при смене вкладки
  box.querySelectorAll('.model-row').forEach((el, i) => {
    el.classList.add('tab-in');
    el.style.animationDelay = Math.min(i * 22, 220) + 'ms';
  });
}

/* ================= оверлеи ================= */
