/* ============================================================
   Сперанский AI — Mini App v2: полноценный ИИ-клиент.
   Чаты (история на сервере), выбор модели, диалог с красивым
   рендером формул (KaTeX) и markdown.

   Безопасность: страница не знает ключей API; каждый запрос к
   Render несёт Telegram initData, подпись проверяется сервером.
   ============================================================ */
'use strict';
window.__APP_V = '20260920a';
// iOS WKWebView не умеет стриминговое чтение fetch — там сразу просим целиком
const NO_STREAM = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

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
  speak: false,           // озвучивать ответы
  voicePref: 'auto',      // auto | live | record
  pins: [],               // закреплённые чаты
  quota: null,            // {left_day, unlimited} с сервера
  chatFilter: '',         // фильтр списка чатов в drawer
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

/* Если KaTeX не смог разобрать формулу (модель написала мусорный LaTeX),
   не показываем красный error-блок: заменяем на читаемый плоский текст. */
function healKatexErrors(root) {
  root.querySelectorAll('.katex-error').forEach((el) => {
    const tex = el.textContent || '';
    const span = document.createElement('span');
    span.className = 'math-plain';
    span.textContent = stripLatex(tex).replace(/\*\*/g, '');
    el.replaceWith(span);
  });
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
  healKatexErrors(container);
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
  mk('act-speak', 'Прочитать вслух', IC.speak, (b) => toggleSpeak(text, b));
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

/* озвучка ответа системным синтезом речи; повторный тап — стоп */
function toggleSpeak(text, btn) {
  const syn = window.speechSynthesis;
  if (!syn) { warn('Озвучка недоступна в этом браузере.'); return; }
  if (btn && btn.classList.contains('on')) {
    syn.cancel();
    btn.classList.remove('on');
    return;
  }
  document.querySelectorAll('.act-speak.on').forEach((b) => b.classList.remove('on'));
  syn.cancel();
  const u = new SpeechSynthesisUtterance(
    String(text || '').replace(/[#*`_>|\\[\]]/g, ' ').slice(0, 3000));
  u.lang = 'ru-RU';
  const off = () => { if (btn) btn.classList.remove('on'); };
  u.onend = off;
  u.onerror = off;
  if (btn) btn.classList.add('on');
  haptic('light');
  syn.speak(u);
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

const STATE_RANK = { ok: 0, new: 1, unstable: 2, cooldown: 3, dead: 4 };
/* Короткие честные подписи статусов: без «процентов здоровья» —
   статус считает сервер по последним реальным ответам модели. */
const STATE_RU = {
  ok: 'работает',
  new: 'новая, ещё не проверена',
  unstable: 'нестабильна (были сбои)',
  cooldown: 'отдыхает после лимита',
  dead: 'недоступна этому ключу',
};
const STATE_TT = {
  ok: 'Отвечает стабильно',
  new: 'Ещё не проверяли в деле',
  unstable: 'Последние ответы были со сбоями',
  cooldown: 'Бесплатный лимит исчерпан — скоро вернётся',
  dead: 'Ключ провайдера не отдаёт эту модель',
};
/* Оптимистичное создание чата: UI открывается мгновенно, POST уходит
   в фоне. state.chatReady — промис фонового сохранения; перед любыми
   серверными операциями с этим чатом его дожидаются send()/openChat(). */
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

const CATS = [
  { id: 'text', title: 'Текстовые и задачи', short: 'Текст', icon: 'catText' },
  { id: 'code', title: 'Коддинг', short: 'Код', icon: 'catCode',
    filter: /code|coder|codestral|leanstral|coder480b/i },
  { id: 'image', title: 'Генерация изображений', short: 'Картинки',
    icon: 'catImage', soon: true },
  { id: 'video', title: 'Генерация видео', short: 'Видео', icon: 'catVideo', soon: true },
  { id: 'audio', title: 'Аудио и озвучка', short: 'Аудио', icon: 'catAudio', soon: true },
];

function modelRow(m) {
  const row = document.createElement('div');
  row.className = 'model-row ' + (m.state || 'ok') +
    (state.current && state.current.provider === m.provider &&
     state.current.model === m.model ? ' active' : '');
  const t = document.createElement('div');
  t.className = 'model-row-title';
  t.innerHTML = logoHtml(m.provider) + ' ' + esc(m.model) +
    (m.vision ? ' <span class="vis-dot" title="видит фото"></span>' : '');
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

/* Вкладки категорий: Текст / Код / Картинки / Видео / Аудио */
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
  }, 1000);
}
function stopThinking() {
  if (state.thinkTimer) { clearInterval(state.thinkTimer); state.thinkTimer = null; }
}

/* ================= голос: живой ввод =================
   Два режима, выбираются автоматически:
   1) Живое распознавание (Web Speech API) — обычные браузеры:
      говоришь, текст появляется в строке ввода сразу.
   2) Запись (MediaRecorder) + серверное распознавание Groq whisper —
      работает везде, включая Telegram WebView. Во время записи каждые
      ~2.5 с накопленное аудио частично уходит на /api/transcribe,
      поэтому текст дописывается в строку, пока ещё говоришь. */
let recorder = null;
let recChunks = [];
let recTimer = null;
let recBase = '';          // текст, бывший в строке до записи
let partialBusy = false;
let partialAt = 0;
let liveRec = null;
let liveFellBack = false;
const LiveSR = window.SpeechRecognition || window.webkitSpeechRecognition;

function showRecBar(hint) {
  if (voOpen) {           // в голосовом оверлее свой статус, rec-бар не нужен
    setVoStatus(hint || 'слушаю…');
    return;
  }
  const bar = $('#rec-bar');
  if (!bar) return;
  const h = bar.querySelector('.rec-hint');
  if (h && hint) h.textContent = hint;
  bar.hidden = false;
  const t0 = Date.now();
  const el = $('#rec-time');
  const tick = () => {
    const s = Math.floor((Date.now() - t0) / 1000);
    if (el) el.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  };
  tick();
  recTimer = setInterval(tick, 500);
}

function hideRecBar() {
  if (recTimer) { clearInterval(recTimer); recTimer = null; }
  const bar = $('#rec-bar');
  if (bar) bar.hidden = true;
  if (voOpen) setVoStatus('нажми микрофон и говори');
}

function blobToB64(blob) {
  return new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] || '');
    r.readAsDataURL(blob);
  });
}

