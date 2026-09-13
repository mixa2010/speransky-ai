/* ============================================================
   Сперанский AI — Mini App v2: полноценный ИИ-клиент.
   Чаты (история на сервере), выбор модели, диалог с красивым
   рендером формул (KaTeX) и markdown.

   Безопасность: страница не знает ключей API; каждый запрос к
   Render несёт Telegram initData, подпись проверяется сервером.
   ============================================================ */
'use strict';

const DEFAULT_API = 'https://homework-bot-6h3b.onrender.com';
const _params = new URLSearchParams(location.search);
const API_BASE = (_params.get('api') || DEFAULT_API).replace(/\/+$/, '');
const tg = (window.Telegram && window.Telegram.WebApp) ? window.Telegram.WebApp : null;
const INIT_DATA = (tg && tg.initData) || _params.get('initData') || '';

const $ = (s) => document.querySelector(s);

/* ---------- логотипы провайдеров (инлайн-SVG, без внешних файлов) ---------- */
const LOGOS = {
  gemini: '<svg viewBox="0 0 16 16"><path d="M8 0l1.9 6.1L16 8l-6.1 1.9L8 16 6.1 9.9 0 8l6.1-1.9z" fill="#4E86FF"/></svg>',
  groq: '<svg viewBox="0 0 16 16"><rect width="16" height="16" rx="4" fill="#F55036"/><path d="M9.2 2L4.5 9h2.6l-.9 5 4.9-7H8.4z" fill="#fff"/></svg>',
  openrouter: '<svg viewBox="0 0 16 16"><rect width="16" height="16" rx="4" fill="#6549E5"/><path d="M4 6h6l-2-2m4 6H6l2 2" stroke="#fff" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>',
  huggingface: '<svg viewBox="0 0 16 16"><rect width="16" height="16" rx="4" fill="#FFD21E"/><circle cx="6" cy="6.5" r="1" fill="#333"/><circle cx="10" cy="6.5" r="1" fill="#333"/><path d="M5 9.5q3 2.6 6 0" stroke="#333" stroke-width="1.2" fill="none" stroke-linecap="round"/></svg>',
  mistral: '<svg viewBox="0 0 16 16"><rect width="16" height="16" rx="4" fill="#111"/><rect x="3" y="4" width="3" height="2.4" fill="#fff"/><rect x="6.5" y="4" width="3" height="2.4" fill="#F55036"/><rect x="6.5" y="6.8" width="3" height="2.4" fill="#fff"/><rect x="10" y="6.8" width="3" height="2.4" fill="#F55036"/><rect x="3" y="9.6" width="3" height="2.4" fill="#F55036"/></svg>',
  github: '<svg viewBox="0 0 16 16"><rect width="16" height="16" rx="4" fill="#24292F"/><circle cx="8" cy="9" r="3.4" fill="#fff"/><path d="M5.4 5.6l1-1.6m4.2 1.6l-1-1.6" stroke="#fff" stroke-width="1.2" stroke-linecap="round"/></svg>',
};
const LOGO_FILES = { gemini: 1, groq: 1, openrouter: 1, huggingface: 1,
                      mistral: 1, github: 1 };
function logoHtml(provider) {
  if (LOGO_FILES[provider]) {
    return `<img class="plogo" data-p="${provider}" src="logo-${provider}.png" alt="">`;
  }
  return logoSvg(provider);
}
/* если картинка логотипа не загрузилась — бесшовно ставим SVG-запаску */
document.addEventListener('error', (e) => {
  const t = e.target;
  if (t && t.classList && t.classList.contains('plogo')) {
    const span = document.createElement('span');
    span.innerHTML = logoSvg(t.dataset.p);
    const svg = span.firstChild;
    if (svg) { svg.classList.add('plogo'); t.replaceWith(svg); }
  }
}, true);

function logoSvg(provider) {
  return LOGOS[provider] ||
    ('<svg viewBox="0 0 16 16"><rect width="16" height="16" rx="4" fill="#8891a0"/>' +
     '<text x="8" y="11.5" font-size="9" text-anchor="middle" fill="#fff" ' +
     'font-family="sans-serif">' + String(provider || '?').charAt(0).toUpperCase() + '</text></svg>');
}
const FALL_REASON = {
  rate: 'кончился лимит',
  cooldown: 'на кулдауне',
  error: 'сбой',
  unfit: 'не подходит',
  empty: 'пустой ответ',
};

