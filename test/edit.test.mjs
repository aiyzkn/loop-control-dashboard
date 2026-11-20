// node --test test/  （Node.js 18 以上。依存なし）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTask, parseQuestions, sortTasks, parseOrder } from '../parse.js';
import { setFrontMatter, appendLog, setAnswer, planReorder, priorityColumns, isoLocal, lineDiff, commitMessage, oneLine, applyTaskEdits } from '../edit.js';

const task = `---
id: 20261120-demo
title: デモ
project: demo
status: waiting
stage: implement
priority: high
assignee: any
claimed_by: pc1-claude
created: 2026-11-20T06:00:00+09:00
updated: 2026-11-20T06:00:00+09:00
---

# デモ

## 利用者への質問と回答

<!-- エージェントが質問を書き、status を waiting にする。利用者は「回答:」の後ろに書いてコミットする -->

- Q1（2026-11-20）: PR をマージしてよいですか
  - 回答: 2026-11-20「はい」
- Q2（2026-11-20）: 案 A と B のどちらにしますか
  - 回答:
- Q3（2026-11-20）: 回答の行が無い質問

## 決定事項

## ログ

- 2026-11-20T06:00:00+09:00 [pc1-claude] 起票（direct）
`;

test('質問を読む', () => {
  const qs = parseQuestions(task);
  assert.deepEqual(qs.map((q) => [q.id, q.answer]), [['Q1', '2026-11-20「はい」'], ['Q2', ''], ['Q3', '']]);
  assert.equal(qs[1].question, '案 A と B のどちらにしますか');
  assert.equal(qs[2].answerLine, -1);
  assert.equal(parseTask('projects/demo/tasks/20261120-demo.md', task).questions.length, 3);
});

test('先頭の書き換え・足す・消す。ほかの行と改行は保つ', () => {
  const out = setFrontMatter(task, { priority: 'urgent', order: 20, claimed_by: null });
  assert.match(out, /^priority: urgent$/m);
  assert.match(out, /^order: 20\n---$/m);
  assert.doesNotMatch(out, /claimed_by/);
  assert.equal(out.split('---\n')[2], task.split('---\n')[2]);
  const crlf = setFrontMatter(task.replace(/\n/g, '\r\n'), { status: 'ready' });
  assert.match(crlf, /\r\nstatus: ready\r\n/);
  assert.doesNotMatch(crlf.replace(/\r\n/g, ''), /\n/);
  assert.throws(() => setFrontMatter('# 先頭なし', { a: 1 }));
  assert.throws(() => setFrontMatter(task, { 'bad key': 1 }));
});

test('値は 1 行にする（改行を入れて行を足せない）', () => {
  assert.equal(oneLine(' a\nstatus: done\r\n b '), 'a status: done b');
  const out = setFrontMatter(task, { assignee: 'x\n---\nstatus: done' });
  assert.match(out, /^assignee: x --- status: done$/m);
  assert.equal(out.match(/^---$/gm).length, 2);
});

test('ログの末尾に 1 行を足す', () => {
  const out = appendLog(task, '2026-11-20T07:00:00+09:00 [dashboard:me] 並べ替え');
  assert.ok(out.endsWith('起票（direct）\n- 2026-11-20T07:00:00+09:00 [dashboard:me] 並べ替え\n'));
  const mid = appendLog('---\n---\n## ログ\n\n- a\n\n## 後ろ\n', 'b');
  assert.equal(mid, '---\n---\n## ログ\n\n- a\n- b\n\n## 後ろ\n');
  assert.equal(appendLog('---\n---\n## ログ\n', 'b'), '---\n---\n## ログ\n\n- b\n');
  assert.equal(appendLog('---\n---\n# 本文\n', 'b'), '---\n---\n# 本文\n\n## ログ\n\n- b\n');
});

test('回答を書く（空の行・置き換え・行が無い）', () => {
  let out = setAnswer(task, 'Q2', '2026-11-20「B」');
  assert.match(out, /案 A と B のどちらにしますか\n {2}- 回答: 2026-11-20「B」\n/);
  out = setAnswer(out, 'Q1', 'いいえ');
  assert.match(out, /マージしてよいですか\n {2}- 回答: いいえ\n/);
  out = setAnswer(out, 'Q3', '了解');
  assert.match(out, /回答の行が無い質問\n {2}- 回答: 了解\n/);
  assert.throws(() => setAnswer(task, 'Q9', 'x'));
  assert.throws(() => setAnswer(task, 'Q2', ' \n '));
});

test('まとめて書き換え: updated とログ。同じ値は書かない', () => {
  const r = applyTaskEdits(task, { front: { priority: 'high', status: 'ready' }, answers: { Q2: 'B' } }, { who: 'dashboard:me', now: '2026-11-20T08:00:00+09:00' });
  assert.equal(r.changed, true);
  assert.deepEqual(r.notes, ['status: waiting → ready', 'Q2 に回答']);
  assert.match(r.text, /^updated: 2026-11-20T08:00:00\+09:00$/m);
  assert.match(r.text, /- 2026-11-20T08:00:00\+09:00 \[dashboard:me\] status: waiting → ready、Q2 に回答\n$/);
  const none = applyTaskEdits(task, { front: { priority: 'high' } }, { who: 'dashboard:me' });
  assert.equal(none.changed, false);
  assert.equal(none.text, task);
  const note = applyTaskEdits(task, { log: 'メモだけ' }, { who: 'dashboard:me', now: 'T' });
  assert.match(note.text, /\[dashboard:me\] メモだけ\n$/);
});

