/* Живой прогон клиента в jsdom: index.html + все скрипты в порядке загрузки,
   фальшивые Telegram и fetch. Проверяем запуск, отправку сообщения, шторки,
   настройки и «отказные» экраны сервера — то, что не увидеть в регулярках.

   Тест необязательный: нужен jsdom. Запуск:

     npm i --no-save jsdom
     node tests/dom-smoke.cjs

   Код возврата 0 — всё хорошо, 1 — есть проблемы, 2 — нет jsdom / краш. */
const fs = require('node:fs');
const path = require('node:path');

let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require('jsdom'));
} catch (e) {
  console.log('jsdom не установлен — пропускаю (npm i --no-save jsdom).');
  process.exit(2);
}

const ROOT = path.resolve(__dirname, '..');
const JS_FILES = ['js/i18n.js', 'js/config.js', 'js/api.js', 'js/logos.js', 'js/brand.js', 'js/render.js',
  'js/ui.js', 'js/icons.js', 'js/models.js', 'js/models-list.js', 'app.js'];
const APP = JS_FILES.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const problems = [];
const check = (name, ok, extra) => {
  console.log((ok ? '✓ ' : '✗ ') + name + (ok ? '' : '  → ' + extra));
  if (!ok) problems.push(name + ': ' + extra);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const json = (body, status = 200) => ({
  ok: status < 400, status, bodyUsed: false,
  headers: { get: () => 'application/json' }, json: async () => body,
});
const ndjson = (lines, trailingNewline = true) => {
  const enc = new TextEncoder();
  const chunks = lines.map((l, i) => enc.encode(JSON.stringify(l) +
    (i === lines.length - 1 && !trailingNewline ? '' : '\n')));
  let i = 0;
  return {
    ok: true, status: 200, bodyUsed: false,
    headers: { get: () => 'application/x-ndjson' },
    body: { getReader: () => ({ read: async () => (i < chunks.length
      ? { done: false, value: chunks[i++] } : { done: true, value: undefined }) }) },
  };
};

function makeWindow(handler, opts) {
  const vc = new VirtualConsole();
  const dom = new JSDOM(HTML, {
    runScripts: 'outside-only', pretendToBeVisual: true,
    url: (opts && opts.url) || 'https://app.example/?initData=test', virtualConsole: vc,
  });
  const w = dom.window;
  if (opts && opts.prefs) w.localStorage.setItem('sp_prefs_v1', JSON.stringify(opts.prefs));
  if (!(opts && opts.noTelegram)) {
    const tgCalls = [];
    w.Telegram = { WebApp: {
      initData: 'test', colorScheme: 'dark', initDataUnsafe: { user: { first_name: 'Миша' } },
      ready() {}, expand() {}, setHeaderColor() {}, disableVerticalSwipes() {}, onEvent() {},
      HapticFeedback: { impactOccurred() {}, selectionChanged() {}, notificationOccurred() {} },
      openTelegramLink(u) { tgCalls.push({ kind: 'telegram', url: String(u) }); },
      openLink(u) { tgCalls.push({ kind: 'link', url: String(u) }); },
    } };
    w.__tgCalls = tgCalls;
  }
  w.__requests = [];
  w.fetch = (u, o) => {
    w.__requests.push({ url: String(u), body: (o && o.body) || null });
    return handler(String(u), o || {});
  };
  w.TextEncoder = TextEncoder;
  w.TextDecoder = TextDecoder;
  vc.on('jsdomError', (e) => problems.push('jsdomError: ' + e.message));
  w.eval(APP);
  return w;
}

/* Буфер обмена в jsdom отсутствует — сценарии копирования пишут сюда. */
function stubClipboard(w) {
  const copied = [];
  Object.defineProperty(w.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text) => { copied.push(String(text)); } },
  });
  return copied;
}

const MODELS = [
  { provider: 'gemini', model: 'gemini-2.5-flash', state: 'ok', available: true, vision: true, recommended: true },
  { provider: 'groq', model: 'llama-3.3-70b', state: 'ok', available: true },
  { provider: 'mistral', model: 'codestral-latest', state: 'cooldown', available: true },
  { provider: 'old', model: 'retired-model', state: 'dead', available: true },
  { provider: 'test', model: 'disabled-model', state: 'ok', available: false },
];
const CHATS = [
  { id: 'c1', title: 'Разбор контрольной', model: 'gemini/gemini-2.5-flash',
    updated_at: new Date().toISOString() },
  { id: 'c2', title: 'План подготовки', model: 'groq/llama-3.3-70b',
    updated_at: new Date(Date.now() - 86400000).toISOString() },
];

/* ================= markdown sanitizer ================= */
function markdownSafety() {
  const dom = new JSDOM('<!doctype html><html><body><div id="target"></div></body></html>', {
    runScripts: 'outside-only', url: 'https://app.example/',
  });
  const w = dom.window;
  w.t = (key) => key;
  w.marked = {
    setOptions() {},
    parse: () => '<p>safe <strong>bold</strong></p>' +
      '<img src="https://images.example/p.png" onerror="window.__xss=1" style="display:none">' +
      '<a href="javascript:window.__xss=2" onclick="window.__xss=3">unsafe link</a>' +
      '<a href="https://safe.example/" target="_blank">safe link</a>' +
      '<script>window.__xss=4</script><svg onload="window.__xss=5"><text>bad</text></svg>' +
      '<pre><code>const answer = 42;</code></pre>',
  };
  w.eval(fs.readFileSync(path.join(ROOT, 'js/render.js'), 'utf8') +
    '\nglobalThis.__renderRich = renderRich;');
  const target = w.document.querySelector('#target');
  w.__renderRich(target, 'untrusted model output');
  check('markdown keeps normal formatting', !!target.querySelector('p strong'), target.innerHTML);
  check('markdown removes active elements and event/style attributes',
    !target.querySelector('script, svg') &&
      [...target.querySelectorAll('*')].every((el) =>
        ![...el.attributes].some((attr) => /^on/i.test(attr.name) || attr.name === 'style')),
    target.innerHTML);
  const unsafe = [...target.querySelectorAll('a')].find((a) => a.textContent === 'unsafe link');
  const safe = [...target.querySelectorAll('a')].find((a) => a.textContent === 'safe link');
  check('markdown rejects javascript URLs and protects new tabs',
    !!unsafe && !unsafe.hasAttribute('href') && !!safe &&
      safe.getAttribute('rel') === 'noopener noreferrer', target.innerHTML);
  check('markdown retains valid remote images without event handlers',
    !!target.querySelector('img[src="https://images.example/p.png"]') &&
      !target.querySelector('img[onerror]'), target.innerHTML);
  dom.window.close();
}

