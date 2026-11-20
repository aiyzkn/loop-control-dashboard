// node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectSummary, matrix, shade, squarify } from '../viz.js';

const T = (project, status, priority = 'normal', updated = '') => ({ project, status, priority, updated, created: '' });

test('projectSummary は案件ごとに状態・完了・高優先を数え、進行中の多い順に並べる', () => {
  const r = projectSummary(
    [T('a', 'doing', 'high', '2026-11-20T10:00'), T('a', 'ready'), T('b', 'waiting', 'urgent'), T('a', 'done')],
    ['projects/b/archive/x.md', 'projects/b/archive/y.md', 'projects/c/archive/z.md', 'other.md'],
    ['a', 'b', 'c', 'd'],
  );
  assert.deepEqual(r.map((x) => x.project), ['a', 'b', 'c', 'd']);
  const a = r[0];
  assert.equal(a.open, 2); assert.equal(a.counts.doing, 1); assert.equal(a.counts.ready, 1); assert.equal(a.high, 1); assert.equal(a.latest, '2026-11-20T10:00');
  assert.equal(r[1].done, 2); assert.equal(r[1].high, 1); assert.equal(r[1].total, 3);
  assert.equal(r[2].total, 1);
  assert.equal(r[3].total, 0);
});

test('matrix は行 × 列の件数と合計', () => {
  const m = matrix([T('a', 'doing'), T('a', 'doing'), T('b', 'ready'), T('z', 'ready'), T('a', 'x')], ['a', 'b'], ['doing', 'ready'], (t) => [t.project, t.status]);
  assert.deepEqual(m.cells, [[2, 0], [0, 1]]);
  assert.deepEqual(m.rowTotal, [2, 1]);
  assert.deepEqual(m.colTotal, [2, 1]);
  assert.equal(m.total, 3);
  assert.equal(m.max, 2);
});

test('shade は 0 件を 0、それ以外を 0.15〜1 に', () => {
  assert.equal(shade(0, 5), 0);
  assert.equal(shade(5, 5), 1);
  assert.equal(shade(1, 0), 0);
  assert.ok(shade(1, 100) >= 0.15);
});

test('squarify は面積を値に比例させ、はみ出さず、重ならない', () => {
  const items = [{ key: 'a', value: 6 }, { key: 'b', value: 6 }, { key: 'c', value: 4 }, { key: 'd', value: 3 }, { key: 'e', value: 2 }, { key: 'f', value: 2 }, { key: 'g', value: 1 }, { key: 'z', value: 0 }];
  const W = 600, H = 400;
  const r = squarify(items, 0, 0, W, H);
  assert.equal(r.length, 7);
  const sum = 24;
  for (const x of r) {
    assert.ok(Math.abs(x.w * x.h - (x.value / sum) * W * H) < 1e-6, `${x.key} の面積`);
    assert.ok(x.x >= -1e-9 && x.y >= -1e-9 && x.x + x.w <= W + 1e-6 && x.y + x.h <= H + 1e-6, `${x.key} がはみ出さない`);
  }
  for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) {
    const a = r[i], b = r[j];
    const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    assert.ok(ox <= 1e-6 || oy <= 1e-6, `${a.key} と ${b.key} が重ならない`);
  }
  // 細長くなりすぎない（squarified の狙い）
  for (const x of r) assert.ok(Math.max(x.w / x.h, x.h / x.w) < 4, `${x.key} の縦横比`);
  assert.deepEqual(squarify([], 0, 0, 10, 10), []);
  assert.deepEqual(squarify([{ key: 'a', value: 1 }], 0, 0, 0, 10), []);
});
