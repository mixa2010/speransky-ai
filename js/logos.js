/* Логотипы провайдеров (инлайн-SVG и файлы, с запасным вариантом). Выделено из app.js; загружается до app.js
   и разделяет с ним глобальную область (обычный скрипт). */
'use strict';
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
