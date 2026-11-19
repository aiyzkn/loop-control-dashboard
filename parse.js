// 指令リポジトリ（loop-control）のファイルを読むための、純粋な関数（ブラウザでも Node.js の試験でも使う）。
// 形は auto-loop スキル（aiyzkn/auto-loop-engineering の skills/auto-loop）の決まりに合わせる。

// タスクファイルの先頭（--- と --- の間）の「キー: 値」を読む
export function parseFrontMatter(text) {
  const lines = String(text).split(/\r?\n/);
  const fm = {};
  if (lines[0] !== '---') return fm;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') break;
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (m) fm[m[1]] = m[2].trim();
  }
  return fm;
}

// タスクファイルの「## <見出し>」の節の本文（次の ## まで）
export function section(text, heading) {
  const lines = String(text).split(/\r?\n/);
  const out = [];
  let inSec = false;
  for (const l of lines) {
    if (/^## /.test(l)) {
      if (inSec) break;
      inSec = l.slice(3).trim() === heading;
      continue;
    }
    if (inSec) out.push(l);
  }
  return out.join('\n').trim();
}

// 「現在地」の「- 次の一手: …」など、箇条の値を読む
export function bulletValue(sectionText, label) {
  for (const l of String(sectionText).split(/\r?\n/)) {
    const m = new RegExp('^-\\s*' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[:：]\\s*(.*)$').exec(l.trim());
    if (m) return m[1].trim();
  }
  return '';
}

// タスクファイルを、一覧に出す形にする
export function parseTask(path, text) {
  const fm = parseFrontMatter(text);
  const m = /^projects\/([^/]+)\/(tasks|archive)\/([^/]+)\.md$/.exec(path);
  const here = section(text, '現在地');
  return {
    path,
    project: fm.project || (m ? m[1] : ''),
    id: fm.id || (m ? m[3] : ''),
    archived: m ? m[2] === 'archive' : false,
    title: fm.title || '',
    status: fm.status || '',
    stage: fm.stage || '',
    priority: fm.priority || 'normal',
    assignee: fm.assignee || '',
    claimedBy: fm.claimed_by || '',
    heartbeatAt: fm.heartbeat_at || '',
    created: fm.created || '',
    updated: fm.updated || '',
    progress: bulletValue(here, '進行中'),
    next: bulletValue(here, '次の一手'),
  };
}

const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };
const STATUS_RANK = { doing: 0, waiting: 1, blocked: 2, ready: 3, draft: 4, done: 5, dropped: 6 };
export function priorityRank(p) { return p in PRIORITY_RANK ? PRIORITY_RANK[p] : 2; }

// 一覧の並び: 状態ごとに、優先度の高い順・古い順（status.ps1 と同じ考え方）
export function sortTasks(tasks) {
  return [...tasks].sort((a, b) =>
    (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) ||
    priorityRank(a.priority) - priorityRank(b.priority) ||
    String(a.created).localeCompare(String(b.created)));
}

// 受付（inbox.md）: 「## 」見出し 1 つが 1 件。コードの囲みの中と「## 手が空いた時に実行するタスク」の節は数えない（Get-InboxSummary と同じ）。
// 手が空いた時の定義（### <案件>: <件名>。「（停止）」で始まるものは除く）も返す
export function parseInbox(text) {
  const items = [];
  const idle = [];
  let fence = false;
  let mode = '';      // 'item' | 'idle' | ''
  let curIdle = null;
  for (const l of String(text).split(/\r?\n/)) {
    if (/^\s*```/.test(l)) { fence = !fence; continue; }
    if (fence) continue;
    if (/^##\s+\S/.test(l)) {
      if (/^##\s+手が空いた時に実行するタスク/.test(l)) { mode = 'idle'; continue; }
      mode = 'item';
      items.push({ heading: l.replace(/^##\s+/, '').trim(), urgent: false });
      continue;
    }
    if (mode === 'item' && /^優先[:：]\s*(緊急|urgent)/.test(l)) { items[items.length - 1].urgent = true; continue; }
    if (mode === 'idle') {
      if (/<!--\s*ここから下に追記/.test(l)) { mode = ''; curIdle = null; continue; }
      const h = /^###\s+(.+?)\s*$/.exec(l);
      if (h) {
        curIdle = null;
        if (/^[（(]停止[）)]/.test(h[1])) continue;
        const pm = /^([^:：]+)[:：]\s*(.+)$/.exec(h[1]);
        curIdle = { project: pm ? pm[1].trim() : '', title: pm ? pm[2].trim() : h[1], stage: 'propose', interval: '', last: '' };
        idle.push(curIdle);
        continue;
      }
      if (!curIdle) continue;
      let m;
      if ((m = /^段階[:：]\s*(.*)$/.exec(l))) curIdle.stage = /実装|implement/.test(m[1]) ? 'implement' : 'propose';
      else if ((m = /^間隔[:：]\s*(.*)$/.exec(l))) curIdle.interval = m[1].trim();
      else if ((m = /^最終実施[:：]\s*(.*)$/.exec(l))) curIdle.last = m[1].trim();
    }
  }
  return { items, urgent: items.filter((i) => i.urgent).length, idle };
}

// 指令リポジトリのファイルの一覧（git の tree）から、読むファイルを選ぶ
export function pickFiles(treeEntries) {
  const tasks = [];
  const pcs = [];
  let inbox = '';
  for (const e of treeEntries) {
    if (e.type !== 'blob') continue;
    if (/^projects\/[^/]+\/tasks\/[^/]+\.md$/.test(e.path)) tasks.push(e.path);
    else if (/^state\/pcs\/[^/]+\.json$/.test(e.path)) pcs.push(e.path);
    else if (e.path === 'inbox.md') inbox = e.path;
  }
  return { tasks, pcs, inbox };
}

// 「何分前」の表示。ISO 8601 が読めなければ空
export function ageText(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const min = Math.round((now - t) / 60000);
  if (min < 0) return `${-min} 分後`;
  if (min < 60) return `${min} 分前`;
  const h = Math.round(min / 6) / 10;
  if (h < 48) return `${h} 時間前`;
  return `${Math.round(h / 24)} 日前`;
}

// 組織への所属の判定。GET /user/memberships/orgs/<org> の結果（無ければ null）と、
// GET /orgs/<org>/members/<login> の HTTP の状態（204 = 所属）から決める
export function isOrgMember(membership, membersStatus) {
  if (membership && membership.state === 'active') return true;
  return membersStatus === 204;
}
