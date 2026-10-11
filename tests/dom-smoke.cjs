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
const JS_FILES = ['js/config.js', 'js/api.js', 'js/logos.js', 'js/brand.js', 'js/render.js',
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
const ndjson = (lines) => {
  const enc = new TextEncoder();
  const chunks = lines.map((l) => enc.encode(JSON.stringify(l) + '\n'));
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
  if (!(opts && opts.noTelegram)) {
    w.Telegram = { WebApp: {
      initData: 'test', colorScheme: 'dark', initDataUnsafe: { user: { first_name: 'Миша' } },
      ready() {}, expand() {}, setHeaderColor() {}, disableVerticalSwipes() {}, onEvent() {},
      HapticFeedback: { impactOccurred() {}, selectionChanged() {}, notificationOccurred() {} },
      openTelegramLink() {}, openLink() {},
    } };
  }
  w.fetch = (u, o) => handler(String(u), o || {});
  w.TextEncoder = TextEncoder;
  w.TextDecoder = TextDecoder;
  vc.on('jsdomError', (e) => problems.push('jsdomError: ' + e.message));
  w.eval(APP);
  return w;
}

const MODELS = [
  { provider: 'gemini', model: 'gemini-2.5-flash', state: 'ok', available: true, vision: true },
  { provider: 'groq', model: 'llama-3.3-70b', state: 'ok', available: true },
  { provider: 'mistral', model: 'codestral-latest', state: 'cooldown', available: true },
];
const CHATS = [
  { id: 'c1', title: 'Разбор контрольной', model: 'gemini/gemini-2.5-flash',
    updated_at: new Date().toISOString() },
  { id: 'c2', title: 'План подготовки', model: 'groq/llama-3.3-70b',
    updated_at: new Date(Date.now() - 86400000).toISOString() },
];

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
      ]));
    }
    return Promise.resolve(json({}));
  };

  const w = makeWindow(handler);
  const d = w.document;
  const $ = (s) => d.querySelector(s);
  await sleep(80);

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
  check('шторка моделей открыта', $('#model-sheet').hidden === false, 'скрыта');
  check('текстовая вкладка без кодинг-моделей',
    d.querySelectorAll('#models-list .model-row').length === 2,
    String(d.querySelectorAll('#models-list .model-row').length));
  const codeTab = [...d.querySelectorAll('.cat-tab')].find((b) => /Код/.test(b.textContent));
  codeTab.click();
  await sleep(30);
  check('вкладка «Код» показывает codestral', /codestral/.test($('#models-list').textContent),
    $('#models-list').textContent.slice(0, 50));
  $('#model-search').value = 'llama';
  $('#model-search').dispatchEvent(new w.Event('input'));
  await sleep(20);
  check('поиск ищет по всем категориям', /llama-3\.3-70b/.test($('#models-list').textContent),
    $('#models-list').textContent.slice(0, 60));
  $('#model-search-clear').click();
  await sleep(20);
  check('сброс поиска возвращает список', d.querySelector('#models-list .model-row') !== null,
    'пусто');
  $('#model-sheet .sheet-close').click();
  await sleep(20);

  $('#btn-chats').click();
  await sleep(20);
  $('#btn-settings').click();
  await sleep(20);
  check('настройки: имя из Telegram', $('#set-name').textContent === 'Миша', $('#set-name').textContent);
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
    /Чат готов/.test(d.querySelector('#empty-title').textContent),
    d.querySelector('#empty-title').textContent);
  d.querySelector('#input').value = 'привет';
  d.querySelector('#input').dispatchEvent(new w.Event('input'));
  d.querySelector('#btn-send').click();
  await sleep(120);
  check('после отправки лента видна, приветствие скрыто',
    d.querySelector('#messages').hidden === false && d.querySelector('#empty').hidden === true,
    'messages.hidden=' + d.querySelector('#messages').hidden);
}

/* ================= 2. отказы сервера ================= */
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
    check('техработы: заголовок', /Технические работы/.test(d.querySelector('#fatal-title').textContent),
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
      [...d.querySelectorAll('#messages .retry-btn')].some((b) => /Повторить/.test(b.textContent)),
      'нет кнопки');
    check('лимит: предупреждение над полем',
      /исчерпан/.test(d.querySelector('#quota-hint-tx').textContent),
      d.querySelector('#quota-hint-tx').textContent);
    check('лимит: ровно один запрос к модели', calls === 1, String(calls));
  }
  {
    const w = makeWindow(() => Promise.resolve(json({ error: 'unauthorized' }, 401)));
    await sleep(80);
    check('401: экран сессии',
      /Сессия не подтвердилась/.test(w.document.querySelector('#fatal-text').textContent),
      w.document.querySelector('#fatal-text').textContent);
  }
  {
    const w = makeWindow(() => Promise.resolve(json({})), { noTelegram: true, url: 'https://app.example/' });
    await sleep(60);
    check('без initData: просим открыть из Telegram',
      /Открой меня из Telegram/.test(w.document.querySelector('#fatal-text').textContent),
      w.document.querySelector('#fatal-text').textContent);
  }
}

(async () => {
  await happyPath();
  await emptyState();
  await gates();
  console.log(problems.length ? '\nПРОБЛЕМЫ:\n' + problems.join('\n') : '\nВсё чисто.');
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error('SMOKE CRASH', e); process.exit(2); });
