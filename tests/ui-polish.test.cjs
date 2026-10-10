const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
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
