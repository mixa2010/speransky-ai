const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

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

test('viewport allows pinch-zoom for accessibility', () => {
  const viewport = html.match(/<meta name="viewport" content="([^"]*)"/);
  assert.ok(viewport, 'viewport meta is present');
  assert.doesNotMatch(viewport[1], /user-scalable\s*=\s*no/);
  assert.doesNotMatch(viewport[1], /maximum-scale/);
});

test('no CSS font size below 11px remains', () => {
  for (const m of css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)) {
    assert.ok(Number(m[1]) >= 11, `font-size ${m[1]}px is too small`);
  }
});

test('chat file thumbnails set image URLs as properties, not via HTML strings', () => {
  const block = app.match(/function openFilesSheet\(\) \{[\s\S]*?\n\}\n/);
  assert.ok(block, 'openFilesSheet exists');
  assert.doesNotMatch(block[0], /src=\\?"'\s*\+\s*x\.m\.image/);
  assert.match(block[0], /thumb\.src = x\.m\.image/);
});

test('app.js and style.css share one cache-busting version', () => {
  const versions = new Set([...html.matchAll(/\?v=(\w+)/g)].map((m) => m[1]));
  assert.equal(versions.size, 1);
});

test('the cache guard in index.html matches the version reported by app.js', () => {
  const need = html.match(/__NEED_APP_V = '([^']+)'/);
  const have = app.match(/__APP_V = '([^']+)'/);
  assert.ok(need && have, 'both version constants exist');
  assert.equal(have[1], need[1]);
  const [v] = [...html.matchAll(/\?v=(\w+)/g)].map((m) => m[1]);
  assert.equal(v, need[1]);
});

test('every script referenced by index.html exists', () => {
  for (const m of html.matchAll(/<script defer src="([^"?]+)/g)) {
    if (/^https?:/.test(m[1])) continue;
    assert.ok(fs.existsSync(path.join(root, m[1])), m[1]);
  }
});
