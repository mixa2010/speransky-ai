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

/* Ссылки t.me открываем внутри Telegram, остальные — внешним браузером. */
function openExternal(url) {
  const u = String(url || '');
  if (!/^https?:\/\//i.test(u)) return;
  const isTg = /^https?:\/\/(?:t\.me|telegram\.me)\//i.test(u);
  try {
    if (tg && isTg && tg.openTelegramLink) return tg.openTelegramLink(u);
    if (tg && tg.openLink) return tg.openLink(u);
  } catch (e) { /* старый клиент — ниже обычное окно */ }
  window.open(u, '_blank', 'noopener');
}

/* ================= понятные ошибки сервера ================= */
/* Человеческий текст из ответа: message, затем error. Машинные метки
   вида "quota" / "subscribe" пропускаем — их показывать нельзя. */
function serverText(data, fallback) {
  for (const v of [data && data.message, data && data.error]) {
    const s = typeof v === 'string' ? v.trim() : '';
    if (s && !/^[a-z0-9_.:-]+$/i.test(s)) return s;
  }
  return fallback;
}

/* Разбор неуспешного ответа: code — HTTP-статус (как и раньше),
   reason — машинная причина сервера, human — что показать человеку
   (только для известных случаев; иначе null и UI пишет своё). */
function apiError(status, data) {
  data = data || {};
  const reason = String(data.code || data.error || '');
  let human = null;
  let kind = '';
  if (status === 401) {
    kind = 'session';
    human = t('error.session');
  } else if (status === 403 && reason === 'subscribe') {
    kind = 'subscribe';
    human = serverText(data, t('api.subscribeFallback'));
  } else if (status === 503 && reason === 'maintenance') {
    kind = 'maintenance';
    human = serverText(data, t('api.maintenanceFallback'));
  } else if (status === 429 && data.error === 'quota') {
    kind = 'quota';
    human = serverText({ message: data.message }, t('api.quotaFallback'));
  } else if (status === 503 && data.error === 'busy') {
    kind = 'busy';
    human = serverText({ message: data.message }, t('api.busyFallback'));
  } else if (status === 409 && reason === 'chat_limit') {
    kind = 'chat_limit';
    human = serverText(data, t('api.chatLimitFallback'));
  } else if (status === 403) {
    kind = 'forbidden';
    human = serverText(data, null);
  }
  const err = new Error(human || (data.error ? String(data.error) : ('HTTP ' + status)));
  err.code = status;
  err.reason = reason;
  err.kind = kind;
  err.human = human;
  err.data = data;
  err.channelUrl = typeof data.channel_url === 'string' ? data.channel_url : '';
  return err;
}

/* ================= сеть ================= */
async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  const lang = uiLang();
  const payload = body ? Object.assign({}, body) : {};
  if (method !== 'GET' && method !== 'DELETE') {
    payload.initData = INIT_DATA;
    payload.lang = lang;                 // локализованные ответы сервера
  }
  let url = API_BASE + path;
  if (method === 'GET' || method === 'DELETE') {
    url += (path.includes('?') ? '&' : '?') +
           'initData=' + encodeURIComponent(INIT_DATA) +
           '&lang=' + encodeURIComponent(lang);
  }
  if (method !== 'GET') opts.body = JSON.stringify(payload);
  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    throw Object.assign(new Error(t('api.serverOffline')), { code: 0, net: true });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 410 && data.error === 'voice_disabled') {
      const voiceMessage = t('error.voiceDisabled');
      warn(voiceMessage);
      throw Object.assign(new Error(voiceMessage),
                          { code: 410, voiceDisabled: true });
    }
    throw apiError(res.status, data);
  }
  return data;
}