/* ================= 1. счастливый путь ================= */
async function happyPath() {
  let sent = null;
  const handler = (u, o) => {
    const method = o.method || 'GET';
    if (u.includes('/api/boot')) {
      return Promise.resolve(json({ models: MODELS, chats: CHATS,
        policy: { free: true, donate_url: 'https://example.org/donate', donate_note: 'по желанию' } }));
    }
    if (u.includes('/api/quota')) return Promise.resolve(json({ left_day: 3, unlimited: false }));
    if (u.includes('/api/stats')) return Promise.resolve(json({ total: 12, today: 3 }));
    if (/\/api\/chats(\/|$|\?)/.test(u)) {
      if (method === 'POST') {
        const body = JSON.parse(o.body);
        return Promise.resolve(json({ id: 'new1', title: body.title, model: body.model,
          updated_at: new Date().toISOString() }));
      }
      if (method === 'PUT' || method === 'DELETE') return Promise.resolve(json({ ok: true }));
      return Promise.resolve(json(Object.assign({}, CHATS[0], {
        messages: [{ role: 'user', content: 'старый вопрос' },
                   { role: 'assistant', content: 'старый ответ', model: 'gemini-2.5-flash' }],
      })));
    }
    if (u.includes('/api/chat')) {
      sent = JSON.parse(o.body);
      return Promise.resolve(ndjson([
        { d: 'Привет! ' }, { d: '**ответ** ' }, { d: 'на вопрос.' },
        { provider: 'gemini', model: 'gemini-2.5-flash', reply: 'Привет! **ответ** на вопрос.',
          filtered: false, fallbacks: [] },
      ], false)); // also cover a final NDJSON record without a trailing LF
    }
    return Promise.resolve(json({}));
  };

  const w = makeWindow(handler);
  const d = w.document;
  const $ = (s) => d.querySelector(s);
  await sleep(80);

  check('first launch defaults to English', d.documentElement.lang === 'en' &&
    $('#empty-title').textContent === 'Hi! I’m Speransky AI',
    d.documentElement.lang + ' / ' + $('#empty-title').textContent);
  check('стартовый экран уступает место шапке', $('#boot').hidden === true && $('#head').hidden === false,
    'boot/head видимость');
  check('в шапке название чата и модель',
    $('#head-title').textContent === 'Разбор контрольной' &&
    /gemini-2\.5-flash/.test($('#hp-name').textContent),
    $('#head-title').textContent + ' / ' + $('#hp-name').textContent);
  check('логотип провайдера в пилюле', $('#hp-logo').innerHTML.length > 0, 'пусто');
  check('знак отрисован во всех заготовках',
    d.querySelectorAll('.logo-glyph').length >= 3, String(d.querySelectorAll('.logo-glyph').length));
  check('четыре плитки быстрых действий', d.querySelectorAll('#quick-actions .qa-tile').length === 4,
    String(d.querySelectorAll('#quick-actions .qa-tile').length));

  $('#btn-chats').click();
  await sleep(30);
  check('чаты сгруппированы по времени', d.querySelectorAll('#chats-list .chat-group').length >= 2,
    $('#chats-list').textContent.slice(0, 60));
  check('человеческое время вместо машинного',
    /(вчера|\d\d:\d\d|\d+ [а-я]{3})/.test($('#chats-list').textContent),
    $('#chats-list').textContent.slice(0, 90));
  $('#chats-sheet .drawer-back').click();
  await sleep(20);

  $('#input').value = 'Помоги с задачей';
  $('#input').dispatchEvent(new w.Event('input'));
  check('кнопка отправки загорается', $('#composer').classList.contains('has-text'), 'нет класса');
  $('#btn-send').click();
  await sleep(220);
  check('вопрос и ответ в ленте', d.querySelectorAll('#messages .msg').length >= 2,
    'сообщений: ' + d.querySelectorAll('#messages .msg').length);
  check('ответ отрисован стримом', /ответ/.test($('#messages').textContent),
    $('#messages').textContent.slice(-60));
  check('мета модели под ответом', $('#messages .msg-meta') !== null, 'нет меты');
  check('действия под ответом', $('#messages .msg-actions') !== null, 'нет действий');
  check('контракт запроса не тронут',
    sent && sent.provider === 'gemini' && sent.model === 'gemini-2.5-flash' &&
    Array.isArray(sent.messages) && sent.stream === true, JSON.stringify(sent && Object.keys(sent)));
  check('индикатор генерации погас', $('#gen-bar').hidden === true, 'всё ещё бежит');

  $('#btn-model').click();
  await sleep(30);
  check('model chooser opens on Recommended with guidance',
    [...d.querySelectorAll('.cat-tab')].some((b) => b.classList.contains('active') && /For you/.test(b.textContent)) &&
      !!$('#models-list .model-recommend-hint'),
    [...d.querySelectorAll('.cat-tab')].map((b) => b.textContent).join(' / '));
  const recommendedRows = [...d.querySelectorAll('#models-list .model-row')];
  check('Recommended lists selectable models first and excludes unavailable models',
    recommendedRows.length === 3 && /gemini-2\.5-flash/.test(recommendedRows[0].textContent) &&
      !recommendedRows.some((row) => /retired-model|disabled-model/.test(row.textContent)),
    recommendedRows.map((row) => row.textContent).join(' | '));
  check('photo support is clearly labelled on vision models',
    !!recommendedRows[0].querySelector('.model-capability') &&
      /Understands photos/.test(recommendedRows[0].textContent),
    recommendedRows[0] && recommendedRows[0].textContent);
  const allTab = [...d.querySelectorAll('.cat-tab')].find((b) => /^All/.test(b.textContent.trim()));
  allTab.click();
  await sleep(30);
  const allRows = [...d.querySelectorAll('#models-list .model-row')];
  const deadRow = allRows.find((row) => /retired-model/.test(row.textContent));
  const unavailableRow = allRows.find((row) => /disabled-model/.test(row.textContent));
  check('All shows the complete catalogue and makes dead/unavailable rows disabled',
    allRows.length === MODELS.length && !!deadRow && deadRow.disabled &&
      !!unavailableRow && unavailableRow.disabled,
    allRows.map((row) => row.textContent + (row.disabled ? ' [disabled]' : '')).join(' | '));
  const codeTab = [...d.querySelectorAll('.cat-tab')].find((b) => /Code/.test(b.textContent));
  codeTab.click();
  await sleep(30);
  check('Code tab still shows code models', /codestral/.test($('#models-list').textContent),
    $('#models-list').textContent.slice(0, 50));
  const imageTab = [...d.querySelectorAll('.cat-tab')].find((b) => /Images/.test(b.textContent));
  const videoTab = [...d.querySelectorAll('.cat-tab')].find((b) => /Video/.test(b.textContent));
  check('image and video generation tabs are preserved', !!imageTab && !!videoTab,
    [...d.querySelectorAll('.cat-tab')].map((b) => b.textContent).join(' / '));
  imageTab.click();
  await sleep(20);
  const imagePlaceholder = /Image generation/.test($('#models-list').textContent) &&
    /Soon/.test($('#models-list').textContent);
  videoTab.click();
  await sleep(20);
  check('image/video tabs retain their coming-soon panels', imagePlaceholder &&
    /Video generation/.test($('#models-list').textContent) && /Soon/.test($('#models-list').textContent),
    $('#models-list').textContent);
  $('#model-search').value = 'llama';
  $('#model-search').dispatchEvent(new w.Event('input'));
  await sleep(20);
  check('search still finds models across every category', /llama-3\.3-70b/.test($('#models-list').textContent),
    $('#models-list').textContent.slice(0, 60));
  $('#model-search').value = 'disabled-model';
  $('#model-search').dispatchEvent(new w.Event('input'));
  await sleep(20);
  check('global search does not make disabled models selectable',
    d.querySelector('#models-list .model-row')?.disabled === true,
    $('#models-list').textContent);
  $('#model-search-clear').click();
  await sleep(20);
  check('resetting global search restores current tab content',
    /Video generation/.test($('#models-list').textContent), $('#models-list').textContent);
  $('#model-sheet .sheet-close').click();
  await sleep(20);

  $('#btn-chats').click();
  await sleep(20);
  $('#btn-settings').click();
  await sleep(20);
  check('настройки: имя из Telegram', $('#set-name').textContent === 'Миша', $('#set-name').textContent);
  check('language selector shows the current native language', $('#set-language-val').textContent === 'English',
    $('#set-language-val').textContent);
  $('#set-language').click();
  await sleep(10);
  check('language list opens', $('#set-language-options').hidden === false, 'still hidden');
  d.querySelector('[data-language-opt="ru"]').click();
  await sleep(20);
  check('language changes immediately and is saved', d.documentElement.lang === 'ru' &&
    $('#set-language-val').textContent === 'Русский' &&
    $('#set-theme').querySelector('span').textContent === 'Оформление' &&
    $('#btn-new').querySelector('span').textContent === 'Новый чат' &&
    JSON.parse(w.localStorage.getItem('sp_prefs_v1')).language === 'ru',
    d.documentElement.lang + ' / ' + $('#set-language-val').textContent);
  d.querySelector('[data-language-opt="en"]').click();
  await sleep(20);
  check('English can be selected again', d.documentElement.lang === 'en' &&
    $('#set-language-val').textContent === 'English', $('#set-language-val').textContent);
  $('#set-theme').click();
  await sleep(10);
  check('сегменты темы раскрылись', $('#set-theme-seg').hidden === false, 'скрыто');
  d.querySelector('[data-theme-opt="light"]').click();
  await sleep(10);
  check('ручная светлая тема применена', d.documentElement.dataset.theme === 'light',
    d.documentElement.dataset.theme);
  d.querySelector('[data-accent-opt="violet"]').click();
  await sleep(10);
  check('акцент применён', d.documentElement.dataset.accent === 'violet',
    d.documentElement.dataset.accent);
  check('версия в списке настроек', $('#set-version').textContent === w.__APP_V,
    $('#set-version').textContent + ' vs ' + w.__APP_V);

  $('#settings-sheet .set-close').click();
  await sleep(20);
  $('#btn-ctx').click();
  await sleep(20);
  check('меню чата открыто', $('#chat-menu').hidden === false, 'скрыто');
  $('#cm-rename').click();
  await sleep(10);
  $('#cm-rename-input').value = 'Новое имя';
  $('#cm-rename-form').dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true }));
  await sleep(120);
  check('переименование видно в шапке', $('#head-title').textContent === 'Новое имя',
    $('#head-title').textContent);
  check('переименование видно в списке', $('#chats-list').textContent.includes('Новое имя'),
    'нет в списке');
  $('#btn-ctx').click();
  await sleep(10);
  $('#cm-find').click();
  await sleep(30);
  $('#find-input').value = 'вопрос';
  $('#find-input').dispatchEvent(new w.Event('input'));
  await sleep(20);
  check('поиск в чате находит сообщения', $('#find-list').children.length > 0,
    $('#find-list').textContent.slice(0, 50));
}

