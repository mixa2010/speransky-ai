/* Model categories and chooser rows. Text labels are resolved through i18n.js. */
'use strict';
const CODE_MODEL_RE = /code|coder|codestral|leanstral|coder480b/i;
const MAX_RECOMMENDED_MODELS = 4;
const CATS = [
  { id: 'recommended', title: 'model.cat.recommendedTitle', short: 'model.cat.recommended', icon: 'bulb' },
  { id: 'all', title: 'model.cat.allTitle', short: 'model.cat.all', icon: 'catText' },
  { id: 'code', title: 'model.cat.codeTitle', short: 'model.cat.code', icon: 'catCode',
    filter: CODE_MODEL_RE },
  { id: 'image', title: 'model.cat.imagesTitle', short: 'model.cat.images',
    icon: 'catImage', soon: true },
  { id: 'video', title: 'model.cat.videoTitle', short: 'model.cat.video', icon: 'catVideo', soon: true },
];

function modelSelectable(m) {
  return !!m && m.available !== false && String(m.state || '').toLowerCase() !== 'dead';
}

function modelDisplayState(m) {
  const state = String(m && m.state || '').toLowerCase();
  if (state === 'dead') return 'dead';
  if (m && m.available === false) return 'unavailable';
  return state || 'unknown';
}

function sortModels(models) {
  return (Array.isArray(models) ? models : []).slice().sort((a, b) => {
    const unavailable = Number(!modelSelectable(a)) - Number(!modelSelectable(b));
    if (unavailable) return unavailable;
    const recommended = Number(b && b.recommended === true) - Number(a && a.recommended === true);
    if (recommended) return recommended;
    return (STATE_RANK[modelDisplayState(a)] ?? 5) -
           (STATE_RANK[modelDisplayState(b)] ?? 5);
  });
}

function recommendedModels() {
  return sortModels(state.models).filter(modelSelectable).slice(0, MAX_RECOMMENDED_MODELS);
}

function getDefaultModel() {
  return sortModels(state.models).find(modelSelectable) || {};
}

function modelRow(m) {
  const mine = !!(state.current && state.current.provider === m.provider &&
    state.current.model === m.model);
  const selectable = modelSelectable(m);
  const status = modelDisplayState(m);
  const statusClass = !selectable ? 'dead' :
    (STATE_RANK[status] !== undefined ? status : 'unknown');
  const row = document.createElement('button');
  row.type = 'button';
  row.disabled = !selectable;
  row.setAttribute('aria-pressed', mine ? 'true' : 'false');
  row.title = modelStateTitle(status);
  row.className = 'model-row ' + statusClass + (mine ? ' active' : '');

  const titleEl = document.createElement('span');
  titleEl.className = 'model-row-title';
  titleEl.innerHTML = logoHtml(m.provider);
  const name = document.createElement('span');
  name.className = 'model-name';
  name.textContent = String(m.model || '');
  titleEl.appendChild(name);
  if (mine) {
    const check = document.createElement('span');
    check.className = 'mr-check';
    check.setAttribute('aria-label', t('model.selected'));
    check.innerHTML = IC.check;
    titleEl.appendChild(check);
  }
  if (m.vision) {
    const capability = document.createElement('span');
    capability.className = 'model-capability';
    capability.textContent = t('model.understandsPhoto');
    capability.title = t('model.understandsPhoto');
    titleEl.appendChild(capability);
  }

  const sub = document.createElement('span');
  sub.className = 'model-row-sub';
  sub.textContent = String(m.provider || '') + ' · ' + modelStateLabel(status);
  const dot = document.createElement('span');
  dot.className = 'st-dot st-' + statusClass;
  dot.title = modelStateTitle(status);
  dot.setAttribute('aria-hidden', 'true');
  row.onclick = () => {
    if (!selectable || blockDuringSend()) return;
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
  row.appendChild(titleEl);
  row.appendChild(dot);
  row.appendChild(sub);
  return row;
}

/* Category tabs: recommendations, full catalogue, code, image and video. */
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
    b.setAttribute('aria-controls', 'models-list');
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
    for (const m of sortModels(found)) box.appendChild(modelRow(m));
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
  if (cat.id === 'recommended') {
    const note = document.createElement('div');
    note.className = 'model-recommend-hint';
    note.textContent = t('model.recommendedHint');
    box.appendChild(note);
    const picks = recommendedModels();
    if (!picks.length) {
      const none = document.createElement('div');
      none.className = 'sheet-empty';
      none.textContent = t('model.noneAvailable');
      box.appendChild(none);
      return;
    }
    for (const m of picks) box.appendChild(modelRow(m));
    return;
  }

  const sorted = sortModels(state.models);
  const list = cat.filter
    ? sorted.filter((m) => cat.filter.test(String(m.model || '')))
    : sorted;
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
