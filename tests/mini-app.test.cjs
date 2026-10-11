const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const JS_FILES = [
  'js/config.js', 'js/api.js', 'js/logos.js', 'js/render.js',
  'js/icons.js', 'js/models.js', 'js/models-list.js', 'app.js',
];
// Все скрипты читаются в порядке загрузки из index.html (обычные скрипты
// делят глобальную область), поэтому проверки видят весь клиент целиком.
const app = JS_FILES.map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

function loadApi(fetchImpl, extra) {
  const warning = { hidden: true, textContent: '' };
  const document = {
    readyState: 'loading',
    addEventListener() {},
    querySelector(selector) {
      return selector === '#warn' ? warning : null;
    },
  };
  const context = {
    window: { Telegram: null },
    document,
    navigator: { userAgent: '', platform: '', maxTouchPoints: 0 },
    location: { search: '' },
    URLSearchParams,
    fetch: fetchImpl,
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    console,
  };
  vm.createContext(context);
  vm.runInContext(`${app}\nglobalThis.__testApi = api;`, context);
  return { api: context.__testApi, warning, ctx: context };
}

test('voice I/O is absent while regular text compose/send controls remain', () => {
  for (const apiName of [
    /\bSpeechRecognition\b/,
    /\bwebkitSpeechRecognition\b/,
    /\bMediaRecorder\b/,
    /\bgetUserMedia\b/,
    /\bspeechSynthesis\b/,
    /\bSpeechSynthesisUtterance\b/,
    /\/api\/transcribe/,
  ]) {
    assert.doesNotMatch(app, apiName);
  }
  assert.doesNotMatch(app, /navigator\.(?:mediaDevices|permissions)/);

  assert.doesNotMatch(html, /id="(?:btn-mic|btn-voice|rec-bar|voice-overlay|vo-mic|set-voice|set-speak|set-cont)"/);
  assert.doesNotMatch(html, /Голосовой режим|Голосовой ввод|Озвучивать ответы/);
  assert.match(html, /<textarea id="input" rows="1"/);
  assert.match(html, /<button id="btn-send"/);
  assert.doesNotMatch(html, /inputmode="none"|readonly/);

  assert.doesNotMatch(css, /\.rec-bar\b|\.voice-btn\b|\.voice-overlay\b|\.vo-mic\b|\.orb\b/);
});

