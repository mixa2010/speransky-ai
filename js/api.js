/* Telegram-инициализация и сетевой слой (api). Выделено из app.js; загружается до app.js
   и разделяет с ним глобальную область (обычный скрипт). */
'use strict';
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
    if (res.status === 410 && data.error === 'voice_disabled') {
      warn(VOICE_DISABLED_MESSAGE);
      throw Object.assign(new Error(VOICE_DISABLED_MESSAGE),
                          { code: 410, voiceDisabled: true });
    }
    throw Object.assign(new Error(data.error || ('HTTP ' + res.status)),
                        { code: res.status });
  }
  return data;
}

