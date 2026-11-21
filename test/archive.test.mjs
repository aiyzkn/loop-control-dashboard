// 完了したタスク（archive/）の扱い: 戻す・追記・写して起票
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTask, parseFrontMatter, section } from '../parse.js';
import { tasksPathOf, appendAddendum, reopenTask, addendumOnly, copyRequest, safeBody } from '../edit.js';

const done = `---
id: 20261120-demo
title: デモ
project: demo
status: done
stage: implement
priority: urgent
assignee: any
claimed_by:
claimed_at:
heartbeat_at: 2026-11-20T09:00:00+09:00
created: 2026-11-20T06:00:00+09:00
updated: 2026-11-20T09:00:00+09:00
---

# デモ

## 依頼（原文）

## demo: デモ
段階: 実装まで

ボタンを直して。

## 目的と完了条件

- 目的: 直す

## ログ

- 2026-11-20T06:00:00+09:00 [pc1-claude] 起票（inbox）
- 2026-11-20T06:01:00+09:00 [pc1-claude] claim
- 2026-11-20T09:00:00+09:00 [pc1-claude] release（done）
`;

const now = '2026-11-22T10:00:00+09:00';
const who = 'dashboard:yzknai';

test('tasksPathOf: archive/ → tasks/。それ以外は断る', () => {
  assert.equal(tasksPathOf('projects/demo/archive/20261120-demo.md'), 'projects/demo/tasks/20261120-demo.md');
  assert.throws(() => tasksPathOf('projects/demo/tasks/20261120-demo.md'));
  assert.throws(() => tasksPathOf('projects/../archive/x.md'));
});

test('appendAddendum: 依頼（原文）の末尾、次の節の前に日付つきで足す', () => {
  const out = appendAddendum(done, '色も\n## 見出しは崩さない', { who, now });
  // 原文の中の受付の見出し（## demo: デモ）では止まらず、ひな形の次の節（目的と完了条件）の前に入る
  assert.ok(out.includes('## demo: デモ\n段階: 実装まで\n\nボタンを直して。\n\n### 追記（2026-11-22、dashboard:yzknai）\n\n色も\n\\## 見出しは崩さない\n\n## 目的と完了条件\n'));
  assert.equal(section(out, '目的と完了条件'), '- 目的: 直す');
  assert.throws(() => appendAddendum(done, '  \n ', { who, now }), /空/);
});

test('appendAddendum: 節が無ければ先頭の直後に作る', () => {
  const out = appendAddendum('---\nid: x\n---\n\n## ログ\n', 'a', { who, now });
  assert.match(out, /^---\nid: x\n---\n\n## 依頼（原文）\n\n### 追記（2026-11-22、dashboard:yzknai）\n\na\n\n\n## ログ/);
});

test('reopenTask: ready・担当を空・ログに 1 行。assignee と追記も', () => {
  const out = reopenTask(done, { assignee: 'pc1-claude', addendum: 'やり直し', log: 'メモ', who, now });
  const fm = parseFrontMatter(out);
  assert.equal(fm.status, 'ready');
  assert.equal(fm.claimed_by, '');
  assert.equal(fm.heartbeat_at, '');
  assert.equal(fm.assignee, 'pc1-claude');
  assert.equal(fm.updated, now);
  assert.equal(fm.priority, 'urgent');   // 優先度は変えない
  assert.match(out, /ボタンを直して。\n\n### 追記（2026-11-22、dashboard:yzknai）\n\nやり直し\n\n## 目的と完了条件/);
  assert.match(out, /- 2026-11-22T10:00:00\+09:00 \[dashboard:yzknai\] 戻す（archive\/ → tasks\/、status: done → ready、assignee: pc1-claude、依頼に追記）。メモ\n$/);
  const t = parseTask('projects/demo/tasks/20261120-demo.md', out);
  assert.equal(t.status, 'ready');
  assert.equal(t.archived, false);
});

test('reopenTask: assignee が空なら元のまま。使えない状態は断る', () => {
  const out = reopenTask(done, { who, now });
  assert.equal(parseFrontMatter(out).assignee, 'any');
  assert.doesNotMatch(out, /依頼に追記/);
  assert.throws(() => reopenTask(done, { status: 'done', who, now }));
});

test('addendumOnly: archive/ のまま追記。状態は変えない', () => {
  const out = addendumOnly(done, '補足', { who, now });
  const fm = parseFrontMatter(out);
  assert.equal(fm.status, 'done');
  assert.equal(fm.updated, now);
  assert.match(out, /\[dashboard:yzknai\] 依頼に追記\n$/);
});

test('copyRequest: 依頼（原文）と「元: ID」。urgent は引き継がない', () => {
  const v = copyRequest(done, { id: '20261120-demo', path: 'projects/demo/archive/20261120-demo.md' });
  assert.equal(v.project, 'demo');
  assert.equal(v.title, 'デモ');
  assert.equal(v.stage, 'implement');
  assert.equal(v.priority, 'normal');
  assert.match(v.body, /^## demo: デモ\n段階: 実装まで\n\nボタンを直して。\n\n元: 20261120-demo（projects\/demo\/archive\/20261120-demo.md）$/);
  // 新しいタスクの本文に入るとき、見出しは \ 付きになる
  assert.match(safeBody(v.body), /^\\## demo: デモ/);
});

test('copyRequest: CRLF・節が無いときも動く', () => {
  const v = copyRequest(done.replace(/\n/g, '\r\n'), { id: 'x' });
  assert.match(v.body, /ボタンを直して。\n\n元: x$/);
  assert.equal(copyRequest('---\nid: y\nstage: odd\n---\n').body, '元: y');
  assert.equal(copyRequest('---\nid: y\nstage: odd\n---\n').stage, 'propose');
});
