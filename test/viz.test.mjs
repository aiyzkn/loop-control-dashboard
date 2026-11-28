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

import { dayWindow, ganttRows, createdSeries, ribbonLayout } from '../viz.js';

test('dayWindow は今日を含む直近の日付', () => {
  const now = new Date(2026, 10, 20, 15, 0).getTime();
  const w = dayWindow(3, now);
  assert.deepEqual(w.days, ['20261118', '20261119', '20261120']);
  assert.equal(w.from, new Date(2026, 10, 18).getTime());
  assert.equal(w.to, now);
});

test('ganttRows は始まり〜終わりを窓の中の位置にし、進行中を先に並べる', () => {
  const from = Date.parse('2026-11-10T00:00:00+09:00'), to = Date.parse('2026-11-20T00:00:00+09:00');
  const rows = ganttRows([
    { id: 'a', status: 'doing', created: '2026-11-15T00:00:00+09:00', heartbeatAt: '2026-11-18T00:00:00+09:00' },
    { id: 'b', status: 'done', archived: true, created: '2026-11-05T00:00:00+09:00', updated: '2026-11-12T00:00:00+09:00' },
    { id: 'c', status: 'done', archived: true, created: '2026-11-01T00:00:00+09:00', updated: '2026-11-02T00:00:00+09:00' },
    { id: 'd', status: 'ready', created: 'x' },
    { id: 'e', status: 'ready', created: '2026-11-11T00:00:00+09:00' },
  ], from, to);
  assert.deepEqual(rows.map((r) => r.id), ['a', 'e', 'b']);
  const a = rows[0];
  assert.equal(a.x0, 0.5); assert.equal(a.x1, 1); assert.equal(a.hb, 0.8); assert.equal(a.clipped, false);
  const b = rows[2];
  assert.equal(b.x0, 0); assert.equal(b.clipped, true); assert.equal(b.status, 'done'); assert.equal(b.x1, 0.2);
});

test('createdSeries は案件ごと・日ごとに起票を数え、多い案件から並べる', () => {
  const s = createdSeries([
    'projects/a/tasks/20261119-x.md', 'projects/a/archive/20261120-y.md', 'projects/b/tasks/20261120-z.md',
    'projects/b/tasks/20261120-w.md', 'projects/b/tasks/20261120-v.md', 'projects/c/tasks/20261101-old.md', 'inbox.md',
  ], ['20261119', '20261120']);
  assert.deepEqual(s.projects, ['b', 'a']);
  assert.deepEqual(s.values.a, [1, 1]);
  assert.deepEqual(s.values.b, [0, 3]);
});

test('ribbonLayout は期間ごとに大きい順に積み、最大の合計で割る', () => {
  const r = ribbonLayout({ projects: ['b', 'a'], days: ['1', '2'], values: { a: [1, 1], b: [0, 3] } });
  assert.equal(r.max, 4);
  assert.deepEqual(r.columns[0].segs.map((s) => [s.project, s.y0, s.y1, s.rank]), [['a', 0, 0.25, 0]]);
  assert.deepEqual(r.columns[1].segs.map((s) => [s.project, s.y0, s.y1, s.rank]), [['b', 0, 0.75, 0], ['a', 0.75, 1, 1]]);
});

import { cumulative } from '../viz.js';

test('cumulative は日ごとの数を累計にする', () => {
  const c = cumulative({ projects: ['a'], days: ['1', '2', '3'], values: { a: [1, 0, 2] } });
  assert.deepEqual(c.values.a, [1, 1, 3]);
  const r = ribbonLayout(c);
  assert.equal(r.columns[1].segs.length, 1);
});

import { calendarDays, sumDays, levelScale, gridCells } from '../viz.js';

test('calendarDays・sumDays は日の並びにし、日付ごとに足す', () => {
  const a = calendarDays([{ contributionDays: [{ date: '2026-11-01', contributionCount: 1 }, { date: '2026-11-02', contributionCount: 0 }] }]);
  const b = calendarDays([{ contributionDays: [{ date: '2026-11-02', contributionCount: 3 }] }]);
  assert.deepEqual(sumDays([a, b]), [{ date: '2026-11-01', count: 1 }, { date: '2026-11-02', count: 3 }]);
  assert.deepEqual(calendarDays(null), []);
});