async function noSelectableModelGuard() {
  let createPosts = 0;
  const unavailable = [
    { provider: 'old', model: 'retired-model', state: 'dead', available: true },
    { provider: 'offline', model: 'down-model', state: 'ok', available: false },
  ];
  const w = makeWindow((u, o) => {
    const method = o.method || 'GET';
    if (u.includes('/api/boot')) return Promise.resolve(json({ models: unavailable, chats: [] }));
    if (u.includes('/api/quota')) return Promise.resolve(json({ left_day: 9, unlimited: false }));
    if (/\/api\/chats(\/|$|\?)/.test(u) && method === 'POST') {
      createPosts += 1;
      return Promise.resolve(json({ id: 'invalid', model: 'old/retired-model' }));
    }
    return Promise.resolve(json({}));
  });
  await sleep(70);
  const d = w.document;
  d.querySelector('#btn-new').click();
  await sleep(20);
  check('no selectable model opens the chooser instead of creating an invalid chat',
    createPosts === 0 && d.querySelector('#model-sheet').hidden === false &&
      /No models can be selected/.test(d.querySelector('#models-list').textContent),
    `posts=${createPosts}; ${d.querySelector('#models-list').textContent}`);
  [...d.querySelectorAll('.cat-tab')].find((b) => /^All/.test(b.textContent.trim())).click();
  const rows = [...d.querySelectorAll('#models-list .model-row')];
  check('all disabled catalogue entries remain visible but not actionable',
    rows.length === unavailable.length && rows.every((row) => row.disabled),
    rows.map((row) => row.textContent + (row.disabled ? ' [disabled]' : '')).join(' | '));
  w.close();
}

