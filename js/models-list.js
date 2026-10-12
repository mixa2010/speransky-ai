/* Model categories and chooser rows. Text labels are resolved through i18n.js. */
'use strict';
const CATS = [
  { id: 'text', title: 'model.cat.textTitle', short: 'model.cat.text', icon: 'catText' },
  { id: 'code', title: 'model.cat.codeTitle', short: 'model.cat.code', icon: 'catCode',
    filter: /code|coder|codestral|leanstral|coder480b/i },
  { id: 'image', title: 'model.cat.imagesTitle', short: 'model.cat.images',
    icon: 'catImage', soon: true },
  { id: 'video', title: 'model.cat.videoTitle', short: 'model.cat.video', icon: 'catVideo', soon: true },
];

function modelRow(m) {
  const mine = !!(state.current && state.current.provider === m.provider &&
    state.current.model === m.model);
  const row = document.createElement('div');
  row.className = 'model-row ' + (m.state || 'ok') + (mine ? ' active' : '');
  const titleEl = document.createElement('div');
  titleEl.className = 'model-row-title';
  titleEl.innerHTML = logoHtml(m.provider) + ' ' + esc(m.model) +
    (mine ? '<span class="mr-check" aria-label="' + esc(t('model.selected')) + '">' + IC.check + '</span>' : '') +
    (m.vision ? ' <span class="vis-dot" title="' + esc(t('model.understandsPhoto')) + '"></span>' : '');
  const s2 = document.createElement('div');
  s2.className = 'model-row-sub';
  s2.textContent = m.provider + ' · ' + modelStateLabel(m.state);
  const dot = document.createElement('span');
  dot.className = 'st-dot st-' + (m.state || 'ok');
  dot.title = modelStateTitle(m.state);
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
  row.appendChild(titleEl); row.appendChild(dot); row.appendChild(s2);
  return row;
}

/* Category tabs: text / code / images / video. */
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
    b.setAttribute('aria-label', t(cat.title));
    b.innerHTML = (IC[cat.icon] || '') + '<span>' + esc(t(cat.short)) + '</span>' +
      (cat.soon ? '<i class="tab-lock">' + IC.lock + '</i>' : '');
    b.onclick = () => {
      if (state.modelTab === cat.id) return;
      state.modelTab = cat.id;
      /* Switching tabs clears search so results never look stuck. */
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
  /* Show a skeleton while the server is still loading the model catalogue. */
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
      none.textContent = t('model.noneFromServer');
      box.appendChild(none);
    }
    return;
  }
  /* Search across every category so users can find a model quickly. */
  if (q) {
    const found = state.models.filter((m) =>
      String(m.model || '').toLowerCase().includes(q) ||
      String(m.provider || '').toLowerCase().includes(q));
    const note = document.createElement('div');
    note.className = 'soon-row';
    note.textContent = found.length ? t('model.searchAll') : t('model.searchNone');
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
      '<span class="soon-tile-tx"><b>' + esc(t(cat.title)) + '</b>' +
      '<small>' + esc(t('model.inDevelopment')) + '</small></span>' +
      '<span class="soon-badge">' + IC.lock + ' ' + esc(t('model.soon')) + '</span>';
    box.appendChild(soon);
    return;
  }
  const sorted = state.models.slice().sort((a, b) =>
    (STATE_RANK[a.state] ?? 3) - (STATE_RANK[b.state] ?? 3));
  // A filtered category gets its own models; other categories omit those rows.
  const list = cat.filter
    ? sorted.filter((m) => cat.filter.test(m.model))
    : sorted.filter((m) => !CATS.some((c) => c.filter && c.filter.test(m.model)));
  if (!list.length) {
    const none = document.createElement('div');
    none.className = 'soon-row';
    none.textContent = t('model.noneInCategory');
    box.appendChild(none);
    return;
  }
  for (const m of list) box.appendChild(modelRow(m));
  // Smoothly reveal rows when switching tabs.
  box.querySelectorAll('.model-row').forEach((el, i) => {
    el.classList.add('tab-in');
    el.style.animationDelay = Math.min(i * 22, 220) + 'ms';
  });
}