async function toggleRec(btn) {
  if (liveRec) { stopLiveRec(btn); return; }
  if (recorder) { recorder.stop(); return; }
  if (state.voicePref === 'live') liveFellBack = false;   // вторая попытка live
  const wantLive = state.voicePref !== 'record' && !!LiveSR && !liveFellBack;
  if (wantLive && startLiveRec(btn)) return;
  await startRecordRec(btn);
}

/* --- режим 1: живое распознавание в браузере --- */
function startLiveRec(btn) {
  let r;
  try { r = new LiveSR(); } catch (e) { return false; }
  liveRec = r;
  const inp = $('#input');
  const base = (inp.value || '').trim();
  let finalText = '';
  r.lang = 'ru-RU';
  r.continuous = true;
  r.interimResults = true;
  r.onresult = (ev) => {
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const res = ev.results[i];
      if (res.isFinal) {
        const t = (res[0].transcript || '').trim();
        if (t) finalText += (finalText ? ' ' : '') + t;
      } else interim += (res[0].transcript || '');
    }
    inp.value = [base, finalText, interim.trim()].filter(Boolean).join(' ');
    autosize();
  };
  r.onerror = (ev) => {
    if (ev.error === 'no-speech' || ev.error === 'aborted') return;
    const wasRec = btn.classList.contains('rec');
    stopLiveRec(btn);
    if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
      warn('Нет доступа к микрофону: разреши в настройках или напиши текстом.');
      return;
    }
    if (wasRec && !liveFellBack) {
      // живое распознавание в этом окружении не работает — запись + whisper
      liveFellBack = true;
      startRecordRec(btn);
      return;
    }
    warn('Распознавание остановилось (' + ev.error + ').');
  };
  r.onend = () => {
    // браузеры обрывают длинные сессии — перезапускаем, пока идёт запись
    if (liveRec === r && btn.classList.contains('rec')) {
      try { r.start(); } catch (e) { /* дождёмся следующего onend */ }
    }
  };
  try { r.start(); } catch (e) { liveRec = null; return false; }
  btn.classList.add('rec');
  if (voOpen) startOrb(null);
  showRecBar('слушаю… говори — текст появится сам');
  haptic('light');
  return true;
}

function stopLiveRec(btn) {
  if (!liveRec) return;
  const r = liveRec;
  liveRec = null;
  try { r.onend = null; r.stop(); } catch (e) { /* уже остановлен */ }
  btn.classList.remove('rec');
  stopOrb();
  hideRecBar();
  haptic('light');
  const inp = $('#input');
  if ((inp.value || '').trim()) { autosize(); inp.focus(); }
}