/* ================= запросы/состояние во время отправки ================= */
async function rejectedOptimisticCreate() {
  let chatRequests = 0;
  const w = makeWindow((u, o) => {
    const method = o.method || 'GET';
    if (u.includes('/api/boot')) return Promise.resolve(json({ models: MODELS, chats: [] }));
    if (u.includes('/api/quota')) return Promise.resolve(json({ left_day: 9, unlimited: false }));
    if (/\/api\/chats(\/|$|\?)/.test(u) && method === 'POST') {
      return new Promise((resolve) => setTimeout(() => resolve(json({
        code: 'chat_limit', error: 'chat limit reached',
      }, 409)), 35));
    }
    if (/\/api\/chat(?:\?|$)/.test(u)) chatRequests += 1;
    return Promise.resolve(json({}));
  });
  await sleep(70);
  const d = w.document;
  d.querySelector('#btn-new').click();
  d.querySelector('#input').value = "don't lose this";
  d.querySelector('#input').dispatchEvent(new w.Event('input'));
  d.querySelector('#btn-send').click();
  await sleep(170);
  check('a rejected optimistic chat create does not crash or send against a missing chat',
    chatRequests === 0 && d.querySelectorAll('#messages .msg').length === 0 &&
      d.querySelector('#fatal').hidden === true,
    `requests=${chatRequests}; messages=${d.querySelectorAll('#messages .msg').length}`);
  w.close();
}

async function singleFlight() {
  let createPosts = 0, chatRequests = 0, writes = 0;
  const w = makeWindow((u, o) => {
    const method = o.method || 'GET';
    if (u.includes('/api/boot')) return Promise.resolve(json({ models: MODELS, chats: [] }));
    if (u.includes('/api/quota')) return Promise.resolve(json({ left_day: 9, unlimited: false }));
    if (/\/api\/chats(\/|$|\?)/.test(u) && method === 'POST') {
      createPosts += 1;
      return new Promise((resolve) => setTimeout(() => resolve(json({
        id: 'single', title: 'New chat', model: 'gemini/gemini-2.5-flash',
        updated_at: new Date().toISOString(),
      })), 60));
    }
    if (/\/api\/chat(?:\?|$)/.test(u)) {
      chatRequests += 1;
      return Promise.resolve(json({ reply: 'one answer', provider: 'gemini',
        model: 'gemini-2.5-flash', filtered: false, fallbacks: [] }));
    }
    if (method === 'PUT') { writes += 1; return Promise.resolve(json({ ok: true })); }
    return Promise.resolve(json({}));
  });
  await sleep(70);
  const d = w.document;
  d.querySelector('#input').value = 'one question';
  d.querySelector('#input').dispatchEvent(new w.Event('input'));
  d.querySelector('#btn-send').click();
  d.querySelector('#btn-send').click(); // tap again while chat creation is pending
  await sleep(260);
  check('rapid repeated sends create only one chat and one model request',
    createPosts === 1 && chatRequests === 1 && writes === 1,
    `chats=${createPosts}, requests=${chatRequests}, writes=${writes}`);
  check('single-flight request renders one user/assistant pair',
    d.querySelectorAll('#messages .msg').length === 2,
    String(d.querySelectorAll('#messages .msg').length));
  w.close();
}

async function stoppedStreamIsSaved() {
  const writes = [];
  let otherChatGets = 0;
  const w = makeWindow((u, o) => {
    const method = o.method || 'GET';
    if (u.includes('/api/boot')) return Promise.resolve(json({ models: MODELS, chats: CHATS }));
    if (u.includes('/api/quota')) return Promise.resolve(json({ left_day: 9, unlimited: false }));
    if (u.includes('/api/chats/c1') && method === 'GET') {
      return Promise.resolve(json(Object.assign({}, CHATS[0], { messages: [] })));
    }
    if (u.includes('/api/chats/c2') && method === 'GET') {
      otherChatGets += 1;
      return Promise.resolve(json(Object.assign({}, CHATS[1], { messages: [] })));
    }
    if (/\/api\/chat(?:\?|$)/.test(u)) {
      const signal = o.signal;
      let sent = false;
      const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
      return Promise.resolve({
        ok: true, status: 200, bodyUsed: false,
        headers: { get: () => 'application/x-ndjson' },
        body: { getReader: () => ({ read: () => {
          if (!sent) {
            sent = true;
            return Promise.resolve({ done: false,
              value: new TextEncoder().encode(JSON.stringify({ d: 'Частичный ответ' }) + '\n') });
          }
          return new Promise((resolve, reject) => {
            if (signal.aborted) return reject(abortError());
            signal.addEventListener('abort', () => reject(abortError()), { once: true });
          });
        } }) },
      });
    }
    if (method === 'PUT') {
      writes.push(JSON.parse(o.body));
      return Promise.resolve(json({ ok: true }));
    }
    return Promise.resolve(json({}));
  });
  await sleep(80);
  const d = w.document;
  d.querySelector('#input').value = 'останови меня';
  d.querySelector('#input').dispatchEvent(new w.Event('input'));
  d.querySelector('#btn-send').click();
  await sleep(30);
  d.querySelector('#btn-chats').click();
  const second = [...d.querySelectorAll('#chats-list .chat-row')]
    .find((row) => row.textContent.includes('План подготовки'));
  if (second) second.click();
  check('switching chats is blocked while a reply is active',
    otherChatGets === 0 && d.querySelector('#head-title').textContent === CHATS[0].title,
    `other-chat requests=${otherChatGets}, title=${d.querySelector('#head-title').textContent}`);
  d.querySelector('#btn-send').click();
  await sleep(160);
  const saved = writes.find((body) => Array.isArray(body.messages) &&
    body.messages.some((m) => m.role === 'assistant' && m.content === 'Частичный ответ'));
  check('a user-stopped partial response is persisted to chat history', !!saved,
    JSON.stringify(writes));
  check('saved partial response is marked as saved in the UI',
    /stopped — saved the part/.test(d.querySelector('#messages').textContent),
    d.querySelector('#messages').textContent.slice(-100));
  w.close();
}

