/* Рендер текста: markdown, формулы KaTeX, безопасный вывод. Выделено из app.js; загружается до app.js
   и разделяет с ним глобальную область (обычный скрипт). */
'use strict';
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

/* Кнопка «Копировать» у блоков кода — как в больших чат-клиентах.
   Текст берём из <code>, а не из всего <pre>, чтобы служебная подпись
   кнопки не попадала в буфер. */
function addCodeCopy(root) {
  root.querySelectorAll('pre').forEach((pre) => {
    if (pre.querySelector('.code-copy')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'code-copy';
    btn.dataset.i18n = 'message.copy';
    btn.textContent = t('message.copy');
    btn.onclick = (e) => {
      e.stopPropagation();
      const src = pre.querySelector('code');
      const txt = (src || pre).textContent || '';
      if (typeof copyText === 'function') copyText(txt, true);
      btn.dataset.i18n = 'message.copiedShort';
      btn.textContent = t('message.copiedShort');
      btn.classList.add('done');
      clearTimeout(btn._t);
      btn._t = setTimeout(() => {
        btn.dataset.i18n = 'message.copy';
        btn.textContent = t('message.copy');
        btn.classList.remove('done');
      }, 1600);
    };
    pre.appendChild(btn);
  });
}

/* `marked` intentionally supports raw HTML, so its output is untrusted even
   when it came from a model. Keep only the small HTML subset used by chat
   Markdown; strip event/style attributes and reject scriptable URL schemes. */
const RICH_TAGS = new Set([
  'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote',
  'ul', 'ol', 'li', 'strong', 'em', 'del', 's', 'code', 'pre', 'a', 'img',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
]);
const RICH_DROP_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'form',
  'input', 'button', 'video', 'audio', 'source', 'canvas', 'template',
]);

function safeRichUrl(value, allowMailto) {
  const raw = String(value || '').trim();
  if (!raw || /[\x00-\x1f\x7f]/.test(raw)) return '';
  try {
    const url = new URL(raw, document.baseURI || location.href);
    if (url.protocol === 'http:' || url.protocol === 'https:' ||
        (allowMailto && (url.protocol === 'mailto:' || url.protocol === 'tel:'))) return raw;
  } catch (e) { /* invalid URL */ }
  return '';
}

function sanitizeRichHtml(html) {
  const template = document.createElement('template');
  template.innerHTML = String(html || '');
  for (const el of Array.from(template.content.querySelectorAll('*'))) {
    if (!template.content.contains(el)) continue; // ancestor already removed
    const tag = el.tagName.toLowerCase();
    if (!RICH_TAGS.has(tag)) {
      if (RICH_DROP_TAGS.has(tag)) {
        el.remove();
      } else {
        // Keep readable text from harmless formatting elements, but not the tag.
        const parent = el.parentNode;
        while (el.firstChild) parent.insertBefore(el.firstChild, el);
        el.remove();
      }
      continue;
    }

    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const keep = name === 'title' ||
        (tag === 'a' && (name === 'href' || name === 'target')) ||
        (tag === 'img' && (name === 'src' || name === 'alt')) ||
        ((tag === 'th' || tag === 'td') && name === 'align' &&
          /^(left|center|right)$/i.test(attr.value));
      if (!keep) el.removeAttribute(attr.name);
    }

    if (tag === 'a') {
      const href = safeRichUrl(el.getAttribute('href'), true);
      if (href) el.setAttribute('href', href);
      else el.removeAttribute('href');
      if (el.getAttribute('target') === '_blank' && href) {
        el.setAttribute('rel', 'noopener noreferrer');
      } else {
        el.removeAttribute('target');
      }
    } else if (tag === 'img') {
      const src = safeRichUrl(el.getAttribute('src'), false);
      if (!src) {
        el.remove();
        continue;
      }
      el.setAttribute('src', src);
      el.setAttribute('loading', 'lazy');
      el.setAttribute('referrerpolicy', 'no-referrer');
    }
  }
  return template.content;
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
  container.textContent = '';
  container.appendChild(sanitizeRichHtml(html));
  renderMathInto(container, math.store);
  healKatexErrors(container);
  scrubLatexLeftovers(container);
  addCodeCopy(container);
  if (!hasMarked || !katexReady()) container.classList.add('plain');
}

