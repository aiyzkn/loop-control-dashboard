// node --test test/  （Node.js 18 以上。依存なし）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTask, parseQuestions, sortTasks, parseOrder } from '../parse.js';
import { setFrontMatter, appendLog, setAnswer, planReorder, priorityColumns, isoLocal, lineDiff, commitMessage, oneLine, applyTaskEdits,
  parsePrUrl, summarizeChecks, mergeVerdict, staleChanges, kickRequestPath, kickRequest } from '../edit.js';

test('即時実行の依頼: 場所と中身。ID の形を確かめる', () => {
  assert.equal(kickRequestPath('a-msi-claude'), 'state/kick/a-msi-claude.json');
  assert.throws(() => kickRequestPath('../x'));
  assert.throws(() => kickRequestPath(''));
  const j = JSON.parse(kickRequest({ by: 'dashboard:me', task: '20261121-demo', now: '2026-11-21T23:50:00+09:00' }));
  assert.deepEqual(j, { requestedAt: '2026-11-21T23:50:00+09:00', by: 'dashboard:me', task: '20261121-demo' });
  assert.equal(JSON.parse(kickRequest({ by: 'dashboard:me', now: 'T' })).task, '');
  assert.throws(() => kickRequest({ by: 'x', task: 'x; rm -rf' }));
  assert.deepEqual(staleChanges([{ path: 'state/kick/a.json', overwrite: true }], [{ path: 'state/kick/a.json', sha: 'new' }], new Map()), [], '依頼は上書きしてよい');
});

test('書き込みの前の確かめ: 読んだ後に変わったファイルを見つける（先頭が同じでも）', () => {
  const blobs = new Map([['a.md', 's1'], ['b.md', 's2']]);
  const tree = [{ path: 'a.md', sha: 's1' }, { path: 'b.md', sha: 's9' }, { path: 'c.md', sha: 's3' }];
  assert.deepEqual(staleChanges([{ path: 'a.md' }], tree, blobs), []);
  assert.deepEqual(staleChanges([{ path: 'a.md' }, { path: 'b.md' }], tree, blobs), ['b.md'], 'エージェントが push した後の古い版');
  assert.deepEqual(staleChanges([{ path: 'new.md' }], tree, blobs), [], '新しいファイル');
  assert.deepEqual(staleChanges([{ path: 'c.md' }], tree, blobs), ['c.md'], '読んだ後にほかで作られた');
  assert.deepEqual(staleChanges([{ path: 'a.md' }], [], blobs), ['a.md'], '読んだ後に消された');
});

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