async function streamActivityResetsTimeout() {
  let chatRequests = 0;
  const w = makeWindow((u, o) => {
    const method = o.method || 'GET';
    if (u.includes('/api/boot')) return Promise.resolve(json({ models: MODELS, chats: CHATS }));
    if (u.includes('/api/quota')) return Promise.resolve(json({ left_day: 9, unlimited: false }));
    if (u.includes('/api/chats/c1') && method === 'GET') {
      return Promise.resolve(json(Object.assign({}, CHATS[0], { messages: [] })));
    }
    if (/\/api\/chat(?:\?|$)/.test(u)) {
      chatRequests += 1;
      const enc = new TextEncoder();
      const records = [
        { d: 'part ' }, { d: 'of answer' },
        { provider: 'gemini', model: 'gemini-2.5-flash', reply: 'part of answer',
          filtered: false, fallbacks: [] },
      ];
      let i = 0;
      return Promise.resolve({
        ok: true, status: 200, bodyUsed: false,
        headers: { get: () => 'application/x-ndjson' },
        body: { getReader: () => ({ read: () => new Promise((resolve) => setTimeout(() => {
          if (i < records.length) {
            const record = records[i++];
            resolve({ done: false, value: enc.encode(JSON.stringify(record) +
              (i === records.length ? '' : '\n')) });
          } else resolve({ done: true, value: undefined });
        }, 10)) }) },
      });
    }
    return Promise.resolve(json({ ok: true }));
  });
  await sleep(80);
  const nativeSetTimeout = w.setTimeout.bind(w);
  w.setTimeout = (fn, ms, ...args) => nativeSetTimeout(fn,
    ms === 95000 ? 22 : ms, ...args);
  const d = w.document;
  d.querySelector('#input').value = 'ответь постепенно';
  d.querySelector('#input').dispatchEvent(new w.Event('input'));
  d.querySelector('#btn-send').click();
  await sleep(160);
  check('stream chunks reset the idle timeout instead of imposing a total deadline',
    chatRequests === 1 && d.querySelector('#messages').textContent.includes('part of answer'),
    `requests=${chatRequests}; ${d.querySelector('#messages').textContent.slice(-100)}`);
  w.close();
}

async function streamSilenceTimesOut() {
  let chatRequests = 0;
  const w = makeWindow((u, o) => {
    const method = o.method || 'GET';
    if (u.includes('/api/boot')) return Promise.resolve(json({ models: MODELS, chats: CHATS }));
    if (u.includes('/api/quota')) return Promise.resolve(json({ left_day: 9, unlimited: false }));
    if (u.includes('/api/chats/c1') && method === 'GET') {
      return Promise.resolve(json(Object.assign({}, CHATS[0], { messages: [] })));
    }
    if (/\/api\/chat(?:\?|$)/.test(u)) {
      chatRequests += 1;
      const signal = o.signal;
      const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
      return Promise.resolve({
        ok: true, status: 200, bodyUsed: false,
        headers: { get: () => 'application/x-ndjson' },
        body: { getReader: () => ({ read: () => new Promise((resolve, reject) => {
          if (signal.aborted) return reject(abortError());
          signal.addEventListener('abort', () => reject(abortError()), { once: true });
        }) }) },
      });
    }
    return Promise.resolve(json({ ok: true }));
  });
  await sleep(80);
  const nativeSetTimeout = w.setTimeout.bind(w);
  w.setTimeout = (fn, ms, ...args) => nativeSetTimeout(fn,
    ms === 95000 ? 12 : ((ms === 900 || ms === 2200) ? 1 : ms), ...args);
  const d = w.document;
  d.querySelector('#input').value = 'ответь';
  d.querySelector('#input').dispatchEvent(new w.Event('input'));
  d.querySelector('#btn-send').click();
  await sleep(180);
  check('silent response bodies time out and retry only a bounded number of times',
    chatRequests === 3 && /took too long to respond/i.test(d.querySelector('#messages').textContent),
    `requests=${chatRequests}; ${d.querySelector('#messages').textContent.slice(-100)}`);
  w.close();
}

/* ================= 1.5 пустая лента не крадёт пол-экрана ================= */
async function emptyState() {
  const w = makeWindow((u) => {
    if (u.includes('/api/boot')) {
      return Promise.resolve(json({ models: MODELS, chats: [], policy: { free: true } }));
    }
    if (u.includes('/api/quota')) return Promise.resolve(json({ left_day: 9, unlimited: false }));
    if (u.includes('/api/chats')) {
      return Promise.resolve(json({ id: 'n1', title: 'Новый чат',
        model: 'gemini/gemini-2.5-flash', updated_at: new Date().toISOString() }));
    }
    if (u.includes('/api/chat')) {
      return Promise.resolve(json({ reply: 'Привет!', provider: 'gemini',
        model: 'gemini-2.5-flash', filtered: false, fallbacks: [] }));
    }
    return Promise.resolve(json({}));
  });
  await sleep(80);
  const d = w.document;
  check('пустая лента скрыта — приветствие на весь экран',
    d.querySelector('#messages').hidden === true && d.querySelector('#empty').hidden === false,
    'messages.hidden=' + d.querySelector('#messages').hidden +
    ', empty.hidden=' + d.querySelector('#empty').hidden);
  d.querySelector('#btn-new').click();
  await sleep(40);
  check('новый чат: лента уступает место экрану «Чат готов», без чёрной пустоты',
    d.querySelector('#empty').hidden === false && d.querySelector('#messages').hidden === true &&
    /Chat is ready/.test(d.querySelector('#empty-title').textContent),
    d.querySelector('#empty-title').textContent);
  d.querySelector('#btn-chats').click();
  d.querySelector('#btn-settings').click();
  d.querySelector('#set-language').click();
  d.querySelector('[data-language-opt="ru"]').click();
  await sleep(20);
  check('an unsent new chat refreshes its generated labels after language change',
    d.querySelector('#empty-title').textContent === 'Чат готов' &&
    d.querySelector('#head-title').textContent === 'Новый чат',
    d.querySelector('#empty-title').textContent + ' / ' + d.querySelector('#head-title').textContent);
  d.querySelector('[data-language-opt="en"]').click();
  d.querySelector('#settings-sheet .sheet-close').click();
  await sleep(20);
  d.querySelector('#input').value = 'привет';
  d.querySelector('#input').dispatchEvent(new w.Event('input'));
  d.querySelector('#btn-send').click();
  await sleep(120);
  check('после отправки лента видна, приветствие скрыто',
    d.querySelector('#messages').hidden === false && d.querySelector('#empty').hidden === true,
    'messages.hidden=' + d.querySelector('#messages').hidden);
}

/* ================= saved locale survives a fresh app session ================= */
async function restoredLanguage() {
  const w = makeWindow((u) => {
    if (u.includes('/api/boot')) return Promise.resolve(json({ models: MODELS, chats: [] }));
    if (u.includes('/api/quota')) return Promise.resolve(json({ left_day: 9, unlimited: false }));
    return Promise.resolve(json({}));
  }, { prefs: { language: 'zh' } });
  await sleep(80);
  check('saved language is restored before the app starts',
    w.document.documentElement.lang === 'zh' &&
    w.document.querySelector('#empty-title').textContent === '你好！我是 Speransky AI',
    w.document.documentElement.lang + ' / ' + w.document.querySelector('#empty-title').textContent);
}