test('text can still be submitted from the send button or Enter key', () => {
  assert.match(app, /opts\.text != null \? String\(opts\.text\) : input\.value\.trim\(\)/);
  assert.match(app, /input\.addEventListener\('keydown',[\s\S]*?send\(\);/);
  assert.match(app, /\$\('#btn-send'\)\.onclick = \(\) => \{[\s\S]*?send\(\);/);
  assert.match(html, /<textarea id="input" rows="1"/);
});

test('legacy voice_disabled response becomes a short, non-technical warning', async () => {
  const { api, warning } = loadApi(async () => ({
    ok: false,
    status: 410,
    json: async () => ({ error: 'voice_disabled' }),
  }));

  await assert.rejects(api('POST', '/api/legacy-voice', {}), (error) => {
    assert.equal(error.code, 410);
    assert.equal(error.voiceDisabled, true);
    assert.equal(error.message, 'Голосовой ввод отключён — напишите запрос текстом');
    return true;
  });
  assert.equal(warning.hidden, false);
  assert.equal(warning.textContent, 'Голосовой ввод отключён — напишите запрос текстом');
});

test('boot mark animates once for 600 ms, respects reduced motion, and does not delay boot', () => {
  assert.match(css, /\.boot-word\s*\{[^}]*animation:\s*boot-mark-in\s+600ms\s+var\(--ease\)\s+both/s);
  assert.match(css, /@keyframes boot-mark-in\s*\{/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?animation:\s*none\s*!important/);
  assert.doesNotMatch(app, /setTimeout\s*\(\s*boot\b/);
  assert.match(app, /document\.addEventListener\('DOMContentLoaded', boot, \{ once: true \}\)/);
});

const respond = (status, body) => async () => ({ ok: status < 400, status, json: async () => body });

test('403 subscribe: server text and channel_url, no "access list" wording', async () => {
  const { api } = loadApi(respond(403, { code: 'subscribe',
    error: 'Подпишись на канал, чтобы продолжить.', channel_url: 'https://t.me/ch' }));
  await assert.rejects(api('GET', '/api/boot'), (e) => {
    assert.equal(e.code, 403);
    assert.equal(e.kind, 'subscribe');
    assert.equal(e.human, 'Подпишись на канал, чтобы продолжить.');
    assert.equal(e.channelUrl, 'https://t.me/ch');
    return true;
  });
  assert.doesNotMatch(app, /списке доступа/);
  assert.match(app, /openTelegramLink/);
});

test('503 maintenance, 429 quota, 503 busy, 409 chat_limit and 401 map to readable text', async () => {
  const cases = [
    [503, { code: 'maintenance', message: 'Техработы до 15:00' }, 'maintenance', 'Техработы до 15:00'],
    [429, { error: 'quota', message: 'Лимит на сегодня закончился' }, 'quota', 'Лимит на сегодня закончился'],
    [503, { error: 'busy', message: 'Много запросов, подожди минуту' }, 'busy', 'Много запросов, подожди минуту'],
    [409, { code: 'chat_limit', error: 'Не больше 50 чатов' }, 'chat_limit', 'Не больше 50 чатов'],
    [401, { error: 'unauthorized' }, 'session',
     'Сессия не подтвердилась. Закрой и открой приложение из чата с ботом.'],
  ];
  for (const [status, body, kind, human] of cases) {
    const { api } = loadApi(respond(status, body));
    await assert.rejects(api('POST', '/api/x', {}), (e) => {
      assert.equal(e.code, status);
      assert.equal(e.kind, kind);
      assert.equal(e.human, human);
      return true;
    });
  }
});

test('initData goes with every api() request', async () => {
  const seen = [];
  const { api } = loadApi(async (url, opts) => {
    seen.push({ url, body: opts.body });
    return { ok: true, status: 200, json: async () => ({}) };
  });
  await api('GET', '/api/quota');
  await api('POST', '/api/chats', { title: 't' });
  assert.match(seen[0].url, /[?&]initData=/);
  assert.ok('initData' in JSON.parse(seen[1].body));
});

test('boot does not silently fall back when the server refuses (maintenance/subscribe/401)', () => {
  assert.match(app, /if \(e\.kind \|\| e\.code === 401 \|\| e\.code === 403\) throw e;/);
  assert.match(app, /mergePolicy\(b\.policy\)/);
});

test('filtered replies do not decrement the quota pill', () => {
  assert.match(app, /if \(!r\.filtered && state\.quota/);
  assert.match(app, /Поддержать · бесплатно/);
  assert.doesNotMatch(app + html, /снимает лимит|без лимита за донат/i);
});

test('brand star is gone: text wordmark on boot, no giant star on empty screen, «С» in header', () => {
  assert.doesNotMatch(html, /M12 1l2\.6 8\.4L23 12/);
  assert.doesNotMatch(html, /boot-spark|empty-spark/);
  assert.match(html, /class="brand-word boot-word"[^>]*><span class="brand-name">Сперанский<\/span><span class="brand-ai">AI<\/span>/);
  assert.match(html, /<button id="btn-ctx"[\s\S]*?<span class="brand-mark" aria-hidden="true">С<\/span>/);
  assert.match(css, /\.brand-mark\s*\{/);
});

test('empty screen positions a universal assistant, not "school and uni"', () => {
  assert.doesNotMatch(html + app, /школьному и универу/);
  assert.match(html, /Универсальный помощник: текст, код, объяснение, план, учёба\./);
  assert.doesNotMatch(app, /Реши задачу по фото|пробник/);
});

test('keyboard shield sits over the chat only and blurs on first touch', () => {
  assert.match(html, /<div id="kb-shield" class="kb-shield" hidden/);
  const z = (sel) => Number((css.match(new RegExp(sel + '\\s*\\{[^}]*z-index:\\s*(\\d+)')) || [])[1]);
  assert.ok(z('\\.kb-shield') < z('\\.composer'), 'shield is below the composer');
  assert.ok(z('\\.kb-shield') < z('#head'), 'shield is below the header');
  assert.ok(z('\\.kb-shield') < z('\\.sheet'), 'shield is below sheets');
  assert.match(app, /addEventListener\('touchstart', onDown/);
  assert.match(app, /addEventListener\('pointerdown', onDown\)/);
  assert.match(app, /hide\(\);\s*input\.blur\(\);/);
});

test('no Cloudflare challenge script in index.html', () => {
  assert.doesNotMatch(html, /cdn-cgi|__CF\$cv\$params/);
});
