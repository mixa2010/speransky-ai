const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

function loadApi(fetchImpl) {
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
  return { api: context.__testApi, warning };
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
  assert.match(css, /\.boot-spark\s*\{[^}]*animation:\s*boot-mark-in\s+600ms\s+var\(--ease\)\s+both/s);
  assert.match(css, /@keyframes boot-mark-in\s*\{/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?animation:\s*none\s*!important/);
  assert.doesNotMatch(app, /setTimeout\s*\(\s*boot\b/);
  assert.match(app, /document\.addEventListener\('DOMContentLoaded', boot, \{ once: true \}\)/);
});