/* ================= 2. server refusal screens ================= */
async function gates() {
  {
    const w = makeWindow(() => Promise.resolve(json({ code: 'subscribe',
      channel_url: 'https://t.me/ch', error: 'Подпишись на канал, чтобы продолжить.' }, 403)));
    await sleep(80);
    const d = w.document;
    check('подписка: экран вместо чата',
      d.querySelector('#fatal').hidden === false && d.querySelector('#composer').hidden === true,
      'экран не показан');
    check('подписка: текст сервера',
      d.querySelector('#fatal-text').textContent === 'Подпишись на канал, чтобы продолжить.',
      d.querySelector('#fatal-text').textContent);
    check('подписка: кнопка есть', d.querySelector('#fatal-subscribe').hidden === false, 'скрыта');
  }
  {
    const w = makeWindow(() => Promise.resolve(json({ code: 'maintenance',
      message: 'Техработы до 15:00' }, 503)));
    await sleep(80);
    const d = w.document;
    check('техработы: заголовок', /Maintenance in progress/.test(d.querySelector('#fatal-title').textContent),
      d.querySelector('#fatal-title').textContent);
    check('техработы: кнопка «Повторить»', d.querySelector('#fatal-retry') !== null, 'нет');
  }
  {
    let calls = 0;
    const w = makeWindow((u) => {
      if (u.includes('/api/boot')) return Promise.resolve(json({
        models: [MODELS[0]],
        chats: [{ id: 'c1', title: 'Чат', model: 'gemini/gemini-2.5-flash',
                  updated_at: new Date().toISOString() }], policy: { free: true } }));
      if (u.includes('/api/quota')) return Promise.resolve(json({ left_day: 0, unlimited: false }));
      if (/\/api\/chats(\/|$|\?)/.test(u)) return Promise.resolve(json({ id: 'c1', title: 'Чат',
        model: 'gemini/gemini-2.5-flash', messages: [] }));
      if (u.includes('/api/chat')) { calls += 1;
        return Promise.resolve(json({ error: 'quota', message: 'Лимит на сегодня закончился' }, 429)); }
      return Promise.resolve(json({}));
    });
    await sleep(80);
    const d = w.document;
    d.querySelector('#input').value = 'привет';
    d.querySelector('#btn-send').click();
    await sleep(150);
    check('лимит: сообщение сервера в пузыре',
      /Лимит на сегодня закончился/.test(d.querySelector('#messages').textContent),
      d.querySelector('#messages').textContent.slice(0, 70));
    check('лимит: кнопка «Повторить»',
      [...d.querySelectorAll('#messages .retry-btn')].some((b) => /Retry/.test(b.textContent)),
      'нет кнопки');
    check('лимит: предупреждение над полем',
      /used up|limit/i.test(d.querySelector('#quota-hint-tx').textContent),
      d.querySelector('#quota-hint-tx').textContent);
    check('лимит: ровно один запрос к модели', calls === 1, String(calls));
  }
  {
    const w = makeWindow(() => Promise.resolve(json({ error: 'unauthorized' }, 401)));
    await sleep(80);
    check('401: экран сессии',
      /Session could not be verified/.test(w.document.querySelector('#fatal-text').textContent),
      w.document.querySelector('#fatal-text').textContent);
  }
  {
    const w = makeWindow(() => Promise.resolve(json({})), { noTelegram: true, url: 'https://app.example/' });
    await sleep(60);
    check('без initData: просим открыть из Telegram',
      /Open this app from Telegram/.test(w.document.querySelector('#fatal-text').textContent),
      w.document.querySelector('#fatal-text').textContent);
  }
}

/* ================= экран «Лимиты и приглашения» ================= */
const LIMITS_POLICY = {
  free: true,
  left_day: 17, daily_limit: 25,
  base_daily_limit: 10, base_total_daily_limit: 25,
  subscribed_daily_limit: 50, subscribed_total_daily_limit: 65,
  subscribed: false, subscription_available: true,
  channel_url: 'https://t.me/speransky_channel',
  referral_count: 3, referral_bonus_daily: 15, referral_bonus_per_friend: 5,
  referral_link: 'https://t.me/speransky_ai_bot?start=ref_123',
  referral_available: true,
  referral_note: 'Друг получает +5 запросов, и ты тоже.',
};

/* boot.policy и /api/quota отдают серверные поля квоты и рефералов. */
function limitsServer(overrides) {
  const policy = Object.assign({}, LIMITS_POLICY, overrides || {});
  return (u, o) => {
    const method = (o && o.method) || 'GET';
    if (u.includes('/api/boot')) {
      return Promise.resolve(json({ models: MODELS, chats: [], policy }));
    }
    if (u.includes('/api/quota')) return Promise.resolve(json(policy));
    if (u.includes('/api/chat')) {
      return Promise.resolve(json({ reply: 'Привет!', provider: 'gemini',
        model: 'gemini-2.5-flash', filtered: false, fallbacks: [] }));
    }
    if (/\/api\/chats(\/|$|\?)/.test(u) && method === 'POST') {
      return Promise.resolve(json({ id: 'n1', title: 'Новый чат',
        model: 'gemini/gemini-2.5-flash', updated_at: new Date().toISOString() }));
    }
    return Promise.resolve(json({}));
  };
}

/* Пилюля остатка в меню чатов — вход на экран лимитов. */
async function openLimitsViaDrawer(w) {
  const d = w.document;
  d.querySelector('#btn-chats').click();
  await sleep(20);
  d.querySelector('#quota-pill').click();
  await sleep(60);
  return d;
}