/* --- режим 2: запись + серверное распознавание с частичными отправками --- */
async function startRecordRec(btn) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
  } catch (e) {
    try {
      recorder = new MediaRecorder(stream);
    } catch (e2) {
      warn('Микрофон недоступен: разреши доступ или напиши текстом.');
      return;
    }
  }
  recChunks = [];
  partialBusy = false;
  partialAt = Date.now();
  recBase = ($('#input').value || '').trim();
  recorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size) {
      recChunks.push(ev.data);
      sendPartial();
    }
  };
  recorder.onstop = async () => {
    const blob = new Blob(recChunks, { type: recorder.mimeType || 'audio/webm' });
    recorder.stream.getTracks().forEach((t) => t.stop());
    recorder = null;
    btn.classList.remove('rec');
    stopOrb();
    hideRecBar();
    haptic('light');
    if (!blob.size) return;
    const b64 = await blobToB64(blob);
    warn('Распознаю голосовое…');
    try {
      const j = await api('POST', '/api/transcribe',
                          { audio: b64, mime: blob.type || 'audio/webm', partial: false });
      const inp = $('#input');
      inp.value = [recBase, (j.text || '').trim()].filter(Boolean).join(' ');
      autosize();
      inp.focus();
      warn('');
      $('#warn').hidden = true;
    } catch (e) {
      warn('Не распознал: ' + e.message + '. Напиши текстом.');
    }
  };
  recorder.start(1000);   // куски раз в секунду — нужны для частичных отправок
  btn.classList.add('rec');
  if (voOpen) startOrb(stream);
  showRecBar('говори — текст появится по мере распознавания');
  haptic('light');
}

/* Частичное распознавание: раз в ≥2.5 с отправляем всё накопленное аудио
   и обновляем строку ввода. Ошибки молча глотаются — финальное
   распознавание после остановки всё догонит. */
async function sendPartial() {
  if (!recorder || partialBusy) return;
  const now = Date.now();
  if (now - partialAt < 2500) return;
  const blob = new Blob(recChunks, { type: recorder.mimeType || 'audio/webm' });
  if (blob.size < 5000) return;   // меньше секунды звука — рано
  partialAt = now;
  partialBusy = true;
  try {
    const b64 = await blobToB64(blob);
    const j = await api('POST', '/api/transcribe',
                        { audio: b64, mime: blob.type || 'audio/webm', partial: true });
    const inp = $('#input');
    if (recorder && j.text && j.text.trim()) {
      inp.value = [recBase, j.text.trim()].filter(Boolean).join(' ');
      autosize();
    }
  } catch (e) { /* тихо: финальное распознавание покроет всё */ }
  partialBusy = false;
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

/* ================= нормальные SVG-иконки ================= */
const IC = {
  send: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M3.4 20.6 21 12 3.4 3.4l2.4 7.2L15 12l-9.2 1.4z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>',
  clip: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M20 11.5 12.3 19a5 5 0 0 1-7-7l8.5-8.4a3.3 3.3 0 0 1 4.7 4.7L9.4 15.8a1.7 1.7 0 0 1-2.4-2.4l7.8-7.7"/></svg>',
  mic: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3"/></svg>',
  x: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  catText: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12h5"/></svg>',
  catCode: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 7 3.5 12 8 17M16 7l4.5 5L16 17"/></svg>',
  catImage: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="M4.5 17.5 10 12l4 4 3-3 2.5 2.5"/></svg>',
  catVideo: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="6" width="12" height="12" rx="2.5"/><path d="M15.5 10.5 20.5 8v8l-5-2.5z"/></svg>',
  catAudio: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4"/></svg>',
  lock: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2.5"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10"/></svg>',
  copy: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>',
  regen: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v4.5h-4.5"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5"/></svg>',
  dots: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>',
  sparkO: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 6.1L20 11l-6.1 1.9L12 19l-1.9-6.1L4 11l6.1-1.9z"/></svg>',
  speak: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10v4h3l4 4V6L7 10z"/><path d="M15 9.5a4 4 0 0 1 0 5M17.5 7a7 7 0 0 1 0 10"/></svg>',
  shareIc: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-1"/></svg>',
  sparkFill: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M12 3l1.9 6.1L20 11l-6.1 1.9L12 19l-1.9-6.1L4 11l6.1-1.9z"/></svg>',
  bulb: '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18h6M10 21h4M12 3a6.5 6.5 0 0 1 4 11.6c-.7.6-1 1.4-1 2.4h-6c0-1-.3-1.8-1-2.4A6.5 6.5 0 0 1 12 3z"/></svg>',
  solve: '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 21V5a2 2 0 0 1 2-2h12v16H7a2 2 0 0 0-2 2zm0 0a2 2 0 0 0 2 2h12"/><path d="M9 7h6M9 11h6"/></svg>',
  cal: '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
};

/* ================= хаптики Telegram ================= */
function haptic(kind) {
  if (state.haptics === false) return;
  try { if (tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred(kind || 'light'); } catch (e) {}
}
function hapticSel() {
  if (state.haptics === false) return;
  try { if (tg && tg.HapticFeedback) tg.HapticFeedback.selectionChanged(); } catch (e) {}
}
function hapticNotify(type) {
  if (state.haptics === false) return;
  try { if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred(type); } catch (e) {}
}

/* ================= настройки пользователя (localStorage) ================= */
const PREFS_KEY = 'sp_prefs_v1';
function loadPrefs() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); } catch (e) {}
  state.theme = p.theme || 'system';
  state.accent = p.accent || 'blue';
  state.haptics = p.haptics !== false;
  state.speak = !!p.speak;
  state.voicePref = p.voicePref || 'auto';
  state.pins = Array.isArray(p.pins) ? p.pins : [];
}
function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      theme: state.theme, accent: state.accent, haptics: state.haptics,
      speak: state.speak, voicePref: state.voicePref, pins: state.pins,
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
      if (j.d !== undefined) { acc += j.d; bubble.__acc = acc; paint(false); }
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
  const silence = setTimeout(() => { timedOut = true; state.abortCtl.abort(); }, 90000);
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
    if (timedOut) throw Object.assign(new Error('сервер молчит >90 секунд'), { code: 504 });
    throw e;
  }
  clearTimeout(silence);
  const ct = res.headers.get('content-type') || '';
  if (res.ok && ct.includes('ndjson')) {
    try {
      return await readStream(res, bubble);
    } catch (e) {
      // стрим умер посередине (особенность некоторых вебвью): повторяем
      // запрос целиком — надёжность важнее экономии одного запроса
      bubble.classList.add('pending');
      bubble.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
    }
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.error || ('HTTP ' + res.status)),
                        { code: res.status });
  }
  bubble.classList.remove('pending');
  renderRich(bubble, data.reply);
  return data;
}