test('order を読み、優先度の中で並べる（無いものは後ろ）', () => {
  assert.equal(parseOrder('15'), 15);
  assert.equal(parseOrder(''), null);
  assert.equal(parseOrder('abc'), null);
  const ts = [
    { id: 'a', status: 'ready', priority: 'high', order: null, created: '1' },
    { id: 'b', status: 'ready', priority: 'high', order: 20, created: '3' },
    { id: 'c', status: 'ready', priority: 'high', order: 10, created: '4' },
    { id: 'd', status: 'ready', priority: 'urgent', order: null, created: '5' },
  ];
  assert.deepEqual(sortTasks(ts).map((t) => t.id), ['d', 'c', 'b', 'a']);
});

const T = (id, priority, order, created) => ({ id, priority, order, created });

test('並べ替え: 前後の間に置ければ、動かしたものだけ', () => {
  const cols = priorityColumns([T('a', 'high', 10, '1'), T('b', 'high', 20, '2'), T('c', 'high', 30, '3'), T('n', 'normal', null, '4')]);
  assert.deepEqual(planReorder(cols, 'c', 'high', 1), [{ id: 'c', order: 15 }]);
  assert.deepEqual(planReorder(cols, 'c', 'high', 0), [{ id: 'c', order: 5 }]);
  assert.deepEqual(planReorder(cols, 'a', 'high', 2), [{ id: 'a', order: 40 }]);
  assert.deepEqual(planReorder(cols, 'b', 'high', 1), []);   // 同じ場所
  assert.deepEqual(planReorder(cols, 'n', 'high', 3), [{ id: 'n', priority: 'high', order: 40 }]);
  assert.deepEqual(planReorder(cols, 'a', 'normal', 0), [{ id: 'a', priority: 'normal', order: 10 }]);
  assert.deepEqual(planReorder(cols, 'a', 'low', 0), [{ id: 'a', priority: 'low', order: 10 }]);
});

test('並べ替え: 間が無い・order の無いものの間なら、列を振り直す', () => {
  const tight = priorityColumns([T('a', 'high', 10, '1'), T('b', 'high', 11, '2'), T('c', 'high', 12, '3')]);
  assert.deepEqual(planReorder(tight, 'c', 'high', 1), [{ id: 'c', order: 20 }, { id: 'b', order: 30 }]);
  const plain = priorityColumns([T('a', 'normal', null, '1'), T('b', 'normal', null, '2'), T('c', 'normal', null, '3')]);
  assert.deepEqual(planReorder(plain, 'c', 'normal', 0), [{ id: 'c', order: 10 }]);
  assert.deepEqual(planReorder(plain, 'c', 'normal', 1), [{ id: 'a', order: 10 }, { id: 'c', order: 20 }, { id: 'b', order: 30 }]);
  assert.throws(() => planReorder(plain, 'zz', 'normal', 0));
  assert.throws(() => planReorder(plain, 'a', 'top', 0));
});

test('並べ替えの結果を当てると、その順に並ぶ', () => {
  const ts = [T('a', 'high', 10, '1'), T('b', 'high', 11, '2'), T('c', 'high', null, '3'), T('d', 'high', null, '4'), T('x', 'low', null, '0')];
  for (const [id, to, at] of [['d', 'high', 0], ['a', 'high', 3], ['x', 'high', 2], ['c', 'low', 0], ['b', 'high', 2]]) {
    const cols = priorityColumns(ts);
    const want = cols[to].filter((t) => t.id !== id);
    want.splice(at, 0, ts.find((t) => t.id === id));
    const changes = planReorder(cols, id, to, at);
    const next = ts.map((t) => ({ ...t, ...(changes.find((c) => c.id === t.id) || {}) }));
    assert.deepEqual(priorityColumns(next)[to].map((t) => t.id), want.map((t) => t.id), `${id} → ${to}[${at}]`);
  }
});

test('時刻・差分・コミットのメッセージ', () => {
  assert.match(isoLocal(new Date('2026-11-20T00:00:00Z')), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
  const d = lineDiff('a\nb\nc\nd\ne\nf', 'a\nb\nC\nd\ne\nf', 1);
  assert.deepEqual(d.map((x) => x.kind + x.text), ['…', ' b', '-c', '+C', ' d', '…']);
  assert.deepEqual(lineDiff('a', 'a'), [{ kind: '…', text: '' }]);
  assert.equal(commitMessage('yzkn', '並べ替え', ['t1', 't2']), '[dashboard:yzkn] 並べ替え t1 t2');
  assert.equal(commitMessage('a b', '書き換え', ['1', '2', '3', '4', '5']), '[dashboard:unknown] 書き換え 1 2 3 ほか 2 件');
});
