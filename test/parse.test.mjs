// node --test test/  （Node.js 18 以上。依存なし）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontMatter, parseTask, sortTasks, parseInbox, pickFiles, ageText, isOrgMember, section, bulletValue,
  hostUrl, accountUrl, repoUrl, parseProject, parseRoster, findPullRequests, taskSignal, pcSignal, overallSignal, countByProject, countByDay, doneRatio } from '../parse.js';

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
    { type: 'blob', path: 'roster.md' },
  ]);
  assert.deepEqual(r, { tasks: ['projects/demo/tasks/a.md'], pcs: ['state/pcs/pc1-claude.json'], inbox: 'inbox.md',
    projects: ['projects/demo/project.md'], archived: ['projects/demo/archive/b.md'], roster: 'roster.md' });
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

test('URL は決まったホストだけで組み立てる', () => {
  assert.equal(hostUrl('github.com', 'aiyzkn/loop-control'), 'https://github.com/aiyzkn/loop-control');
  assert.equal(hostUrl('GitLab.com', '/yzkn/vanilla/'), 'https://gitlab.com/yzkn/vanilla');
  assert.equal(hostUrl('evil.example', 'a/b'), '');
  assert.equal(hostUrl('github.com', 'a/b"onclick=x'), '');
  assert.equal(hostUrl('github.com', '../x'), '');
  assert.equal(accountUrl('github.com', 'yzknai'), 'https://github.com/yzknai');
  assert.equal(accountUrl('gitlab.com', '@yzkn'), 'https://gitlab.com/yzkn');
  assert.equal(accountUrl('github.com', '-'), '');
  assert.equal(accountUrl('github.com', 'a b'), '');
});

const project = `---
project: demo
title: デモの案件
default_stage: implement
---

# デモの案件

## リポジトリ

| キー | ホスト | リポジトリ | アカウント | 本流リモート | 基準ブランチ | 備考 |
|---|---|---|---|---|---|---|
| \`main\` | \`github.com\` | \`aiyzkn/demo\` | \`yzknai\` | \`origin\` | \`main\` | 本体 |
| \`e2e\` | \`gitlab.com\` | \`yzkn/demo-e2e\` | \`-\` | \`origin\` | \`main\` | |
| \`bad\` | \`example.com\` | \`x/y\` | \`z\` | \`origin\` | \`main\` | |

## 進め方
`;

test('project.md のリポジトリの表を読む', () => {
  const p = parseProject('projects/demo/project.md', project);
  assert.equal(p.id, 'demo');
  assert.equal(p.title, 'デモの案件');
  assert.equal(p.repos.length, 3);
  assert.deepEqual(p.repos[0], { key: 'main', host: 'github.com', repo: 'aiyzkn/demo', account: 'yzknai', remote: 'origin', branch: 'main', url: 'https://github.com/aiyzkn/demo', accountUrl: 'https://github.com/yzknai' });
  assert.equal(p.repos[1].accountUrl, '');
  assert.equal(p.repos[2].url, '');
});

test('名簿を読む（行の番号つき）', () => {
  const r = parseRoster('# 名簿\n\n| ID | PC | 道具 | AI のアカウント | 得意 | 備考 |\n|---|---|---|---|---|---|\n| `pc1-claude` | PC1 | Claude Code | x | y | GitHub: yzknai |\n');
  assert.deepEqual(r, [{ id: 'pc1-claude', pc: 'PC1', tool: 'Claude Code', note: 'GitHub: yzknai', line: 5 }]);
});

test('PR / MR を拾う', () => {
  const repos = parseProject('projects/demo/project.md', project).repos;
  const text = '- PR https://github.com/aiyzkn/demo/pull/12（説明）\n- MR https://gitlab.com/yzkn/demo-e2e/-/merge_requests/3\n- 続き #12 と #13、MR !4\n- 外部 https://evil.example/a/pull/1';
  assert.deepEqual(findPullRequests(text, repos), [
    { url: 'https://github.com/aiyzkn/demo/pull/12', label: 'demo#12' },
    { url: 'https://gitlab.com/yzkn/demo-e2e/-/merge_requests/3', label: 'demo-e2e!3' },
    { url: 'https://github.com/aiyzkn/demo/pull/13', label: 'demo#13' },
    { url: 'https://gitlab.com/yzkn/demo-e2e/-/merge_requests/4', label: 'demo-e2e!4' },
  ]);
  // GitHub のリポジトリが 2 つあると #番号 は決められない
  const two = [{ host: 'github.com', repo: 'a/x', url: 'https://github.com/a/x' }, { host: 'github.com', repo: 'a/y', url: 'https://github.com/a/y' }];
  assert.deepEqual(findPullRequests('#5', two), []);
});