const state = {
  models: [],
  chats: [],
  current: null,          // {id, title, provider, model, messages: []}
  busy: false,
};

/* ================= Telegram ================= */
function tgInit() {
  if (!tg) return;
  try {
    tg.ready();
    tg.expand();
    if (tg.setHeaderColor) tg.setHeaderColor('bg_color');
    if (tg.disableVerticalSwapes) tg.disableVerticalSwapes();
    if (tg.disableVerticalSwipes) tg.disableVerticalSwipes();
  } catch (e) { /* вне Telegram */ }
}

/* ================= сеть ================= */
async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  const payload = body ? Object.assign({}, body) : {};
  if (method !== 'GET' && method !== 'DELETE') payload.initData = INIT_DATA;
  let url = API_BASE + path;
  if (method === 'GET' || method === 'DELETE') {
    url += (path.includes('?') ? '&' : '?') +
           'initData=' + encodeURIComponent(INIT_DATA);
  }
  if (method !== 'GET') opts.body = JSON.stringify(payload);
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    throw Object.assign(new Error('unauthorized'), { code: 401 });
  }
  if (!res.ok) {
    throw Object.assign(new Error(data.error || ('HTTP ' + res.status)),
                        { code: res.status });
  }
  return data;
}

/* ================= рендер текста (из v1) ================= */
const UNICODE_MAP = [
  [/\\iff\b/g, ' ⇔ '], [/\\Leftrightarrow\b/g, ' ⇔ '],
  [/\\Rightarrow\b/g, ' ⇒ '], [/\\implies\b/g, ' ⇒ '],
  [/\\longrightarrow\b/g, ' ⟶ '], [/\\rightarrow\b/g, ' → '],
  [/\\to\b/g, ' → '], [/\\leftarrow\b/g, ' ← '],
  [/\\cdot\b/g, '·'], [/\\times\b/g, '×'], [/\\div\b/g, '÷'],
  [/\\approx\b/g, '≈'], [/\\pm\b/g, '±'], [/\\mp\b/g, '∓'],
  [/\\infty\b/g, '∞'], [/\\propto\b/g, '∝'], [/\\equiv\b/g, '≡'],
  [/\\neq\b/g, '≠'], [/\\ne\b/g, '≠'],
  [/\\leqslant\b/g, '≤'], [/\\leq\b/g, '≤'], [/\\le\b/g, '≤'],
  [/\\geqslant\b/g, '≥'], [/\\geq\b/g, '≥'], [/\\ge\b/g, '≥'],
  [/\\ll\b/g, '≪'], [/\\gg\b/g, '≫'], [/\\cong\b/g, '≅'],
  [/\\sim\b/g, '∼'], [/\\perp\b/g, '⊥'], [/\\parallel\b/g, '∥'],
  [/\\angle\b/g, '∠'], [/\\triangle\b/g, '△'],
  [/\\downarrow\b/g, '↓'], [/\\uparrow\b/g, '↑'],
];
const GREEK = {
  alpha:'α', beta:'β', gamma:'γ', delta:'δ', epsilon:'ε', varepsilon:'ε',
  zeta:'ζ', eta:'η', theta:'θ', vartheta:'θ', iota:'ι', kappa:'κ',
  lambda:'λ', mu:'μ', nu:'ν', xi:'ξ', pi:'π', rho:'ρ', varrho:'ρ',
  sigma:'σ', tau:'τ', upsilon:'υ', phi:'φ', varphi:'φ', chi:'χ', psi:'ψ',
  omega:'ω', Gamma:'Γ', Delta:'Δ', Theta:'Θ', Lambda:'Λ', Xi:'Ξ', Pi:'Π',
  Sigma:'Σ', Phi:'Φ', Psi:'Ψ', Omega:'Ω',
  partial:'∂', nabla:'∇', in:'∈', notin:'∉', subset:'⊂', supset:'⊃',
  subseteq:'⊆', cup:'∪', cap:'∩', emptyset:'∅', forall:'∀', exists:'∃',
  circ:'°', degree:'°', ldots:'…', dots:'…', cdots:'⋯',
};
const DECOR = 'vec|hat|bar|dot|ddot|widetilde|widehat|overline|underline|' +
  'mathbf|mathrm|text|mathit|textbf|emph|operatorname|bm|boldsymbol';