async function limitsWithFriends() {
  const w = makeWindow(limitsServer());
  const copied = stubClipboard(w);
  await sleep(90);
  const d = await openLimitsViaDrawer(w);
  const $ = (s) => d.querySelector(s);
  check('экран лимитов открывается из пилюли остатка и закрывает меню чатов',
    $('#limits-sheet').hidden === false && $('#chats-sheet').hidden === true,
    'limits.hidden=' + $('#limits-sheet').hidden);
  check('остаток запросов и доля дневного лимита',
    $('#limits-left').textContent === '17' &&
      /out of 25 per day/.test($('#limits-left-note').textContent) &&
      $('#limits-bar-fill').style.width === '68%',
    $('#limits-left').textContent + ' / ' + $('#limits-left-note').textContent +
      ' / ' + $('#limits-bar-fill').style.width);
  check('разложение лимита: 10 базовых + 5 за каждого из трёх друзей = 25',
    $('#limits-base-val').textContent === '10 requests' &&
      $('#limits-friends-val').textContent === '+15 (3 × 5)' &&
      $('#limits-total-val').textContent === '25 requests',
    [$('#limits-base-val').textContent, $('#limits-friends-val').textContent,
      $('#limits-total-val').textContent].join(' | '));
  check('число приглашённых друзей с правильной формой слова',
    $('#limits-invited-val').textContent === '3 friends',
    $('#limits-invited-val').textContent);
  check('личная ссылка показана целиком',
    $('#limits-link-box').hidden === false &&
      $('#limits-link-tx').textContent === LIMITS_POLICY.referral_link,
    $('#limits-link-tx').textContent);
  check('заметка сервера о рефералах видна',
    $('#limits-referral-note').hidden === false &&
      /Друг получает/.test($('#limits-referral-note').textContent),
    $('#limits-referral-note').textContent);
  $('#limits-copy').click();
  await sleep(40);
  check('копирование личной ссылки',
    copied[0] === LIMITS_POLICY.referral_link &&
      /Invite link copied/.test($('#warn').textContent),
    JSON.stringify(copied) + ' / ' + $('#warn').textContent);
  $('#limits-share').click();
  await sleep(20);
  const share = w.__tgCalls[w.__tgCalls.length - 1];
  check('«Поделиться» открывает диалог Telegram со ссылкой и текстом',
    !!share && share.kind === 'telegram' &&
      share.url.indexOf('https://t.me/share/url?url=') === 0 &&
      share.url.includes(encodeURIComponent(LIMITS_POLICY.referral_link)) &&
      /&text=.+/.test(share.url),
    JSON.stringify(share));
  check('блок подписки виден при subscription_available = true',
    $('#limits-subscribe').hidden === false && $('#limits-sub-cta').hidden === false &&
      /50 requests per day instead of 10/.test($('#limits-sub-text').textContent),
    $('#limits-sub-text').textContent);
  w.__tgCalls.length = 0;
  $('#limits-sub-cta').click();
  await sleep(20);
  check('кнопка подписки ведёт на channel_url сервера',
    w.__tgCalls.some((c) => c.url === LIMITS_POLICY.channel_url),
    JSON.stringify(w.__tgCalls));
}

async function limitsWithoutFriends() {
  const w = makeWindow(limitsServer({ referral_count: 0, referral_bonus_daily: 0,
    base_total_daily_limit: 10, daily_limit: 10, left_day: 4 }));
  await sleep(90);
  const d = await openLimitsViaDrawer(w);
  const $ = (s) => d.querySelector(s);
  check('без друзей лимит остаётся базовым',
    $('#limits-left').textContent === '4' &&
      $('#limits-base-val').textContent === '10 requests' &&
      $('#limits-total-val').textContent === '10 requests',
    $('#limits-left').textContent + ' / ' + $('#limits-base-val').textContent +
      ' / ' + $('#limits-total-val').textContent);
  check('без друзей строка приглашений объясняет бонус, а не пустая',
    /no friends yet/.test($('#limits-friends-val').textContent) &&
      /\+5 per friend/.test($('#limits-friends-val').textContent) &&
      $('#limits-invited-val').textContent === '0 friends',
    $('#limits-friends-val').textContent + ' / ' + $('#limits-invited-val').textContent);
  check('подсказка поделиться ссылкой видна только без друзей',
    $('#limits-breakdown-note').hidden === false &&
      /share your link/.test($('#limits-breakdown-note').textContent),
    $('#limits-breakdown-note').textContent);
  check('малый остаток подсвечен на полосе и в счётчике',
    $('#limits-bar').classList.contains('low') &&
      $('.limits-hero').classList.contains('low'), 'нет подсветки');
}

async function limitsWithoutLink() {
  {
    const w = makeWindow(limitsServer({ referral_link: '' }));
    await sleep(90);
    const d = await openLimitsViaDrawer(w);
    const $ = (s) => d.querySelector(s);
    check('без ссылки блок копирования скрыт, показано резервное сообщение',
      $('#limits-link-box').hidden === true && $('#limits-no-link').hidden === false &&
        /invite link isn’t ready yet/.test($('#limits-no-link').textContent),
      $('#limits-no-link').textContent);
    check('кнопки «Скопировать» и «Поделиться» живут внутри скрытого блока',
      $('#limits-link-box').contains($('#limits-copy')) &&
        $('#limits-link-box').contains($('#limits-share')), 'кнопки снаружи');
  }
  {
    /* сервер выключил приглашения — отдельное понятное сообщение */
    const w = makeWindow(limitsServer({ referral_link: '', referral_available: false }));
    await sleep(90);
    const d = await openLimitsViaDrawer(w);
    check('при referral_available = false объясняем, что приглашения выключены',
      /Invites are temporarily unavailable/.test(
        d.querySelector('#limits-no-link').textContent) &&
        d.querySelector('#limits-link-box').hidden === true,
      d.querySelector('#limits-no-link').textContent);
    check('выключенные приглашения не мешают пользоваться приложением',
      d.querySelector('#fatal').hidden === true &&
        d.querySelector('#composer').hidden === false, 'доступ закрыт');
  }
  {
    /* опасная или мусорная ссылка считается отсутствующей */
    const w = makeWindow(limitsServer({ referral_link: 'javascript:alert(1)' }));
    await sleep(90);
    const d = await openLimitsViaDrawer(w);
    check('не-http ссылка не попадает в экран',
      d.querySelector('#limits-link-box').hidden === true &&
        d.querySelector('#limits-no-link').hidden === false &&
        !/javascript:/i.test(d.querySelector('#limits-sheet').textContent),
      d.querySelector('#limits-link-tx').textContent);
  }
}