test('未確定のリポジトリ（-）にはリンクを張らない・色コードを PR と読まない（事例 https://github.com/-/pull/475569）', () => {
  assert.equal(repoUrl('github.com', '-'), '');
  assert.equal(repoUrl('github.com', ''), '');
  assert.equal(repoUrl('github.com', 'aiyzkn'), '');
  assert.equal(repoUrl('github.com', 'aiyzkn/demo'), 'https://github.com/aiyzkn/demo');
  assert.equal(repoUrl('gitlab.com', 'g/sub/demo'), 'https://gitlab.com/g/sub/demo');
  const undecided = '## リポジトリ\n\n| キー | ホスト | リポジトリ | アカウント | 本流リモート | 基準ブランチ | 備考 |\n|---|---|---|---|---|---|---|\n| `main` | `github.com` | - | - | - | - | 未確定 |\n';
  const repos = parseProject('projects/hwrta/project.md', undecided).repos;
  assert.equal(repos[0].url, '');
  assert.deepEqual(findPullRequests('- 背景の色（#475569）を濃くする\n- 続き #12', repos), []);
  // リポジトリが決まっていても、コードの囲みの中と 6 桁以上は拾わない
  const one = [{ host: 'github.com', repo: 'a/x', url: 'https://github.com/a/x' }];
  assert.deepEqual(findPullRequests('色 `#475569` と（#475569）と ```\n#7\n``` と #8', one), [{ url: 'https://github.com/a/x/pull/8', label: 'x#8' }]);
});

test('信号の判定', () => {
  const now = Date.parse('2026-11-19T12:00:00+09:00');
  assert.equal(taskSignal({ status: 'blocked' }, now), 'red');
  assert.equal(taskSignal({ status: 'waiting' }, now), 'yellow');
  assert.equal(taskSignal({ status: 'doing', heartbeatAt: '2026-11-19T11:00:00+09:00' }, now), 'green');
  assert.equal(taskSignal({ status: 'doing', heartbeatAt: '2026-11-17T11:00:00+09:00' }, now), 'yellow');
  assert.equal(taskSignal({ status: 'ready', created: '2026-11-19T11:59:00+09:00' }, now), 'yellow');
  assert.equal(taskSignal({ status: 'draft' }, now), 'off');
  assert.equal(pcSignal({ updatedAt: '2026-11-19T11:30:00+09:00', decision: 'kick-work', sessions: { limit: 0 } }, now), 'green');
  assert.equal(pcSignal({ updatedAt: '2026-11-19T11:30:00+09:00', decision: 'skip' }, now), 'yellow');
  assert.equal(pcSignal({ updatedAt: '2026-11-19T11:30:00+09:00', sessions: { limit: 1 } }, now), 'yellow');
  assert.equal(pcSignal({ updatedAt: '2026-11-19T08:00:00+09:00' }, now), 'red');
  assert.equal(pcSignal({ updatedAt: '2026-11-19T11:30:00+09:00', decision: 'error' }, now), 'red');
  assert.equal(overallSignal(['green', 'yellow', 'off']), 'yellow');
  assert.equal(overallSignal(['off']), 'off');
});

test('グラフ用の集計', () => {
  const c = countByProject([{ project: 'b', status: 'doing' }, { project: 'a', status: 'ready' }, { project: 'a', status: 'ready' }, { project: 'a', status: 'done' }]);
  assert.deepEqual(c.map((x) => [x.project, x.counts.ready, x.counts.doing]), [['a', 2, 0], ['b', 0, 1]]);
  const now = Date.parse('2026-11-19T12:00:00+09:00');
  const d = countByDay(['projects/a/tasks/20261119-x.md', 'projects/a/archive/20261119-y.md', 'projects/a/archive/20261118-z.md', 'projects/a/tasks/20261101-old.md', 'projects/a/project.md'], 3, now);
  assert.deepEqual(d, [{ day: '20261117', created: 0, archived: 0 }, { day: '20261118', created: 1, archived: 1 }, { day: '20261119', created: 2, archived: 1 }]);
  assert.equal(doneRatio(3, 1), 0.75);
  assert.equal(doneRatio(0, 0), 0);
});
