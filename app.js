/* ============================================================
   Сперанский AI — Mini App (клиент)

   Что делает:
     1. Читает id решения из ссылки (?a=XXXX)
     2. Запрашивает его у бэкенда (в бою — Render, где живёт бот)
     3. Рендерит: LaTeX -> KaTeX, markdown -> HTML, химия -> <img>
     4. Если KaTeX/marked не загрузились (CDN закрыт) — включает
        запасной режим: текст с юникод-символами вместо \команд.

   Никаких ключей API здесь нет и быть не должно: страница получает
   только готовый текст ответа по одноразовому id.
   ============================================================ */
'use strict';

/* ---------- НАСТРОЙКА ПОД БОЕВОЙ РЕЖИМ ----------
   ''  — тот же домен (демо-сервер отдаёт и страницу, и данные)
   'https://homework-bot-6h3b.onrender.com' — реальный бот на Render
*/
const API_BASE = 'https://homework-bot-6h3b.onrender.com';

const $ = (sel) => document.querySelector(sel);

/* ================= Telegram Web App ================= */
const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;

function tgInit() {
  if (!tg) return;
  try {
    tg.ready();
    tg.expand();
    if (tg.setHeaderColor) tg.setHeaderColor('bg_color');
    if (tg.themeParams && Object.keys(tg.themeParams).length) {
      document.documentElement.setAttribute('data-tg-theme', '1');
    }
    tg.onEvent('themeChanged', () => {
      document.documentElement.setAttribute('data-tg-theme', '1');
    });
    // Свайп вниз не должен закрывать приложение, пока читаем решение
    if (tg.disableVerticalSwipes) tg.disableVerticalSwipes();
  } catch (e) { /* вне Telegram это нормально */ }
}

