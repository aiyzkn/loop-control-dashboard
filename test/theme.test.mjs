// node --test test/
// 表示の切り替え（theme.js・index.html・style.css）の食い違いを確かめる
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const css = read('style.css').replace(/\/\*[\s\S]*?\*\//g, '');
const values = JSON.parse(read('theme.js').match(/var VALUES = (\[[^\]]*\]);/)[1].replace(/'/g, '"'));

// セレクターがちょうど `sel` の規則の中で定義している変数の名前（@media の中も含む）
function varsOf(sel) {
  const names = new Set();
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    if (m[1].split(',').map((x) => x.trim()).includes(sel)) for (const v of m[2].matchAll(/(--[\w-]+)\s*:/g)) names.add(v[1]);
  }
  return names;
}

test('theme.js の選択肢と index.html の option が一致する', () => {
  const opts = [...read('index.html').matchAll(/<select id="theme"[^>]*>(.*?)<\/select>/gs)][0][1];
  const vals = [...opts.matchAll(/<option value="([^"]+)">/g)].map((m) => m[1]);
  assert.deepEqual(vals, values);
  assert.ok(values.includes('cockpit'));
});

test('コックピットは、ダークで上書きしている色の変数をすべて定義する', () => {
  const dark = varsOf(':root[data-theme="dark"]');
  const cockpit = varsOf(':root[data-theme="cockpit"]');
  assert.ok(dark.size >= 20, `ダークの変数が ${dark.size} 個しか見つからない`);
  assert.deepEqual([...dark].filter((v) => !cockpit.has(v)), []);
});

test('コックピットは color-scheme を dark にし、点滅を prefers-reduced-motion で止める', () => {
  assert.match(css, /:root\[data-theme="cockpit"\] \{\s*color-scheme: dark;/);
  assert.match(css, /prefers-reduced-motion: reduce\)\s*\{\s*:root\[data-theme="cockpit"\] h1::after \{ animation: none; \}/);
});
