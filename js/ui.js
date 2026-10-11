/* Мелкие UI-утилиты: время в списке чатов, прокрутка, свайп-закрытие шторок,
   цвет системной плашки. Выделено из app.js; загружается до app.js
   и разделяет с ним глобальную область (обычный скрипт). */
'use strict';

/* ================= время в списке чатов ================= */
const MONTHS_RU = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн',
                   'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function pad2(n) { return String(n).padStart(2, '0'); }

/* «09:01» сегодня, «вчера», «11 окт», «11.10.25» — вместо машинного
   «10-11T09:01», которое показывал прежний slice(). */
function fmtWhen(iso) {
  const raw = String(iso || '');
  const t = Date.parse(raw);
  if (!t) return raw.length >= 16 ? raw.slice(11, 16) : '';
  const d = new Date(t);
  const now = new Date();
  const hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  if (sameDay(d, now)) return hm;
  const yest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameDay(d, yest)) return 'вчера';
  if (d.getFullYear() === now.getFullYear()) return d.getDate() + ' ' + MONTHS_RU[d.getMonth()];
  return pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.' + String(d.getFullYear()).slice(2);
}

/* Группа для заголовков списка чатов: 0 сегодня, 1 вчера, 2 эта неделя,
   3 раньше. Чаты без даты попадают в «раньше». */
function dayBucket(iso) {
  const t = Date.parse(String(iso || ''));
  if (!t) return 3;
  const d = new Date(t), now = new Date();
  if (sameDay(d, now)) return 0;
  const yest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameDay(d, yest)) return 1;
  return (now - d) < 7 * 86400000 ? 2 : 3;
}

/* ================= прокрутка ленты ================= */
/* Пользователь держится за низ ленты? Если он читает историю, стрим
   больше не дёргает экран вниз. */
function isNearBottom(el, slack) {
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= (slack || 90);
}

/* ================= системная плашка браузера ================= */
/* theme-color = фактический фон приложения (учитывает тему Telegram,
   ручную тему и акцент). Вызывается при старте и на смену темы. */
function syncThemeColor() {
  try {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    const root = getComputedStyle(document.documentElement);
    let c = (root.getPropertyValue('--bg') || '').trim();
    if (!/^(#|rgb|hsl)/i.test(c)) {
      c = getComputedStyle(document.body).backgroundColor || '#0b0e14';
    }
    meta.setAttribute('content', c);
  } catch (e) { /* необязательное украшение */ }
}

function prefersReduced() {
  try {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (e) { return false; }
}

/* ================= свайп-закрытие шторок ================= */
/* Тянем за «ручку» или шапку шторки (не за содержимое — там скролл):
   вниз — нижние шторки, влево — боковое меню. Короткий флик тоже
   закрывает. Без Pointer Events (старые WebView) просто не включаем. */
function enableDragClose(rootEl, opts) {
  if (!rootEl || !window.PointerEvent) return;
  const o = opts || {};
  try {
    if (window.matchMedia && window.matchMedia('(min-width: 700px)').matches) {
      return;                       // на десктопе шторки закрывают кликом
    }
  } catch (e) { /* нет matchMedia — считаем мобильным */ }
  const bodyEl = o.body || rootEl.querySelector('.sheet-body') ||
                 rootEl.querySelector('.drawer-body');
  const grab = o.grab || rootEl.querySelector('.sheet-grab') ||
               rootEl.querySelector('.sheet-head') || rootEl.querySelector('.drawer-head');
  if (!bodyEl || !grab) return;
  const back = rootEl.querySelector('.sheet-back, .drawer-back');
  const axis = o.axis === 'x' ? 'x' : 'y';
  const size = () => (axis === 'x' ? bodyEl.offsetWidth : bodyEl.offsetHeight) || 400;
  const FAR = () => size() + 40;
  let pid = null, start = 0, delta = 0, dragging = false, t0 = 0;

  const paint = (v) => {
    bodyEl.style.transform = axis === 'x'
      ? 'translateX(' + v + 'px)' : 'translateY(' + v + 'px)';
    if (back) back.style.opacity = String(Math.max(0, 1 - Math.abs(v) / FAR()));
  };
  const reset = () => {
    bodyEl.style.transition = '';
    bodyEl.style.transform = '';
    bodyEl.classList.remove('dragging');
    rootEl.classList.remove('drag-on');
    if (back) back.style.opacity = '';
  };
  rootEl.__resetDrag = reset;

  const drop = () => { pid = null; dragging = false; delta = 0; };

  grab.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target && e.target.closest &&
        e.target.closest('button, a, input, textarea, select, label')) return;
    pid = e.pointerId;
    start = axis === 'x' ? e.clientX : e.clientY;
    delta = 0; dragging = false; t0 = Date.now();
  });
  window.addEventListener('pointermove', (e) => {
    if (pid === null || e.pointerId !== pid) return;
    const cur = axis === 'x' ? (start - e.clientX) : (e.clientY - start);
    if (!dragging) {
      if (cur <= 6) { if (cur < -6) drop(); return; }
      dragging = true;
      bodyEl.classList.add('dragging');
      rootEl.classList.add('drag-on');
      try { grab.setPointerCapture(pid); } catch (err) { /* без захвата */ }
    }
    delta = Math.max(0, cur);
    if (e.cancelable) e.preventDefault();
    paint(delta);
  }, { passive: false });
  const finish = (e) => {
    if (pid === null || (e && e.pointerId !== pid)) return;
    const was = dragging, d = delta, dt = Math.max(1, Date.now() - t0);
    drop();
    if (!was) return;
    bodyEl.classList.remove('dragging');
    const flick = d / dt > 0.5;                    // быстрый бросок, px/мс
    if (d > Math.min(140, size() * 0.3) || flick) {
      if (!prefersReduced()) {
        bodyEl.style.transition = 'transform .2s var(--ease), opacity .2s linear';
        paint(FAR());
        if (back) back.style.opacity = '0';
        setTimeout(() => { (o.close || (() => {}))(); }, 165);
        return;
      }
      (o.close || (() => {}))();
      return;
    }
    if (!prefersReduced()) bodyEl.style.transition = 'transform .24s var(--spring)';
    paint(0);
    setTimeout(() => { if (!dragging) reset(); }, 240);
  };
  window.addEventListener('pointerup', finish);
  window.addEventListener('pointercancel', finish);
}