function haptic(kind) {
  try {
    if (tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred(kind || 'light');
  } catch (e) {}
}

/* ================= Запасной режим: LaTeX -> текст =================
   JS-порт strip_latex из bot.py. Используется ТОЛЬКО если KaTeX
   не загрузился. Работает офлайн, без внешних ресурсов. */
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
  // \vec{X} -> X
  const decor = new RegExp('\\\\(?:' + DECOR + ')\\{([^{}]*)\\}', 'g');
  for (let i = 0; i < 3; i++) t = t.replace(decor, '$1');
  // \frac{a}{b} -> a/b (со скобками, если внутри есть + или -)
  // допускаем ОДИН уровень вложенных скобок: \frac{1}{2{,}5}
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

/* ================= Мини-markdown (если marked не загрузился) ================= */
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
    if (list) { out.push(`<${list.tag}>` + list.items.map(i => `<li>${inline(i)}</li>`).join('') + `</${list.tag}>`); list = null; }
  };
  const flushAll = () => { flushPara(); flushQuote(); flushList(); };

  function inline(s) {
    let r = esc(s);
    r = r.replace(/`([^`]+)`/g, '<code>$1</code>');
    r = r.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    r = r.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    r = r.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    r = r.replace(/_([^_\n]+)_/g, '<em>$1</em>');
    r = r.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
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

/* ================= Математика: прячем, потом рендерим =================
   Сначала вырезаем все формулы и кладем вместо них плейсхолдеры,
   которые markdown НЕ тронет. Потом рендерим markdown. Потом
   подменяем плейсхолдеры на настоящий KaTeX.
   Без этого marked превращает \lambda в lambda и формула ломается. */
const MATH_PREFIX = 'zzmathzz';
const ENV_RE = /\\begin\{(equation\*?|align\*?|gather\*?|multline\*?|cases|array|matrix|pmatrix|bmatrix|system)\}[\s\S]*?\\end\{\1\}/g;

function extractMath(text) {
  const store = [];
  const put = (tex, display) => {
    store.push({ tex, display });
    return `${MATH_PREFIX}${store.length - 1}zz`;
  };
  let t = String(text);

  t = t.replace(ENV_RE, (m) => put(m, true));
  t = t.replace(/\$\$([\s\S]+?)\$\$/g, (m, a) => put(a.trim(), true));
  t = t.replace(/\\\[([\s\S]+?)\\\]/g, (m, a) => put(a.trim(), true));
  // inline: \(...\) — до $...$, чтобы не конфликтовало
  t = t.replace(/\\\(([\s\S]+?)\\\)/g, (m, a) => put(a.trim(), false));
  // $...$ — не жадно, в пределах одной строки
  t = t.replace(/(^|[^\\$])\$([^$\n]+?)\$/g, (m, pre, a) => pre + put(a.trim(), false));

  return { text: t, store };
}

function katexReady() {
  return typeof window.katex !== 'undefined' && window.katex &&
         typeof window.katex.render === 'function';
}

function renderMathInto(root, store) {
  const hasKatex = katexReady();
  const re = new RegExp(MATH_PREFIX + '(\\d+)zz', 'g');

  const textNodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) textNodes.push(n);

  for (const node of textNodes) {
    if (!node.parentNode) continue;
    re.lastIndex = 0;
    if (!re.test(node.nodeValue)) continue;
    re.lastIndex = 0;

    const frag = document.createDocumentFragment();
    let last = 0, m;
    while ((m = re.exec(node.nodeValue))) {
      if (m.index > last) {
        frag.appendChild(document.createTextNode(node.nodeValue.slice(last, m.index)));
      }
      const item = store[parseInt(m[1], 10)];
      if (item) frag.appendChild(buildMath(item, hasKatex));
      last = m.index + m[0].length;
    }
    if (last < node.nodeValue.length) {
      frag.appendChild(document.createTextNode(node.nodeValue.slice(last)));
    }
    node.parentNode.replaceChild(frag, node);
    re.lastIndex = 0;
  }
}

function buildMath(item, hasKatex) {
  if (!item) return document.createTextNode('');

  // ---- блочная формула: всегда в карточке .math-block ----
  if (item.display) {
    const div = document.createElement('div');
    div.className = 'math-block';
    if (hasKatex) {
      const span = document.createElement('span');
      try {
        window.katex.render(item.tex, span, {
          displayMode: true,
          throwOnError: false,
          errorColor: '#ff6b6b',
          strict: 'ignore',
          trust: false,
          output: 'htmlAndMathml',
        });
        div.appendChild(span);
        return div;
      } catch (e) { /* падаем в текст */ }
    }
    div.textContent = stripLatex(item.tex);
    return div;
  }

  // ---- строчная формула ----
  if (hasKatex) {
    const span = document.createElement('span');
    try {
      window.katex.render(item.tex, span, {
        displayMode: false,
        throwOnError: false,
        errorColor: '#ff6b6b',
        strict: 'ignore',
        trust: false,
        output: 'htmlAndMathml',
      });
      return span;
    } catch (e) { /* падаем в текст */ }
  }
  return document.createTextNode(stripLatex(item.tex));
}

/* Узкая карточка телефона vs длинная формула: если формула не влезает,
   аккуратно уменьшаем её кегль (KaTeX целиком в em — масштабируется). */
function fitMathBlocks(root) {
  for (const div of root.querySelectorAll('.math-block')) {
    div.style.fontSize = '';
    const inner = div.querySelector('.katex-display') || div.firstElementChild;
    if (!inner) continue;
    const avail = div.clientWidth - 28;
    const w = inner.scrollWidth;
    if (avail > 40 && w > avail) {
      const base = parseFloat(getComputedStyle(div).fontSize) || 17;
      const ratio = Math.max(0.58, avail / w);
      div.style.fontSize = (base * ratio).toFixed(2) + 'px';
    }
  }
}

let _fitTimer = null;
function fitMathBlocksSoon(root) {
  clearTimeout(_fitTimer);
  _fitTimer = setTimeout(() => fitMathBlocks(root), 60);
}

/* Зачистка «сырых» LaTeX-команд, которые модель написала ПРЯМО в тексте
   без $...$ (как в том ответе про векторы: \vec{FE}, \iff, \lambda).
   Идет ПОСЛЕ рендера формул и трогает только обычный текст —
   код, pre и уже отрендеренный KaTeX не задевает. */
function scrubLatexLeftovers(root) {
  const nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  const re = /\\[a-zA-Z]/;
  for (const node of nodes) {
    if (!node.nodeValue || !re.test(node.nodeValue)) continue;
    const p = node.parentElement;
    if (p && p.closest('pre, code, .katex, script, style')) continue;
    const cleaned = stripLatex(node.nodeValue);
    if (cleaned !== node.nodeValue) node.nodeValue = cleaned;
  }
}

/* ================= Химические метки =================
   В бою картинки рендерит бот (RDKit) и присылает готовые URL.
   Здесь — страховка: если метка осталась в тексте, показываем её
   читаемым текстом, а не мусором в квадратных скобках. */
const CHEM_RE = /\[(RXN|SMILES|SCHEME):\s*([^\]|]+?)\s*(?:\|\s*([^\]|]+?))?\s*(?:\|\s*([^\]]+?))?\s*\]/gi;

function extractChem(text) {
  const imgs = [];
  const t = String(text).replace(CHEM_RE, (m, kind, code, cond, names) => {
    const caption = (cond || names || '').trim();
    imgs.push({ code: code.trim(), caption, kind: kind.toUpperCase() });
    // Запасной вариант (в бою метки заменяет сервер на готовые картинки):
    // показываем уравнение читаемым кодовым блоком, а не мусором в скобках.
    const lines = [`${kind.toUpperCase()}: ${code.trim()}`];
    if (cond) lines.push(`условия: ${cond}`);
    if (names) lines.push(`вещества: ${names}`);
    return '\n```\n' + lines.join('\n') + '\n```\n';
  });
  return { text: t, imgs };
}

/* ================= Картинки: в карточку с подписью =================
   Markdown-картинка ![подпись](img/x.png) превращается в
   <figure class="chem"><img><figcaption>подпись</figcaption></figure>.
   Если файл не загрузился — показываем подпись текстом, без битой иконки. */
function styleImages(root) {
  for (const img of Array.from(root.querySelectorAll('img'))) {
    if (img.closest('.chem')) continue;
    const fig = document.createElement('figure');
    fig.className = 'chem';
    img.replaceWith(fig);
    fig.appendChild(img);
    const alt = (img.getAttribute('alt') || '').trim();
    img.loading = 'lazy';
    // Подпись ВНУТРИ png рисует сам рендер бота (RDKit+Pillow),
    // поэтому figcaption не дублируем. alt оставляем для доступности
    // и как текст на случай, если картинка не загрузится.
    img.addEventListener('error', () => {
      const pre = document.createElement('pre');
      pre.textContent = alt || '(структура недоступна)';
      fig.replaceWith(pre);
    });
  }
}

/* Блочная формула не должна оставаться внутри <p> — выносим её наружу,
   разрезая абзац на две части. Иначе вёрстка «плывёт». */
function hoistBlocks(root) {
  const blocks = Array.from(root.querySelectorAll('p > .math-block'));
  for (const block of blocks) {
    const p = block.parentNode;
    const before = [], after = [];
    let target = before, node = p.firstChild;
    while (node) {
      const next = node.nextSibling;
      if (node === block) { target = after; }
      else { target.push(node); }
      node = next;
    }
    const frag = document.createDocumentFragment();
    const mkP = (kids) => {
      if (!kids.length) return null;
      const np = document.createElement('p');
      kids.forEach(k => np.appendChild(k));
      return np;
    };
    const pb = mkP(before);
    const pa = mkP(after);
    if (pb) frag.appendChild(pb);
    frag.appendChild(block);
    if (pa) frag.appendChild(pa);
    p.replaceWith(frag);
  }
}

/* ================= Ответ задачи в рамочку ================= */
function highlightAnswer(root) {
  // ВАЖНО: \b в JS не понимает кириллицу, поэтому граница слова задана явно
  const RE = /^(?:Ответ|ОТВЕТ|Итог|ИТОГ)(?:\s*[:.]|\s|$)/;
  const nodes = Array.from(root.querySelectorAll('p, li'));
  for (const el of nodes) {
    if (el.closest('.answer-box')) continue;
    const txt = (el.textContent || '').trim();
    if (RE.test(txt) && txt.length < 400) {
      const box = document.createElement('div');
      box.className = 'answer-box';
      const label = document.createElement('div');
      label.className = 'answer-label';
      label.textContent = 'Ответ';
      box.appendChild(label);
      const body = document.createElement('div');
      // убираем само слово «Ответ:» из текста — оно теперь в подписи
      el.innerHTML = el.innerHTML.replace(
        /^\s*(<[^>]+>\s*)*(?:Ответ|ОТВЕТ|Итог|ИТОГ)\s*[:.]\s*/i, '$1');
      while (el.firstChild) body.appendChild(el.firstChild);
      box.appendChild(body);
      el.replaceWith(box);
    }
  }
}

/* ================= Рендер целиком ================= */
function renderInto(container, rawText, parts) {
  container.innerHTML = '';
  let text = String(rawText || '');

  const chem = extractChem(text);
  text = chem.text;

  const math = extractMath(text);
  text = math.text;

  let html;
  const hasMarked = typeof window.marked !== 'undefined' && window.marked;
  if (hasMarked) {
    try {
      if (window.marked.setOptions) {
        window.marked.setOptions({ breaks: true, gfm: true });
      }
      const parse = window.marked.parse || window.marked;
      html = parse(text);
    } catch (e) {
      html = miniMarkdown(text);
    }
  } else {
    html = miniMarkdown(text);
  }

  container.innerHTML = html;
  renderMathInto(container, math.store);
  scrubLatexLeftovers(container);
  hoistBlocks(container);
  styleImages(container);
  highlightAnswer(container);
  fitMathBlocksSoon(container);
  window.addEventListener('resize', () => fitMathBlocksSoon(container));

  if (!hasMarked || !katexReady()) {
    container.classList.add('plain');
    const w = $('#warn');
    const missing = [];
    if (!katexReady()) missing.push('формулы (KaTeX)');
    if (!hasMarked) missing.push('оформление (marked)');
    w.hidden = false;
    w.innerHTML = '⚠️ Не загрузился ' + missing.join(' и ') +
      ' с CDN — показываю запасной вариант: всё читаемо, но формулы без красивого набора. ' +
      'Проверь интернет или попробуй позже.';
  } else {
    const w = $('#warn');
    w.hidden = true;
    w.innerHTML = '';
  }
}

/* ================= Данные ================= */
async function loadAnswer(id) {
  const base = API_BASE.replace(/\/+$/, '');
  const url = `${base}/api/answer?id=${encodeURIComponent(id)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (res.status === 404) throw Object.assign(new Error('not found'), { code: 404 });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

function metaChips(data) {
  const head = $('#head-meta');
  head.innerHTML = '';
  const add = (cls, txt) => {
    if (!txt) return;
    const s = document.createElement('span');
    s.className = 'chip' + (cls ? ' ' + cls : '');
    s.textContent = txt;
    head.appendChild(s);
  };
  if (data.verdict === true)  add('ok', '✅ проверено консилиумом');
  if (data.verdict === false) add('bad', '⚠️ консилиум нашёл расхождения');
  if (data.model) add('', data.model);
  if (data.mode)  add('', data.mode === 'fast' ? '⚡ быстрый режим' : '📚 режим Д/З');
  if (data.subject) add('', data.subject);
  if (data.images && data.images.length) add('', '🧪 структур: ' + data.images.length);
  if (data.created) add('', data.created);
}

function setupPager(parts) {
  const pager = $('#pager');
  pager.innerHTML = '';
  if (!parts || parts.length < 2) { pager.hidden = true; return; }
  pager.hidden = false;
  parts.forEach((p, i) => {
    const b = document.createElement('button');
    b.textContent = p.label || `Часть ${i + 1}`;
    b.onclick = () => {
      haptic('light');
      Array.from(pager.children).forEach(c => c.classList.remove('active'));
      b.classList.add('active');
      renderInto($('#content'), p.text, parts);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };
    if (i === 0) b.classList.add('active');
    pager.appendChild(b);
  });
}

function setupButtons(data) {
  const btnFont = $('#btn-font');
  const sizes = ['', 'big', 'huge'];
  let si = 0;
  btnFont.onclick = () => {
    si = (si + 1) % sizes.length;
    document.body.classList.remove('big', 'huge');
    if (sizes[si]) document.body.classList.add(sizes[si]);
    haptic('light');
  };

  const btnCopy = $('#btn-copy');
  btnCopy.onclick = async () => {
    const txt = (data.plain || $('#content').innerText || '').trim();
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(txt);
      } else {
        const ta = document.createElement('textarea');
        ta.value = txt;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      btnCopy.textContent = '✓';
      haptic('success');
      setTimeout(() => { btnCopy.textContent = '📋'; }, 1400);
    } catch (e) {
      btnCopy.textContent = '✕';
      setTimeout(() => { btnCopy.textContent = '📋'; }, 1400);
    }
  };
}

