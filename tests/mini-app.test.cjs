const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const JS_FILES = [
  'js/i18n.js', 'js/config.js', 'js/api.js', 'js/logos.js', 'js/brand.js', 'js/render.js',
  'js/ui.js', 'js/icons.js', 'js/models.js', 'js/models-list.js', 'app.js',
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
    assert.equal(error.message, 'Voice input is turned off — please type your message.');
    return true;
  });
  assert.equal(warning.hidden, false);
  assert.equal(warning.textContent, 'Voice input is turned off — please type your message.');
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
     'Session could not be verified. Close and reopen the app from the bot chat.'],
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

test('brand star is gone: text wordmark stays, «С» с искрой — единый знак', () => {
  assert.doesNotMatch(html, /M12 1l2\.6 8\.4L23 12/);
  assert.doesNotMatch(html, /boot-spark|empty-spark/);
  assert.match(html, /class="brand-word boot-word"[^>]*><span class="brand-name" data-i18n="brand\.name">Speransky<\/span><span class="brand-ai">AI<\/span>/);
  /* знак: дуга-«С» и искра ИИ, в шапке — название чата вместо буквы-заглушки */
  assert.match(html, /class="lg-c" d="M14\.2 7\.5A5\.3 5\.3 0 1 0 14\.2 16\.5"/);
  assert.match(html, /class="lg-spark"/);
  assert.match(css, /\.logo\s*\{[^}]*background:\s*linear-gradient/);
  assert.doesNotMatch(css + app + html, /brandMark|\.brand-mark\s*\{/);
  assert.match(html, /<span class="head-title" id="head-title"/);
});

test('brand glyph in index.html and js/brand.js cannot drift apart', () => {
  const start = html.indexOf('<span class="logo logo-boot"');
  assert.ok(start > 0, 'boot mark is inline in index.html');
  const inlineLogo = html.slice(start, html.indexOf('</span>', html.indexOf('</svg>', start)));
  const brandJs = fs.readFileSync(path.join(root, 'js/brand.js'), 'utf8')
    .replace(/'\s*\+\s*'/g, '');            // склейка строковых литералов
  const paths = (s) => [...s.matchAll(/d="([^"]+)"/g)]
    .map((m) => m[1].replace(/\s+/g, ' ').trim()).sort();
  assert.deepEqual(paths(brandJs), paths(inlineLogo),
    'paths in js/brand.js must match the inline boot logo');
  assert.match(brandJs, /function paintLogos\(/);
  assert.match(brandJs, /class="logo-glyph"/);
});

test('no CSS animation can hide the mark when motion is reduced', () => {
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.logo \.lg-c\s*\{\s*stroke-dashoffset:\s*0\s*!important/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.logo \.lg-spark\s*\{\s*opacity:\s*1\s*!important/);
});

test('header keeps the chat context: title, model pill, generation bar', () => {
  assert.match(html, /<button id="btn-model"[\s\S]*?id="hp-logo"[\s\S]*?id="hp-name"/);
  assert.match(html, /id="gen-bar"/);
  assert.match(app, /const tt = \$\('#head-title'\)/);
  assert.match(app, /name\.textContent = shortModel\(state\.current\.model\)/);
  assert.match(app, /lg\.innerHTML = logoHtml\(state\.current\.provider\)/);
  assert.match(app, /g\.hidden = !busy/);
});

test('list of chats is grouped by time and shows human dates', () => {
  assert.match(app, /fmtWhen\(c\.updated_at\)/);
  assert.match(app, /dayBucket\(c\.updated_at\)/);
  assert.match(app, /'chat\.group\.pinned', \[\]/);
  assert.doesNotMatch(app, /slice\(5, 16\)/);
});

test('reading history is not interrupted: follow-bottom only near the bottom', () => {
  assert.match(app, /function scrollBottom\(force\)/);
  assert.match(app, /state\.stickBottom === false/);
  assert.match(app, /if \(!force && state\.stickBottom === false\)/);
  assert.match(html, /id="scroll-fab"/);
  assert.match(html, /id="fab-dot"/);
  assert.match(app, /document\.addEventListener\('keydown'/);
});

test('no dead “скоро” menu rows: only real actions in the chat menu', () => {
  assert.doesNotMatch(html, /id="cm-project"|id="cm-archive"/);
  assert.doesNotMatch(app, /cm-project|cm-archive/);
  assert.match(html, /id="cm-rename"/);
  assert.match(html, /id="cm-rename-form"/);
  assert.match(app, /api\('PUT', `\/api\/chats\/\$\{cur\.id\}`, \{ title \}\)/);
});

test('the bot API contract is untouched', () => {
  for (const ep of ['/api/boot', '/api/models', '/api/chats', '/api/chat',
                    '/api/quota', '/api/stats', '/api/debug']) {
    assert.ok(app.includes(ep), ep + ' still requested');
  }
  assert.match(app, /initData: INIT_DATA, provider: cur\.provider, model: cur\.model/);
  assert.match(app, /messages: cur\.messages, stream: !NO_STREAM/);
  assert.match(app, /applyImageWindow\(clean\)/);
});

test('models sheet has search, skeleton and a check on the current model', () => {
  assert.match(html, /id="model-search"/);
  assert.match(app, /state\.modelQuery/);
  assert.match(app, /sk-row/);
  assert.match(app, /renderModelsList/);
});

test('model chooser keeps all requested categories and disables unavailable models', () => {
  const list = fs.readFileSync(path.join(root, 'js/models-list.js'), 'utf8');
  for (const category of ['recommended', 'all', 'code', 'image', 'video']) {
    assert.match(list, new RegExp(`id: '${category}'`), `${category} category is retained`);
  }
  assert.match(app, /modelTab: 'recommended'/);
  assert.match(list, /m\.available !== false/);
  assert.match(list, /toLowerCase\(\) !== 'dead'/);
  assert.match(list, /row\.disabled = !selectable/);
  assert.match(list, /model-recommend-hint/);
  assert.match(list, /model-capability/);
  assert.match(css, /\.model-recommend-hint/);
  assert.match(css, /\.model-capability/);
});

test('sheets can be swiped away by the handle only', () => {
  assert.match(html, /class="sheet-grab"/);
  assert.match(app, /enableDragClose\(/);
  assert.match(app, /el\.__dragReady = true/);
  const ui = fs.readFileSync(path.join(root, 'js/ui.js'), 'utf8');
  assert.match(ui, /function enableDragClose\(/);
  assert.match(ui, /closest\('button, a, input, textarea, select, label'\)/);
  assert.match(css, /\.sheet-grab\s*\{[^}]*touch-action:\s*none/);
});

test('low quota is warned right above the composer', () => {
  assert.match(html, /id="quota-hint"/);
  assert.match(html, /id="quota-hint-tx"/);
  assert.match(app, /q\.left_day <= 5/);
  assert.match(app, /tPlural\('quota\.request', q\.left_day\)/);
});

test('code blocks can be copied without leaking the button label', () => {
  assert.match(html + app, /copyText\(txt, true\)/);
  assert.match(app, /function addCodeCopy\(/);
  assert.match(app, /pre\.querySelector\('code'\)/);
  assert.match(css, /\.code-copy\s*\{/);
});

test('empty screen positions a universal assistant, not "school and uni"', () => {
  assert.doesNotMatch(html + app, /школьному и универу/);
  assert.match(html, /Your all-purpose assistant for writing, coding, explanations, planning, and learning\./);
  assert.match(app, /'empty\.description': 'Универсальный помощник: текст, код, объяснение, план, учёба\./);
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

test('sheets announce themselves as dialogs and close on Escape', () => {
  for (const id of ['chats-sheet', 'model-sheet', 'settings-sheet',
                    'data-sheet', 'files-sheet', 'find-sheet']) {
    assert.match(html, new RegExp(`id="${id}"[^>]*role="dialog" aria-modal="true" aria-label="`),
      id + ' is a dialog');
  }
  assert.match(app, /document\.addEventListener\('keydown',[\s\S]*?e\.key !== 'Escape'/);
  assert.match(app, /for \(const id of SHEETS\) \{\s*\n\s*if \(!\$\(id\)\.hidden\) \{ closeSheets\(\); return; \}/);
});