test('回答がそろったら doing に戻す（利用者の番 → エージェントの番）', () => {
  const now = '2026-11-20T08:00:00+09:00';
  const part = applyTaskEdits(task, { answers: { Q2: 'B' } }, { who: 'dashboard:me', now });
  assert.match(part.text, /^status: waiting$/m, 'Q3 が未回答なら waiting のまま');
  const all = applyTaskEdits(task, { answers: { Q2: 'B', Q3: '了解' } }, { who: 'dashboard:me', now });
  assert.match(all.text, /^status: doing$/m);
  assert.match(all.text, /^claimed_by: pc1-claude$/m, '担当は保つ');
  assert.deepEqual(all.notes, ['Q2 に回答', 'Q3 に回答', '回答がそろったので status: waiting → doing（エージェントの番）']);
  const review = task.replace('status: waiting', 'status: review');
  assert.match(applyTaskEdits(review, { answers: { Q2: 'B', Q3: 'マージした' } }, { who: 'dashboard:me', now }).text, /^status: doing$/m);
  const chosen = applyTaskEdits(task, { front: { status: 'blocked' }, answers: { Q2: 'B', Q3: '了解' } }, { who: 'dashboard:me', now });
  assert.match(chosen.text, /^status: blocked$/m, '状態を選んだときはそれに従う');
  const ready = task.replace('status: waiting', 'status: ready');
  assert.match(applyTaskEdits(ready, { answers: { Q2: 'B', Q3: '了解' } }, { who: 'dashboard:me', now }).text, /^status: ready$/m, '利用者の番でなければ変えない');
  const merged = applyTaskEdits(review, { log: 'PR をマージ', handBack: true }, { who: 'dashboard:me', now });
  assert.match(merged.text, /^status: doing$/m);
  assert.match(merged.text, /\[dashboard:me\] PR をマージ\n$/);
  assert.match(applyTaskEdits(task.replace('status: waiting', 'status: doing'), { log: 'PR をマージ', handBack: true }, { who: 'dashboard:me', now }).text, /^status: doing$/m);
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

test('PR の URL を分ける（GitHub だけ）', () => {
  assert.deepEqual(parsePrUrl('https://github.com/aiyzkn/GeoEdit/pull/21'), { owner: 'aiyzkn', repo: 'GeoEdit', number: 21 });
  assert.equal(parsePrUrl('https://gitlab.com/a/b/-/merge_requests/3'), null);
  assert.equal(parsePrUrl('https://github.com/a/../pull/1'), null);
  assert.equal(parsePrUrl('https://github.com/a/b/pull/1/files'), null);
});

test('検査の結果をまとめる', () => {
  const runs = [{ name: 'test', status: 'completed', conclusion: 'success' }, { name: 'lint', status: 'completed', conclusion: 'skipped' }];
  assert.equal(summarizeChecks(runs, null).state, 'success');
  assert.equal(summarizeChecks([...runs, { name: 'e2e', status: 'in_progress', conclusion: null }], null).state, 'pending');
  const bad = summarizeChecks(runs, { statuses: [{ context: 'ci/x', state: 'failure' }] });
  assert.equal(bad.state, 'failure');
  assert.deepEqual(bad.failed, ['ci/x']);
  assert.equal(summarizeChecks(null, null).state, 'none');
});

test('マージしてよいかの判定', () => {
  const pr = { state: 'open', merged: false, draft: false, mergeable: true, mergeable_state: 'clean' };
  assert.deepEqual(mergeVerdict(pr, { state: 'success', failed: [] }), { ok: true, reasons: [] });
  assert.equal(mergeVerdict(pr, { state: 'none', failed: [] }).ok, true);
  assert.equal(mergeVerdict({ ...pr, merged: true, state: 'closed' }, null).merged, true);
  assert.equal(mergeVerdict({ ...pr, mergeable: false, mergeable_state: 'dirty' }, null).ok, false);
  assert.equal(mergeVerdict({ ...pr, mergeable: null }, null).ok, false);
  assert.equal(mergeVerdict({ ...pr, draft: true }, null).ok, false);
  assert.match(mergeVerdict(pr, { state: 'failure', failed: ['test'] }).reasons[0], /test/);
  assert.equal(mergeVerdict(null, null).ok, false);
});

// ---- 依頼の登録 ----
import { normalizeSlug, newTaskId, safeBody, inboxEntry, appendToInbox, renderTask, isProjectName } from '../edit.js';
import { parseInbox, parseTask as parseTask2 } from '../parse.js';

test('normalizeSlug は new-task.ps1 と同じ形にする', () => {
  assert.equal(normalizeSlug(' UI Audit!! '), 'ui-audit');
  assert.equal(normalizeSlug('日本語だけ'), '');
  assert.equal(normalizeSlug('a'.repeat(50)).length, 40);
});

test('newTaskId は同じ名前があれば -2, -3 を付ける', () => {
  const d = new Date(2026, 10, 20);
  assert.equal(newTaskId('x', [], d), '20261120-x');
  assert.equal(newTaskId('x', ['20261120-x', '20261120-x-2'], d), '20261120-x-3');
});

test('safeBody は行頭の # とコードの囲みを無効にし、制御文字を除く', () => {
  assert.equal(safeBody('a\r\n## ログ\n```\nb\u0007\n\n'), 'a\n\\## ログ\n\\`\\`\\`\nb');
});

test('isProjectName は案件の名前だけを通す', () => {
  assert.ok(isProjectName('loop-kit'));
  assert.ok(isProjectName('i-co'));
  assert.ok(!isProjectName('../x'));
  assert.ok(!isProjectName('..'));
  assert.ok(!isProjectName(''));
});

test('inboxEntry → appendToInbox で、受付の件として読める', () => {
  const inbox = '# 受付\n\n## 手が空いた時に実行するタスク\n\n### vanilla: x\n段階: 提案だけ\n\n<!-- ここから下に追記 -->\n';
  const entry = inboxEntry({ project: 'loop-kit', title: '件名\nです', stage: 'implement', priority: 'urgent', assignee: 'any', body: '本文\n## 見出し' });
  assert.equal(entry, '## loop-kit: 件名 です\n段階: 実装まで\n優先: 緊急\n\n本文\n\\## 見出し');
  const out = appendToInbox(inbox, entry);
  assert.ok(out.endsWith('<!-- ここから下に追記 -->\n\n' + entry + '\n'));
  const parsed = parseInbox(out);
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].heading, 'loop-kit: 件名 です');
  assert.equal(parsed.items[0].urgent, true);
  assert.equal(parsed.idle.length, 1);
  assert.match(inboxEntry({ project: '新規', title: 't', stage: 'propose', priority: 'normal', assignee: 'claude' }), /^## 新規: t\n段階: 提案だけ\n担当: claude\n優先: 普通$/);
  assert.throws(() => inboxEntry({ project: '', title: 't' }));
  assert.throws(() => inboxEntry({ project: 'a', title: ' ' }));
});

test('renderTask はひな形を埋め、タスクとして読める', () => {
  const tpl = '---\nid: {{id}}\ntitle: {{title}}\nproject: {{project}}\nstatus: ready\nstage: {{stage}}\npriority: {{priority}}\norder:\nassignee: {{assignee}}\nclaimed_by:\nsource: {{source}}\ncreated: {{now}}\nupdated: {{now}}\n---\n\n# {{title}}\n\n## 依頼（原文）\n\n{{request}}\n\n## ログ\n\n- {{now}} [{{agent}}] 起票（{{source}}）\n';
  const text = renderTask(tpl, { id: '20261120-x', title: 'T', project: 'loop-kit', stage: 'propose', priority: 'low', assignee: '', request: '## ログ を壊さない', now: '2026-11-20T10:00:00+09:00', agent: 'dashboard:u' });
  assert.ok(!text.includes('{{'));
  assert.match(text, /\n\\## ログ を壊さない\n/);
  assert.match(text, /- 2026-11-20T10:00:00\+09:00 \[dashboard:u\] 起票（direct）/);
  const t = parseTask2('projects/loop-kit/tasks/20261120-x.md', text);
  assert.equal(t.status, 'ready');
  assert.equal(t.priority, 'low');
  assert.equal(t.assignee, 'any');
  assert.throws(() => renderTask(tpl, { id: 'x', title: 'T', project: 'loop-kit', stage: 'x', priority: 'low' }));
  assert.throws(() => renderTask('no placeholders', { id: 'x', title: 'T', project: 'loop-kit', stage: 'propose', priority: 'low' }));
});

import { githubRepos, taskForPr } from '../edit.js';

test('githubRepos は案件の表から GitHub のリポジトリを重ねずに集める', () => {
  const r = githubRepos([
    { id: 'a', repos: [{ host: 'github.com', repo: 'org/x' }, { host: 'gitlab.com', repo: 'g/y' }, { host: 'github.com', repo: '-' }] },
    { id: 'b', repos: [{ host: 'GitHub.com', repo: 'Org/X' }, { host: 'github.com', repo: 'org/a.b' }, { host: 'github.com', repo: 'org/..' }] },
  ]);
  assert.deepEqual(r.map((x) => [x.full, x.projects]), [['org/a.b', ['b']], ['org/x', ['a', 'b']]]);
});

test('taskForPr は PR を成果物に持つタスクを、進行中・待ちを先に返す', () => {
  const tasks = [{ id: 'old', status: 'done', prs: ['https://github.com/o/r/pull/1'] }, { id: 'now', status: 'waiting', prs: ['https://github.com/O/R/pull/1'] }, { id: 'z', status: 'ready', prs: [] }];
  assert.equal(taskForPr(tasks, 'https://github.com/o/r/pull/1', (t) => t.prs).id, 'now');
  assert.equal(taskForPr(tasks, 'https://github.com/o/r/pull/9', (t) => t.prs), null);
});

test('mergeVerdict はアカウントに書き込みの権限が無ければ止め、理由に書く', () => {
  const pr = { state: 'open', merged: false, draft: false, mergeable: true, mergeable_state: 'clean' };
  assert.equal(mergeVerdict(pr, null).ok, true);
  assert.equal(mergeVerdict(pr, null, { canPush: true }).ok, true);
  const v = mergeVerdict(pr, null, { canPush: false, login: 'yzknai', repo: 'aiyzkn/kit' });
  assert.equal(v.ok, false); assert.equal(v.noAccess, true);
  assert.match(v.reasons[0], /yzknai は aiyzkn\/kit に書き込めません（アカウントの権限/);
});