/* ================= отправка ================= */
async function send(opts = {}) {
  if (state.busy) return;
  const regen = !!opts.regen;
  const input = $('#input');
  const lastU = regen && state.current
    ? state.current.messages[state.current.messages.length - 1]
    : null;
  const text = regen ? ((lastU && lastU.content) || '') : input.value.trim();
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
    input.value = '';
    autosize();
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
    if (state.speak && r.reply) toggleSpeak(r.reply, null);
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
    if (e.aborted && !e.timedOut504) {
      const part = e.partial || '';
      if (part) {
        renderRich(pending, part);
        const note = document.createElement('div');
        note.className = 'stop-note';
        note.textContent = '■ остановлено — сохранил сгенерированную часть';
        pending.appendChild(note);
        cur.messages.push({ role: 'assistant', content: part });
        warn('Генерацию остановили: сохранил то, что успело напечататься.');
      } else {
        pending.remove();
        warn('Генерацию остановили.');
      }
      return;
    }
    hapticNotify('error');
    pending.textContent = '⚠️ ' + (e.code === 401
      ? 'Сессия протухла: закрой и открой приложение заново.'
      : e.code === 504
        ? 'Сервер молчит больше 90 секунд. Попробуй ещё раз или проверь интернет.'
        : 'Не получилось ответить: ' + e.message);
    warn('Ошибка ответа: ' + e.message);
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
  /* композер меняет правую кнопку: волна → отправка */
  const c = $('#composer');
  if (c) c.classList.toggle('has-text', !!i.value.trim());
  const vo = $('#vo-text');
  if (vo && !$('#voice-overlay').hidden) {
    vo.textContent = i.value.trim() || 'Спроси Сперанского…';
  }
}

/* ================= настройки (груп-карточки) ================= */
const THEMES = [['system', 'Системное'], ['dark', 'Тёмное'], ['light', 'Светлое']];
const ACCENTS = [['blue', 'Синий'], ['violet', 'Фиолетовый'],
                 ['green', 'Зелёный'], ['orange', 'Оранжевый']];
const VOICE_PREFS = [['auto', 'авто'], ['live', 'live'], ['record', 'запись']];

