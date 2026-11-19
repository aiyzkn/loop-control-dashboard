// node --test test/  （Node.js 18 以上。依存なし）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontMatter, parseTask, sortTasks, parseInbox, pickFiles, ageText, isOrgMember, section, bulletValue } from '../parse.js';

const task = `---
id: 20261119-demo
title: デモのタスク
project: demo
status: waiting
stage: implement
priority: high
assignee: any
claimed_by: pc1-claude
heartbeat_at: 2026-11-19T16:00:00+09:00
created: 2026-11-19T10:00:00+09:00
---

# デモのタスク

## 現在地

- 進行中: PR を作成済み
- 次の一手: マージされたら finish

## ログ
`;

test('タスクの先頭を読む', () => {
  const fm = parseFrontMatter(task);
  assert.equal(fm.id, '20261119-demo');
  assert.equal(fm.claimed_by, 'pc1-claude');
  assert.deepEqual(parseFrontMatter('先頭が --- でない'), {});
});

test('現在地の箇条を読む', () => {
  const s = section(task, '現在地');
  assert.equal(bulletValue(s, '進行中'), 'PR を作成済み');
  assert.equal(bulletValue(s, '次の一手'), 'マージされたら finish');
  const t = parseTask('projects/demo/tasks/20261119-demo.md', task);
  assert.equal(t.project, 'demo');
  assert.equal(t.status, 'waiting');
  assert.equal(t.claimedBy, 'pc1-claude');
  assert.equal(t.next, 'マージされたら finish');
  assert.equal(t.archived, false);
});

test('並びは状態 → 優先度 → 古い順', () => {
  const ts = sortTasks([
    { id: 'a', status: 'ready', priority: 'normal', created: '2' },
    { id: 'b', status: 'doing', priority: 'low', created: '3' },
    { id: 'c', status: 'ready', priority: 'urgent', created: '9' },
    { id: 'd', status: 'ready', priority: 'normal', created: '1' },
  ]);
  assert.deepEqual(ts.map((t) => t.id), ['b', 'c', 'd', 'a']);
});

const inbox = `# 受付

新しい依頼を、この下に足してください。

\`\`\`markdown
## <案件>: <件名>
優先: 緊急 | 高
\`\`\`

## demo: 冒頭に書いた依頼
優先: 緊急
本文

## 手が空いた時に実行するタスク

\`\`\`markdown
### <案件>: <件名>
\`\`\`

### （停止）my-app: 止めた定義
段階: 実装まで

### my-app: 小さなリファクタリング
段階: 実装まで
間隔: 週 1 回
最終実施: 2026-11-10 済み

<!-- ここから下に追記 -->

## demo: 末尾に書いた依頼
本文
`;

test('受付は書いた場所によらず数え、例と定義は数えない（Get-InboxSummary と同じ）', () => {
  const r = parseInbox(inbox);
  assert.deepEqual(r.items.map((i) => i.heading), ['demo: 冒頭に書いた依頼', 'demo: 末尾に書いた依頼']);
  assert.equal(r.urgent, 1);
  assert.equal(r.idle.length, 1);
  assert.deepEqual(r.idle[0], { project: 'my-app', title: '小さなリファクタリング', stage: 'implement', interval: '週 1 回', last: '2026-11-10 済み' });
});

test('読むファイルを選ぶ（完了したタスクは読まない）', () => {
  const r = pickFiles([
    { type: 'blob', path: 'projects/demo/tasks/a.md' },
    { type: 'blob', path: 'projects/demo/archive/b.md' },
    { type: 'blob', path: 'projects/demo/project.md' },
    { type: 'blob', path: 'state/pcs/pc1-claude.json' },
    { type: 'tree', path: 'state/pcs' },
    { type: 'blob', path: 'inbox.md' },
  ]);
  assert.deepEqual(r, { tasks: ['projects/demo/tasks/a.md'], pcs: ['state/pcs/pc1-claude.json'], inbox: 'inbox.md' });
});

test('何分前の表示', () => {
  const now = Date.parse('2026-11-19T12:00:00+09:00');
  assert.equal(ageText('2026-11-19T11:50:00+09:00', now), '10 分前');
  assert.equal(ageText('2026-11-19T09:00:00+09:00', now), '3 時間前');
  assert.equal(ageText('2026-11-26T12:00:00+09:00', now), '10080 分後');
  assert.equal(ageText('', now), '');
});

test('組織への所属の判定', () => {
  assert.equal(isOrgMember({ state: 'active' }, 0), true);
  assert.equal(isOrgMember({ state: 'pending' }, 404), false);
  assert.equal(isOrgMember(null, 204), true);
  assert.equal(isOrgMember(null, 404), false);
});