/* Витрина демо-решений: удобно тыкать с телефона. */
function showGallery(ids) {
  $('#boot').hidden = true;
  $('#fatal').hidden = true;
  $('#view').hidden = false;
  $('#head-title').textContent = 'Сперанский AI — демо решений';
  $('#head-meta').innerHTML = '';
  $('#pager').hidden = true;
  const c = $('#content');
  c.innerHTML = '';
  const intro = document.createElement('p');
  intro.className = 'gallery-intro';
  intro.textContent = 'Это демо-витрина: выбери разбор, чтобы посмотреть, ' +
    'как он выглядит в Mini App (формулы, структуры, вкладки).';
  c.appendChild(intro);
  for (const it of ids) {
    const a = document.createElement('a');
    a.className = 'gcard';
    a.href = `?a=${encodeURIComponent(it.id)}`;
    const t = document.createElement('div');
    t.className = 'gtitle';
    t.textContent = it.title || it.id;
    const s = document.createElement('div');
    s.className = 'gsub';
    s.textContent = (it.subject || '') + ' · открыть →';
    a.appendChild(t);
    a.appendChild(s);
    c.appendChild(a);
  }
  setupButtons({ plain: '' });
}

function showFatal(text) {
  $('#boot').hidden = true;
  $('#view').hidden = true;
  const f = $('#fatal');
  f.hidden = false;
  if (text) $('#fatal-text').textContent = text;
}

