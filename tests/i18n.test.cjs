const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'js/i18n.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const clientSource = ['app.js', 'js/api.js', 'js/models.js', 'js/models-list.js', 'js/render.js', 'js/ui.js']
  .map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');

function loadI18n(savedPrefs) {
  const storage = new Map();
  if (savedPrefs) storage.set('sp_prefs_v1', JSON.stringify(savedPrefs));
  const documentElement = { lang: '', dir: '', dataset: {} };
  const document = {
    documentElement,
    querySelectorAll: () => [],
  };
  const context = {
    document,
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value)),
    },
    Intl,
  };
  vm.createContext(context);
  vm.runInContext(source + '\n' + [
    'globalThis.__langs = UI_LANGUAGES;',
    'globalThis.__messages = I18N;',
    'globalThis.__getLanguage = getLanguage;',
    'globalThis.__getLanguageInfo = getLanguageInfo;',
    'globalThis.__setLanguage = setLanguage;',
    'globalThis.__t = t;',
  ].join('\n'), context);
  return { context, documentElement, storage };
}

test('a fresh install starts in English and offers popular interface languages', () => {
  const { context, documentElement } = loadI18n();
  assert.equal(context.__getLanguage(), 'en');
  assert.equal(documentElement.lang, 'en');
  assert.equal(context.__t('settings.language'), 'Language');
  const languageCodes = Array.from(context.__langs, (item) => item.code);
  assert.deepEqual(languageCodes, ['en', 'ru', 'es', 'pt', 'fr', 'de', 'hi', 'zh', 'ar']);
  assert.match(html, /<html lang="en">/);
  assert.deepEqual([...html.matchAll(/data-language-opt="([^"]+)"/g)].map((match) => match[1]),
    languageCodes, 'Settings offers every supported language exactly once');
});

test('a saved language is restored; Arabic sets right-to-left direction', () => {
  const { context, documentElement } = loadI18n({ language: 'ru' });
  assert.equal(context.__getLanguage(), 'ru');
  assert.equal(documentElement.lang, 'ru');
  assert.equal(documentElement.dir, 'ltr');
  assert.equal(context.__t('settings.language'), 'Язык');

  context.__setLanguage('ar');
  assert.equal(documentElement.lang, 'ar');
  assert.equal(documentElement.dir, 'rtl');
  assert.equal(context.__getLanguageInfo('ar').name, 'العربية');
});

test('every supported locale has a complete translation set with matching parameters', () => {
  const { context } = loadI18n();
  const english = context.__messages.en;
  const keys = Object.keys(english);
  const params = (value) => [...String(value).matchAll(/\{([a-zA-Z0-9_]+)\}/g)]
    .map((match) => match[1]).sort();
  for (const language of context.__langs) {
    const dictionary = context.__messages[language.code];
    assert.ok(dictionary, `missing dictionary for ${language.code}`);
    for (const key of keys) {
      assert.ok(Object.hasOwn(dictionary, key), `${language.code} is missing ${key}`);
      assert.deepEqual(params(dictionary[key]), params(english[key]),
        `${language.code} has mismatched template parameters for ${key}`);
    }
  }
});

test('all translation attributes in the shipped HTML resolve to English strings', () => {
  const { context } = loadI18n();
  const keys = [...html.matchAll(/\bdata-i18n(?:-[a-z-]+)?="([^"]+)"/g)]
    .map((match) => match[1]);
  assert.ok(keys.length > 0, 'index.html includes localized UI attributes');
  for (const key of keys) {
    assert.ok(Object.hasOwn(context.__messages.en, key), `index.html references missing key ${key}`);
  }
});

test('literal translation calls in client code resolve to English strings', () => {
  const { context } = loadI18n();
  const keys = [...clientSource.matchAll(/\bt\(\s*['"]([^'"]+)['"]/g)]
    .map((match) => match[1]);
  assert.ok(keys.length > 0, 'client code uses localized strings');
  for (const key of keys) {
    assert.ok(Object.hasOwn(context.__messages.en, key), `client code references missing key ${key}`);
  }
});