function stripLatex(src) {
  let t = String(src == null ? '' : src);
  for (const [re, rep] of UNICODE_MAP) t = t.replace(re, rep);
  for (const cmd of Object.keys(GREEK)) {
    t = t.replace(new RegExp('\\\\' + cmd + '\\b', 'g'), GREEK[cmd]);
  }
  const decor = new RegExp('\\\\(?:' + DECOR + ')\\{([^{}]*)\\}', 'g');
  for (let i = 0; i < 3; i++) t = t.replace(decor, '$1');
  const FRAC = /\\[d]?frac\{((?:[^{}]|\{[^{}]*\})+)\}\{((?:[^{}]|\{[^{}]*\})+)\}/g;
  for (let i = 0; i < 4; i++) {
    t = t.replace(FRAC, (m, a, b) =>
      (/[+\-]/.test(a) || /[+\-]/.test(b)) ? `(${a})/(${b})` : `${a}/${b}`);
  }
  t = t.replace(/\\sqrt\[([^{}\]]+)\]\{([^{}]+)\}/g, '$2^(1/$1)');
  t = t.replace(/\\sqrt\{([^{}]+)\}/g, (m, a) => a.length > 1 ? `√(${a})` : `√${a}`);
  t = t.replace(/\^\{([^{}]+)\}/g, '^$1');
  t = t.replace(/_\{([^{}]+)\}/g, '_$1');
  t = t.replace(/\\left|\\right/g, '');
  t = t.replace(/\\[()[\]]/g, '');
  t = t.replace(/\$\$?([^$]+)\$\$?/g, '$1');
  t = t.replace(/\\([,;!:])/g, '$1');
  t = t.replace(/\\,/g, ' ');
  t = t.replace(/\\;/g, '  ');
  t = t.replace(/\\quad|\\qquad|\\enspace/g, '  ');
  t = t.replace(/\\([a-zA-Z]+)/g, '$1');
  t = t.replace(/[{}]/g, '');
  return t.replace(/[ \t]+$/gm, '').trim();
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
                  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function miniMarkdown(src) {
  const lines = String(src).split('\n');
  const out = [];
  let list = null, quote = [], code = null, para = [];
  const flushPara = () => {
    if (para.length) { out.push('<p>' + inline(para.join('\n')) + '</p>'); para = []; }
  };
  const flushQuote = () => {
    if (quote.length) {
      out.push('<blockquote>' + miniMarkdown(quote.join('\n')) + '</blockquote>');
      quote = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push(`<${list.tag}>` + list.items.map(i => `<li>${inline(i)}</li>`).join('') + `</${list.tag}>`);
      list = null;
    }
  };
  const flushAll = () => { flushPara(); flushQuote(); flushList(); };
  function inline(s) {
    let r = esc(s);
    r = r.replace(/`([^`]+)`/g, '<code>$1</code>');
    r = r.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    r = r.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    r = r.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    r = r.replace(/_([^_\n]+)_/g, '<em>$1</em>');
    r = r.replace(/\n/g, '<br>');
    return r;
  }
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (/^```/.test(line)) {
      if (code === null) { flushAll(); code = []; }
      else { out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>'); code = null; }
      continue;
    }
    if (code !== null) { code.push(raw); continue; }
    if (!line.trim()) { flushAll(); continue; }
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      flushAll();
      const lvl = m[1].length;
      out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`);
      continue;
    }
    if (/^(\*\*\*|---|___)\s*$/.test(line)) { flushAll(); out.push('<hr>'); continue; }
    if ((m = line.match(/^>\s?(.*)$/))) { flushPara(); flushList(); quote.push(m[1]); continue; }
    if ((m = line.match(/^\s*[-*+•]\s+(.*)$/))) {
      flushPara(); flushQuote();
      if (!list || list.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; }
      list.items.push(m[1]); continue;
    }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushPara(); flushQuote();
      if (!list || list.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] }; }
      list.items.push(m[1]); continue;
    }
    flushQuote(); flushList();
    para.push(line);
  }
  if (code !== null) out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>');
  flushAll();
  return out.join('\n');
}

const MATH_PREFIX = 'zzmathzz';
function extractMath(text) {
  const store = [];
  const put = (tex, display) => {
    store.push({ tex, display });
    return `${MATH_PREFIX}${store.length - 1}zz`;
  };
  let t = String(text);
  t = t.replace(/\\begin\{(equation\*?|align\*?|gather\*?|cases|array|matrix|pmatrix|bmatrix)\}[\s\S]*?\\end\{\1\}/g,
                (m) => put(m, true));
  t = t.replace(/\$\$([\s\S]+?)\$\$/g, (m, a) => put(a.trim(), true));
  t = t.replace(/\\\[([\s\S]+?)\\\]/g, (m, a) => put(a.trim(), true));
  t = t.replace(/\\\(([\s\S]+?)\\\)/g, (m, a) => put(a.trim(), false));
  t = t.replace(/(^|[^\\$])\$([^$\n]+?)\$/g, (m, pre, a) => pre + put(a.trim(), false));
  return { text: t, store };
}

function katexReady() {
  return typeof window.katex !== 'undefined' && window.katex &&
         typeof window.katex.render === 'function';
}

function buildMath(item, hasKatex) {
  if (!item) return document.createTextNode('');
  if (item.display) {
    const div = document.createElement('div');
    div.className = 'math-block';
    if (hasKatex) {
      const span = document.createElement('span');
      try {
        window.katex.render(item.tex, span, { displayMode: true, throwOnError: false, strict: 'ignore' });
        div.appendChild(span);
        return div;
      } catch (e) { /* текст */ }
    }
    div.textContent = stripLatex(item.tex);
    return div;
  }
  if (hasKatex) {
    const span = document.createElement('span');
    try {
      window.katex.render(item.tex, span, { displayMode: false, throwOnError: false, strict: 'ignore' });
      return span;
    } catch (e) { /* текст */ }
  }
  return document.createTextNode(stripLatex(item.tex));
}

function renderMathInto(root, store) {
  const hasKatex = katexReady();
  const re = new RegExp(MATH_PREFIX + '(\\d+)zz', 'g');
  const nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  for (const node of nodes) {
    if (!node.parentNode) continue;
    re.lastIndex = 0;
    if (!re.test(node.nodeValue)) continue;
    re.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0, m;
    while ((m = re.exec(node.nodeValue))) {
      if (m.index > last) frag.appendChild(document.createTextNode(node.nodeValue.slice(last, m.index)));
      frag.appendChild(buildMath(store[parseInt(m[1], 10)], hasKatex));
      last = m.index + m[0].length;
    }
    if (last < node.nodeValue.length) frag.appendChild(document.createTextNode(node.nodeValue.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
}

function scrubLatexLeftovers(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  for (const node of nodes) {
    if (!node.nodeValue || !/\\[a-zA-Z]/.test(node.nodeValue)) continue;
    const p = node.parentElement;
    if (p && p.closest('pre, code, .katex')) continue;
    const cleaned = stripLatex(node.nodeValue);
    if (cleaned !== node.nodeValue) node.nodeValue = cleaned;
  }
}

function renderRich(container, text) {
  const math = extractMath(text);
  let html;
  const hasMarked = typeof window.marked !== 'undefined' && window.marked;
  if (hasMarked) {
    try {
      if (window.marked.setOptions) window.marked.setOptions({ breaks: true, gfm: true });
      html = (window.marked.parse || window.marked)(math.text);
    } catch (e) { html = miniMarkdown(math.text); }
  } else {
    html = miniMarkdown(math.text);
  }
  container.innerHTML = html;
  renderMathInto(container, math.store);
  scrubLatexLeftovers(container);
  if (!hasMarked || !katexReady()) container.classList.add('plain');
}

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
  $('#head-title').textContent = state.current ? state.current.title : 'Новый чат';
  const chip = $('#btn-model');
  chip.textContent = (state.current ? shortModel(state.current.model) : 'модель') + ' ▾';
}

function scrollBottom() {
  const m = $('#messages');
  requestAnimationFrame(() => { m.scrollTop = m.scrollHeight; });
}

function fallbackLine(fallbacks, finalProvider, finalModel) {
  const row = document.createElement('div');
  row.className = 'fall-line';
  for (const f of (fallbacks || [])) {
    const chip = document.createElement('span');
    chip.className = 'fall-chip';
    chip.innerHTML = logoHtml(f.provider) + ' ' + esc(shortModel(f.model)) +
      ' · ' + esc(FALL_REASON[f.code] || f.code);
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
  if (role !== 'user' && opts.fallbacks && opts.fallbacks.length) {
    wrap.appendChild(fallbackLine(opts.fallbacks, opts.provider, opts.model));
  }
  const bubble = document.createElement('div');
  bubble.className = 'bubble' + (opts.pending ? ' pending' : '');
  if (role === 'user') {
    bubble.textContent = text;
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
  $('#messages').appendChild(wrap);
  scrollBottom();
  return bubble;
}

function paintMessages() {
  const box = $('#messages');
  box.innerHTML = '';
  const msgs = state.current ? state.current.messages : [];
  $('#empty').hidden = msgs.length > 0;
  box.hidden = false;
  for (const m of msgs) addMessageEl(m.role, m.content, m);
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
  if (!state.chats.length) {
    box.innerHTML = '<div class="sheet-empty">Чатов пока нет — нажми ✚ сверху.</div>';
    return;
  }
  for (const c of state.chats) {
    const row = document.createElement('div');
    row.className = 'chat-row' + (state.current && state.current.id === c.id ? ' active' : '');
    const t = document.createElement('div');
    t.className = 'chat-row-title';
    t.textContent = c.title || 'Чат';
    const s = document.createElement('div');
    s.className = 'chat-row-sub';
    s.textContent = shortModel(c.model) + ' · ' + String(c.updated_at || '').slice(5, 16);
    const del = document.createElement('button');
    del.className = 'icon-btn chat-del';
    del.textContent = '✕';
    del.onclick = (e) => {
      e.stopPropagation();
      if (del.dataset.arm) { deleteChat(c.id); }
      else { del.dataset.arm = '1'; del.textContent = 'точно?'; del.classList.add('armed'); }
    };
    row.onclick = () => openChat(c.id);
    row.appendChild(t); row.appendChild(s); row.appendChild(del);
    box.appendChild(row);
  }
}

function renderModelsList() {
  const box = $('#models-list');
  box.innerHTML = '';
  const sorted = state.models.slice().sort((a, b) => (b.available ? 1 : 0) - (a.available ? 1 : 0));
  for (const m of sorted) {
    const row = document.createElement('div');
    row.className = 'model-row' +
      (state.current && state.current.provider === m.provider &&
       state.current.model === m.model ? ' active' : '');
    const t = document.createElement('div');
    t.className = 'model-row-title';
    t.textContent = m.model + (m.vision ? ' 📷' : '');
    const s = document.createElement('div');
    s.className = 'model-row-sub';
    s.textContent = m.provider + (m.available ? ' · доступна' : ' · отдыхает');
    row.onclick = async () => {
      if (state.current) {
        state.current.provider = m.provider;
        state.current.model = m.model;
        updateHead();
        try {
          await api('PUT', `/api/chats/${state.current.id}`,
                    { model: `${m.provider}/${m.model}` });
        } catch (e) { /* не критично */ }
      }
      closeSheets();
      renderModelsList();
    };
    row.appendChild(t); row.appendChild(s);
    box.appendChild(row);
  }
}

/* ================= оверлеи ================= */
function openSheet(id) {
  if (id === '#chats-sheet') renderChatsList();
  if (id === '#model-sheet') renderModelsList();
  $(id).hidden = false;
}
function closeSheets() {
  $('#chats-sheet').hidden = true;
  $('#model-sheet').hidden = true;
}

/* ================= отправка ================= */
async function send() {
  if (state.busy) return;
  const input = $('#input');
  const text = input.value.trim();
  if (!text) return;
  if (!INIT_DATA) return showFatal('Нет данных Telegram. Открой приложение из чата с ботом.');
  try {
    if (!state.current) await createChat();
  } catch (e) {
    return warn('Не удалось создать чат: ' + e.message);
  }
  const cur = state.current;
  cur.messages.push({ role: 'user', content: text });
  input.value = '';
  autosize();
  if (cur.title === 'Новый чат') {
    cur.title = text.slice(0, 40) + (text.length > 40 ? '…' : '');
    updateHead();
  }
  $('#empty').hidden = true;
  $('#messages').hidden = false;
  addMessageEl('user', text);
  const pending = addMessageEl('assistant', '', { pending: true });
  state.busy = true;
  try {
    const r = await api('POST', '/api/chat', {
      provider: cur.provider, model: cur.model, messages: cur.messages,
    });
    pending.classList.remove('pending');
    renderRich(pending, r.reply);
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.innerHTML = logoHtml(r.provider) + ' ' + esc(r.model);
    pending.parentNode.appendChild(meta);
    if (r.fallbacks && r.fallbacks.length) {
      pending.parentNode.insertBefore(fallbackLine(r.fallbacks, r.provider, r.model),
                                      pending.parentNode.firstChild);
    }
    scrollBottom();
    cur.messages.push({ role: 'assistant', content: r.reply,
                        provider: r.provider, model: r.model,
                        fallbacks: r.fallbacks || [] });
    try {
      await api('PUT', `/api/chats/${cur.id}`,
                { messages: cur.messages, title: cur.title,
                  model: `${cur.provider}/${cur.model}` });
      const row = state.chats.find(c => c.id === cur.id);
      if (row) { row.title = cur.title; row.updated_at = new Date().toISOString(); }
    } catch (e) { warn('Ответ получен, но не сохранился в историю: ' + e.message); }
  } catch (e) {
    pending.classList.remove('pending');
    pending.textContent = '⚠️ ' + (e.code === 401
      ? 'Сессия протухла: закрой и открой приложение заново.'
      : 'Не получилось ответить: ' + e.message);
    warn('Ошибка ответа: ' + e.message);
  } finally {
    state.busy = false;
  }
}

function autosize() {
  const i = $('#input');
  i.style.height = 'auto';
  i.style.height = Math.min(i.scrollHeight, 140) + 'px';
}

/* ================= старт ================= */
async function boot() {
  tgInit();
  const retry = $('#fatal-retry');
  if (retry) retry.onclick = () => location.reload();
  if (!INIT_DATA) {
    return showFatal('Открой меня из Telegram: в чате с ботом нажми кнопку ' +
      'меню (квадратик слева от поля ввода) или кнопку «📱 Открыть приложение».');
  }
  try {
    await Promise.all([loadModels(), loadChats()]);
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
  $('#btn-chats').onclick = () => openSheet('#chats-sheet');
  const wipe = $('#btn-wipe');
  wipe.onclick = async () => {
    if (!wipe.dataset.arm) {
      wipe.dataset.arm = '1';
      wipe.textContent = 'точно?';
      wipe.classList.add('armed');
      return;
    }
    wipe.dataset.arm = '';
    wipe.textContent = '🗑';
    wipe.classList.remove('armed');
    try {
      await api('DELETE', '/api/chats');
      state.chats = [];
      state.current = null;
      updateHead();
      paintMessages();
      renderChatsList();
      warn('Вся моя история удалена с сервера.');
    } catch (e) {
      warn('Не удалось удалить историю: ' + e.message);
    }
  };
  $('#btn-model').onclick = () => openSheet('#model-sheet');
  $('#btn-new').onclick = async () => {
    try { await createChat(); } catch (e) { warn('Не удалось создать чат: ' + e.message); }
  };
  document.querySelectorAll('.sheet-back, .sheet-close').forEach(el => {
    el.onclick = closeSheets;
  });
  $('#btn-send').onclick = send;
  const input = $('#input');
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  if (state.chats.length) {
    try { await openChat(state.chats[0].id); } catch (e) { paintMessages(); }
  } else {
    updateHead();
    paintMessages();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 120));
} else {
  setTimeout(boot, 120);
}