test('levelScale は 0 を 0、ほかを四分位で 1〜4', () => {
  const f = levelScale([0, 1, 2, 3, 4, 5, 6, 7, 8].map((count) => ({ count })));
  assert.equal(f(0), 0); assert.equal(f(1), 1); assert.equal(f(8), 4);
  assert.equal(levelScale([{ count: 0 }])(5), 0);
});

test('gridCells は週を列、曜日を行にする', () => {
  // 2026-11-01 は日曜
  const c = gridCells([{ date: '2026-11-01', count: 1 }, { date: '2026-11-07', count: 0 }, { date: '2026-11-08', count: 2 }]);
  assert.deepEqual(c.map((x) => [x.col, x.row]), [[0, 0], [0, 6], [1, 0]]);
  const d = gridCells([{ date: '2026-11-03', count: 1 }]);   // 火曜から始まる
  assert.deepEqual([d[0].col, d[0].row], [0, 2]);
});

import { timeTicks } from '../viz.js';

test('timeTicks は窓の長さで目盛りの細かさを変える', () => {
  const now = new Date(2026, 10, 20, 10, 0).getTime();
  const one = dayWindow(1, now);
  const t1 = timeTicks(one.from, one.to, 1);
  assert.deepEqual(t1.map((x) => x.label), ['0時', '3時', '6時', '9時']);
  assert.equal(t1[0].f, 0);
  assert.ok(Math.abs(t1[3].f - 0.9) < 1e-9);
  const w7 = dayWindow(7, now);
  assert.equal(timeTicks(w7.from, w7.to, 7).filter((x) => x.label).length, 7);
  const w14 = dayWindow(14, now);
  const t14 = timeTicks(w14.from, w14.to, 14);
  assert.equal(t14.length, 14); assert.equal(t14[13].label, '11/20'); assert.equal(t14[12].label, '');
  const w30 = dayWindow(30, now);
  const t30 = timeTicks(w30.from, w30.to, 30);
  assert.equal(t30.filter((x) => x.label).length, 6); assert.equal(t30[29].label, '11/20');
  // 位置は実際の時刻の割合（今日の 0 時は窓の端ではない）
  assert.ok(t14[13].f < 1 && t14[13].f > 0.9);
});

test('日の出・日の入り（東京）は数分の誤差で合う。夜の区間は窓で切る', async () => {
  const { sunTimes, nightSpans, SUN_PLACE } = await import('../viz.js');
  const hm = (ms) => { const d = new Date(ms + 9 * 3600e3); return d.getUTCHours() * 60 + d.getUTCMinutes(); };   // 日本時間の分
  const near = (ms, h, m) => Math.abs(hm(ms) - (h * 60 + m)) <= 6;
  const w = sunTimes(Date.parse('2026-12-22T12:00:00+09:00'), SUN_PLACE.lat, SUN_PLACE.lng);
  assert.ok(near(w.rise, 6, 47) && near(w.set, 16, 32), `冬至 ${hm(w.rise)} ${hm(w.set)}`);
  const s = sunTimes(Date.parse('2026-06-21T12:00:00+09:00'), SUN_PLACE.lat, SUN_PLACE.lng);
  assert.ok(near(s.rise, 4, 25) && near(s.set, 19, 0), `夏至 ${hm(s.rise)} ${hm(s.set)}`);
  const from = Date.parse('2026-11-20T00:00:00+09:00'), to = Date.parse('2026-11-22T00:00:00+09:00');
  const n = nightSpans(from, to);
  assert.equal(n.length, 3);
  assert.equal(n[0].x0, 0);
  assert.equal(n[2].x1, 1);
  assert.ok(n.every((x) => x.x0 < x.x1 && x.x0 >= 0 && x.x1 <= 1));
  assert.equal(sunTimes(Date.parse('2026-12-22T12:00:00Z'), 80, 0).rise, null);   // 極夜
});