/* ================= Старт ================= */
async function boot() {
  tgInit();

  const params = new URLSearchParams(location.search);
  const id = params.get('a') || params.get('id') || params.get('startapp') || '';

  if (!id) {
    // Без id пробуем показать витрину доступных разборов (есть только
    // в демо-сервере; в бою /api/ids не отвечает JSON-ом -> fatal-экран)
    try {
      const base = API_BASE.replace(/\/+$/, '');
      const r = await fetch(`${base}/api/ids`, { headers: { Accept: 'application/json' } });
      if (r.ok) {
        const j = await r.json();
        if (j && Array.isArray(j.ids) && j.ids.length) return showGallery(j.ids);
      }
    } catch (e) { /* нет витрины — покажем подсказку */ }
    return showFatal('Открой эту страницу по ссылке из бота — в ней есть id решения.');
  }
  try {
    await render(id);
  } catch (e) {
    showFatal(e && e.code === 404
      ? 'Такое решение не найдено или срок ссылки истёк.'
      : 'Не удалось получить решение: ' + (e && e.message ? e.message : 'ошибка сети'));
  }
}

async function render(id) {
  const data = await loadAnswer(id);
  if (!data || !data.text) throw Object.assign(new Error('empty'), { code: 404 });

  $('#boot').hidden = true;
  $('#fatal').hidden = true;
  $('#view').hidden = false;

  $('#head-title').textContent = data.title || 'Решение';
  document.title = (data.title || 'Решение') + ' — Сперанский AI';
  metaChips(data);

  const parts = (data.parts && data.parts.length)
    ? data.parts
    : [{ label: 'Решение', text: data.text }];

  setupPager(parts);
  setupButtons(data);
  renderInto($('#content'), parts[0].text, parts);

  if (tg && tg.BackButton) {
    try {
      tg.BackButton.onClick(() => tg.close());
      if (parts.length > 1) tg.BackButton.show(); else tg.BackButton.hide();
    } catch (e) {}
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 120));
} else {
  setTimeout(boot, 120);
}