function renderSettings() {
  const th = THEMES.find((t) => t[0] === state.theme) || THEMES[0];
  const ac = ACCENTS.find((a) => a[0] === state.accent) || ACCENTS[0];
  const vp = VOICE_PREFS.find((v) => v[0] === state.voicePref) || VOICE_PREFS[0];
  $('#set-theme-val').textContent = th[1];
  $('#set-accent-val').innerHTML = '<i class="acc-dot"></i>' + ac[1];
  $('#set-voice-val').textContent = vp[1];
  $('#set-speak-val').textContent = state.speak ? 'вкл' : 'выкл';
  $('#set-haptics-val').textContent = state.haptics ? 'вкл' : 'выкл';
  $('#set-model-val').textContent = state.current && state.current.provider
    ? shortModel(state.current.model) : 'авто';
  const v = $('#set-version');
  if (v) v.textContent = __APP_V;
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
    row.innerHTML = '<img alt="" src="' + x.m.image + '">' +
      '<div><div>фото к сообщению ' + (x.i + 1) + '</div>' +
      '<small>нажми, чтобы рассмотреть</small></div>';
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

/* ================= голосовой режим: сфера на реальном уровне ========== */
let voOpen = false;
let orbRaf = 0;
let analyser = null;
let audioCtx = null;

function setVoStatus(t) {
  const el = $('#vo-status');
  if (el) el.textContent = t;
}
function openVoice() {
  voOpen = true;
  $('#voice-overlay').hidden = false;
  const t = ($('#input').value || '').trim();
  $('#vo-text').textContent = t || 'Спроси Сперанского…';
  setVoStatus(recorder || liveRec ? 'слушаю…' : 'нажми микрофон и говори');
  haptic('light');
}
function closeVoice() {
  voOpen = false;
  if (recorder) { try { recorder.stop(); } catch (e) {} }
  if (liveRec) stopLiveRec($('#vo-mic'));
  stopOrb();
  setVoStatus('нажми микрофон и говори');
  $('#voice-overlay').hidden = true;
}
function startOrb(stream) {
  const orb = $('#orb');
  if (!orb) return;
  if (stream) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
    } catch (e) { analyser = null; }
  }
  orb.classList.add('live');
  const data = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;
  const t0 = Date.now();
  const loop = () => {
    if (!voOpen || !orb.classList.contains('live')) return;
    let lvl = 0;
    if (analyser && data) {
      analyser.getByteTimeDomainData(data);
      let s = 0;
      for (let i = 0; i < data.length; i++) {
        const d = (data[i] - 128) / 128;
        s += d * d;
      }
      lvl = Math.min(1, Math.sqrt(s / data.length) * 3.4);
    } else {
      /* live-распознавание без потока: мягкая синусоида «речи» */
      lvl = 0.28 + 0.22 * Math.sin((Date.now() - t0) / 260);
    }
    orb.style.transform = 'scale(' + (1 + lvl * 0.16).toFixed(3) + ')';
    orbRaf = requestAnimationFrame(loop);
  };
  loop();
}
function stopOrb() {
  if (orbRaf) cancelAnimationFrame(orbRaf);
  orbRaf = 0;
  const orb = $('#orb');
  if (orb) { orb.classList.remove('live'); orb.style.transform = ''; }
  if (audioCtx) { try { audioCtx.close(); } catch (e) {} audioCtx = null; analyser = null; }
}

/* ================= квота запросов ================= */
async function loadQuota() {
  try {
    state.quota = await api('GET', '/api/quota');
  } catch (e) {
    state.quota = null;   // старый сервер без квот — просто не показываем
  }
  renderQuota();
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
  const micBtn = $('#btn-mic');
  micBtn.onclick = () => toggleRec(micBtn);
  $('#btn-voice').onclick = () => openVoice();
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
  $('#set-voice').onclick = () => {
    const i = VOICE_PREFS.findIndex((v) => v[0] === state.voicePref);
    state.voicePref = VOICE_PREFS[(i + 1) % VOICE_PREFS.length][0];
    savePrefs(); renderSettings(); hapticSel();
  };
  $('#set-speak').onclick = () => {
    state.speak = !state.speak;
    if (!state.speak && window.speechSynthesis) window.speechSynthesis.cancel();
    savePrefs(); renderSettings(); hapticSel();
  };
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

  /* ---- голосовой оверлей ---- */
  const voMic = $('#vo-mic');
  voMic.onclick = () => toggleRec(voMic);
  $('#vo-close').onclick = () => closeVoice();
  $('#vo-close-top').onclick = () => closeVoice();
  $('#vo-settings').onclick = () =>
    warn('Тонкая настройка голоса — скоро. Сейчас: тап по микрофону = говорить.');

  if (state.chats.length) {
    try { await openChat(state.chats[0].id); } catch (e) { paintMessages(); }
  } else {
    updateHead();
    paintMessages();
  }
  loadQuota();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 120));
} else {
  setTimeout(boot, 120);
}