async function limitsSubscriptionGating() {
  {
    const w = makeWindow(limitsServer({ subscription_available: false }));
    await sleep(90);
    const d = w.document;
    check('подписка не требуется для доступа к приложению',
      d.querySelector('#fatal').hidden === true &&
        d.querySelector('#composer').hidden === false &&
        d.querySelector('#head').hidden === false, 'экран отказа вместо чата');
    await openLimitsViaDrawer(w);
    check('блок подписки скрыт при subscription_available = false',
      d.querySelector('#limits-subscribe').hidden === true &&
        d.querySelector('#limits-sheet').hidden === false, 'блок виден');
  }
  {
    const w = makeWindow(limitsServer({ subscribed: true, referral_count: 2,
      referral_bonus_daily: 10, subscribed_total_daily_limit: 60,
      daily_limit: 60, left_day: 55 }));
    await sleep(90);
    const d = await openLimitsViaDrawer(w);
    const $ = (s) => d.querySelector(s);
    check('с подтверждённой подпиской база 50 и сумма 60',
      $('#limits-base-label').textContent === 'Base limit (subscription confirmed)' &&
        $('#limits-base-val').textContent === '50 requests' &&
        $('#limits-friends-val').textContent === '+10 (2 × 5)' &&
        $('#limits-total-val').textContent === '60 requests',
      [$('#limits-base-label').textContent, $('#limits-base-val').textContent,
        $('#limits-friends-val').textContent, $('#limits-total-val').textContent].join(' | '));
    check('подписка подтверждена: состояние вместо призыва, кнопки канала нет',
      $('#limits-subscribe').hidden === false &&
        $('#limits-sub-title').textContent === 'Subscription is confirmed' &&
        /already get 50 requests per day/.test($('#limits-sub-text').textContent) &&
        $('#limits-sub-cta').hidden === true && $('#limits-no-channel').hidden === true,
      $('#limits-sub-title').textContent + ' / ' + $('#limits-sub-text').textContent);
  }
  {
    const w = makeWindow(limitsServer({ channel_url: '' }));
    await sleep(90);
    const d = await openLimitsViaDrawer(w);
    check('без channel_url показываем сообщение вместо мёртвой кнопки',
      d.querySelector('#limits-sub-cta').hidden === true &&
        d.querySelector('#limits-no-channel').hidden === false &&
        /channel link isn’t available/.test(d.querySelector('#limits-no-channel').textContent),
      d.querySelector('#limits-no-channel').textContent);
  }
}

async function limitsInNineLanguages() {
  const w = makeWindow(limitsServer());
  await sleep(90);
  const d = w.document;
  const titles = {
    en: 'Limits & invites', ru: 'Лимиты и приглашения', es: 'Límites e invitaciones',
    pt: 'Limites e convites', fr: 'Limites et invitations', de: 'Limits & Einladungen',
    hi: 'सीमाएँ और आमंत्रण', zh: '额度与邀请', ar: 'الحدود والدعوات',
  };
  for (const code of Object.keys(titles)) {
    d.querySelector('#btn-chats').click();
    d.querySelector('#btn-settings').click();
    await sleep(20);
    d.querySelector('#set-language').click();
    d.querySelector(`[data-language-opt="${code}"]`).click();
    await sleep(20);
    d.querySelector('#set-limits').click();     // строка настроек ведёт на экран
    await sleep(60);
    const sheet = d.querySelector('#limits-sheet');
    const text = sheet.textContent;
    const title = sheet.querySelector('.sheet-head span').textContent;
    check(`экран лимитов полностью переведён на ${code}`,
      sheet.hidden === false && title === titles[code] &&
        !/limits\.[a-zA-Z]/.test(text) && !/quota\.[a-zA-Z]/.test(text) &&
        text.length > 90,
      title + ' | ' + text.slice(0, 110));
    if (code === 'ru') {
      check('русские формы слов: 3 друга и 25 запросов',
        /3 друга/.test(sheet.querySelector('#limits-invited-val').textContent) &&
          /25 запросов/.test(sheet.querySelector('#limits-total-val').textContent),
        sheet.querySelector('#limits-invited-val').textContent + ' / ' +
          sheet.querySelector('#limits-total-val').textContent);
    }
    if (code === 'ar') {
      check('арабский переключает направление и оставляет ссылку читаемой',
        d.documentElement.dir === 'rtl' &&
          sheet.querySelector('#limits-link-tx').textContent === LIMITS_POLICY.referral_link,
        d.documentElement.dir);
    }
    sheet.querySelector('.sheet-close').click();
    await sleep(20);
  }
}

async function langGoesToServer() {
  const w = makeWindow(limitsServer());
  await sleep(90);
  const d = w.document;
  const gets = w.__requests.filter((r) => /\/api\/(boot|quota)/.test(r.url));
  check('выбранный язык уходит в GET-запросы',
    gets.length >= 2 && gets.every((r) => /[?&]lang=en(&|$)/.test(r.url)),
    gets.map((r) => r.url.split('?')[1] || r.url).join(' | '));
  d.querySelector('#btn-chats').click();
  d.querySelector('#btn-settings').click();
  await sleep(20);
  d.querySelector('#set-language').click();
  d.querySelector('[data-language-opt="ru"]').click();
  await sleep(20);
  d.querySelector('#set-limits').click();
  await sleep(50);
  d.querySelector('#limits-refresh').click();
  await sleep(70);
  const lastQuota = w.__requests.filter((r) => r.url.includes('/api/quota')).pop();
  check('после смены языка квота запрашивается с lang=ru',
    !!lastQuota && /[?&]lang=ru(&|$)/.test(lastQuota.url), lastQuota && lastQuota.url);
  check('обновление экрана подтверждается тостом на русском',
    /Лимиты обновлены/.test(d.querySelector('#warn').textContent),
    d.querySelector('#warn').textContent);
  d.querySelector('#limits-sheet .sheet-close').click();
  await sleep(20);
  d.querySelector('#input').value = 'привет';
  d.querySelector('#input').dispatchEvent(new w.Event('input'));
  d.querySelector('#btn-send').click();
  await sleep(200);
  const bodies = w.__requests.filter((r) => r.body).map((r) => JSON.parse(r.body));
  const chatBody = bodies.filter((b) => Array.isArray(b.messages)).pop();
  const createBody = bodies.filter((b) => typeof b.title === 'string').pop();
  check('язык уходит и в тело POST-запросов',
    !!chatBody && chatBody.lang === 'ru' && !!createBody && createBody.lang === 'ru',
    JSON.stringify({ chat: chatBody && chatBody.lang, create: createBody && createBody.lang }));
}

(async () => {
  markdownSafety();
  await happyPath();
  await noSelectableModelGuard();
  await rejectedOptimisticCreate();
  await singleFlight();
  await stoppedStreamIsSaved();
  await streamActivityResetsTimeout();
  await streamSilenceTimesOut();
  await emptyState();
  await restoredLanguage();
  await limitsWithFriends();
  await limitsWithoutFriends();
  await limitsWithoutLink();
  await limitsSubscriptionGating();
  await limitsInNineLanguages();
  await langGoesToServer();
  await gates();
  console.log(problems.length ? '\nПРОБЛЕМЫ:\n' + problems.join('\n') : '\nВсё чисто.');
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error('SMOKE CRASH', e); process.exit(2); });