test('上限の帯: アカウントでまとめ、窓に掛かるものだけ・同じ窓は 1 つ', async () => {
  const { limitRows } = await import('../viz.js');
  const from = Date.parse('2026-11-14T00:00:00+09:00'), to = Date.parse('2026-11-22T00:00:00+09:00');
  const now = Date.parse('2026-11-20T18:00:00+09:00');
  const w = (kind, s, r, hit = true) => ({ kind, startsAt: s, resetsAt: r, hit });
  const pcs = [
    { agentId: 'a-claude', pc: 'A', limits: [w('five_hour', '2026-11-20T16:00:00+09:00', '2026-11-20T21:00:00+09:00'), w('seven_day', '2026-11-12T08:00:00+09:00', '2026-11-19T08:00:00+09:00'), w('five_hour', '2026-11-01T00:00:00+09:00', '2026-11-01T05:00:00+09:00')] },
    { agentId: 'b-claude', pc: 'B', limits: [w('five_hour', '2026-11-20T16:00:00+09:00', '2026-11-20T21:00:00+09:00', false), w('bogus', '2026-11-20T00:00:00+09:00', '2026-11-20T01:00:00+09:00')] },
    { agentId: 'c-claude', pc: 'C' },
  ];
  const roster = [{ id: 'a-claude', account: 'main' }, { id: 'b-claude', account: '`main`'.replace(/`/g, '') }, { id: 'c-claude', account: '<アカウントの呼び名>' }];
  const rows = limitRows(pcs, roster, from, to, now);
  assert.deepEqual(rows.map((r) => [r.name, r.agents]), [['main', ['a-claude', 'b-claude']], ['PC C', ['c-claude']]]);
  const main = rows[0].bands;
  assert.equal(main.length, 2);
  assert.deepEqual(main.map((b) => [b.kind, b.hit, b.active]), [['seven_day', true, false], ['five_hour', true, true]]);
  assert.equal(main[0].x0, 0);   // 窓より前から始まる週は 0 で切る
  assert.ok(main[1].x0 > 0.8 && main[1].x1 < 0.9);
  assert.deepEqual(rows[1].bands, []);
});
test('推定の窓: 記録のある窓の前後と間を、窓の長さで隙間なく敷き詰める', async () => {
  const { estimateWindows } = await import('../viz.js');
  const h = 3600 * 1000;
  // 窓 [10,15) と [27,32)。範囲 [0,40)、長さ 5
  const ws = [{ start: 27 * h, reset: 32 * h }, { start: 10 * h, reset: 15 * h }];
  const est = estimateWindows(ws, 5 * h, 0, 40 * h).map((e) => [e.start / h, e.reset / h]);
  // 前: [5,10) [0,5)（範囲にかかる -5〜0 は含めない）／間: [15,20) [20,25)（[25,30) は 27 に入りきらない）／後: [32,37) [37,42)
  assert.deepEqual(est, [[0, 5], [5, 10], [15, 20], [20, 25], [32, 37], [37, 42]]);
  assert.deepEqual(estimateWindows([], 5 * h, 0, 40 * h), []);
  // 範囲の外の窓だけでも、起点にして範囲の中に推定を出す
  const far = estimateWindows([{ start: -100 * h, reset: -95 * h }], 5 * h, 0, 12 * h).map((e) => [e.start / h, e.reset / h]);
  assert.deepEqual(far, [[0, 5], [5, 10], [10, 15]]);
});

test('上限の行: 推定の窓は bands と別に estimates に入り、記録のある窓といまの窓が重ならない', async () => {
  const { limitRows } = await import('../viz.js');
  const from = Date.parse('2026-11-20T00:00:00+09:00'), to = Date.parse('2026-11-21T00:00:00+09:00');
  const now = Date.parse('2026-11-20T18:00:00+09:00');
  const pcs = [{ agentId: 'a', pc: 'A', limits: [{ kind: 'five_hour', startsAt: '2026-11-20T08:00:00+09:00', resetsAt: '2026-11-20T13:00:00+09:00', hit: true }] }];
  const [row] = limitRows(pcs, [], from, to, now);
  assert.equal(row.bands.length, 1);
  const rel = (ms) => (ms - from) / 3600000;
  // 前: [-2,3) [3,8)／後: [13,18) [18,23) [23,28)（記録のある窓 [8,13) の前後）
  assert.deepEqual(row.estimates.map((e) => [rel(e.start), rel(e.reset)]), [[-2, 3], [3, 8], [13, 18], [18, 23], [23, 28]]);
  assert.ok(row.estimates.every((e) => e.estimated && e.kind === 'five_hour'));
  // 13:00 からの推定 [13,18) [18,23) のうち、いま（18:00）を含むのは [18,23)
  assert.deepEqual(row.estimates.filter((e) => e.active).map((e) => rel(e.start)), [18]);
});
