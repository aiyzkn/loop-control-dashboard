// node --test test/
// 表示の状態（誰の番か・何を待っているか）の導出と、ラベル色の定義の食い違いを確かめる（20261128-status-labels）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTask, taskPhase, runningTaskIds, lastLogAuthor, PHASES, PHASE_JA, PHASE_TURN } from '../parse.js';

const doc = (front, body = '') => `---\n${front}\n---\n\n# t\n\n## 利用者への質問と回答\n\n${body}\n\n## ログ\n\n`;

test('ログの最後の行の書き手を読む', () => {
  assert.equal(lastLogAuthor('- 2026-11-28T08:00:00+09:00 [a-pc] claim\n- 2026-11-28T09:00:00+09:00 [dashboard:me] Q1 に回答'), 'dashboard:me');
  assert.equal(lastLogAuthor('<!-- 例 -->\n'), '');
  assert.equal(lastLogAuthor(''), '');
});

test('doing: 実行中 > 確認待ち（最後のログが担当以外）> 作業中', () => {
  const t = parseTask('projects/p/tasks/x.md', doc('id: x\nstatus: doing\nclaimed_by: a-pc') + '- 2026-11-28T08:00:00+09:00 [a-pc] claim\n- 2026-11-28T09:00:00+09:00 [dashboard:me] Q1 に回答、回答がそろったので status: waiting → doing\n');
  assert.equal(t.lastLogBy, 'dashboard:me');
  assert.equal(taskPhase(t), 'confirm');
  assert.equal(taskPhase(t, new Set(['x'])), 'running');
  assert.equal(taskPhase({ ...t, lastLogBy: 'a-pc' }), 'doing');
  assert.equal(taskPhase({ ...t, lastLogBy: '' }), 'doing');
});

test('waiting: wait の種類で分け、無い・知らない値は回答待ち。全部に答えてあれば確認待ち', () => {
  const q = '- Q1（2026-11-28、a-pc）: どちら？\n  - 回答:';
  const base = (wait) => parseTask('projects/p/tasks/y.md', doc(`id: y\nstatus: waiting\nclaimed_by: a-pc${wait ? `\nwait: ${wait}` : ''}`, q));
  assert.equal(taskPhase(base('spec')), 'wait-spec');
  assert.equal(taskPhase(base('approval')), 'wait-approval');
  assert.equal(taskPhase(base('command')), 'wait-command');
  assert.equal(taskPhase(base('')), 'wait-answer');
  assert.equal(taskPhase(base('unknown')), 'wait-answer');
  const answered = parseTask('projects/p/tasks/y.md', doc('id: y\nstatus: waiting\nwait: spec', '- Q1（…）: どちら？\n  - 回答: A'));
  assert.equal(taskPhase(answered), 'confirm');
});

test('そのほかの status はそのまま', () => {
  for (const s of ['ready', 'review', 'blocked', 'draft', 'done', 'dropped']) assert.equal(taskPhase({ status: s }), s);
});

test('PC の状況の running から、タスク ID の集まりを作る（文字列・オブジェクトの両方、無い・壊れたものは飛ばす）', () => {
  const ids = runningTaskIds([{ running: [{ task: 'a', project: 'p' }, 'b', null, {}] }, { running: 'x' }, null, {}]);
  assert.deepEqual([...ids].sort(), ['a', 'b']);
});

test('表示の状態ごとに、名前・番・ラベル色（ライト・ダーク・コックピット）がそろっている', () => {
  const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
  for (const ph of PHASES) {
    assert.ok(PHASE_JA[ph], `${ph} の名前`);
    assert.ok(PHASE_TURN[ph], `${ph} の番`);
    assert.match(css, new RegExp(`\\.badge\\.ph-${ph} \\{`), `${ph} のラベルの規則`);
    // :root（ライト）・ダーク 2 か所・コックピットの 4 か所で定義する
    assert.equal(css.match(new RegExp(`--ph-${ph}:`, 'g'))?.length, 4, `--ph-${ph} の定義の数`);
  }
  // 利用者の番と Claude の番が、どちらも 1 つ以上ある
  assert.ok(PHASES.some((p) => PHASE_TURN[p] === 'user') && PHASES.some((p) => PHASE_TURN[p] === 'agent'));
});
