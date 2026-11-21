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
    order: parseOrder(fm.order),
    questions: parseQuestions(text),
    progress: bulletValue(here, '進行中'),
    next: bulletValue(here, '次の一手'),
    // PR / MR を拾うための本文（成果物と現在地。そのままは表示しない）
    refsText: (section(text, '成果物') + '\n' + here).replace(/<!--[\s\S]*?-->/g, ''),
  };
}

const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };
const STATUS_RANK = { doing: 0, waiting: 1, blocked: 2, ready: 3, draft: 4, done: 5, dropped: 6 };
export function priorityRank(p) { return p in PRIORITY_RANK ? PRIORITY_RANK[p] : 2; }

// order（任意の数。小さいほど先）。無い・数でなければ null
export function parseOrder(v) {
  const s = String(v ?? '').trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

// 同じ優先度の中の並び: order（無いものは後ろ）→ 古い順
export function compareInPriority(a, b) {
  const ao = a.order ?? null, bo = b.order ?? null;
  if (ao !== null && bo !== null && ao !== bo) return ao - bo;
  if (ao !== null && bo === null) return -1;
  if (ao === null && bo !== null) return 1;
  return String(a.created).localeCompare(String(b.created));
}

// 一覧の並び: 状態ごとに、優先度の高い順 → order → 古い順（status.ps1 と同じ考え方）
export function sortTasks(tasks) {
  return [...tasks].sort((a, b) =>
    (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) ||
    priorityRank(a.priority) - priorityRank(b.priority) ||
    compareInPriority(a, b));
}

// 「利用者への質問と回答」の質問。`- Q<n>（…）: 質問` と、その下の `  - 回答: …`。line・answerLine は 0 始まり
export function parseQuestions(text) {
  const lines = String(text).split(/\r?\n/);
  const out = [];
  let inSec = false;
  let fence = false;
  let cur = null;
  lines.forEach((l, i) => {
    if (/^## /.test(l)) { inSec = l.slice(3).trim() === '利用者への質問と回答'; cur = null; return; }
    if (!inSec) return;
    if (/^\s*```/.test(l)) { fence = !fence; return; }
    if (fence || /^\s*<!--/.test(l)) return;
    const q = /^-\s*(Q\d+)(?![\w])\s*(.*)$/.exec(l);
    if (q) {
      cur = { id: q[1], question: q[2].replace(/^[（(][^）)]*[）)]\s*/, '').replace(/^[:：]\s*/, '').trim(), answer: '', answerLine: -1, line: i };
      out.push(cur);
      return;
    }
    const a = /^\s+-\s*回答[:：]\s*(.*)$/.exec(l);
    if (a && cur && cur.answerLine < 0) { cur.answer = a[1].trim(); cur.answerLine = i; }
  });
  return out;
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
  const projects = [];
  const archived = [];
  let inbox = '';
  let roster = '';
  for (const e of treeEntries) {
    if (e.type !== 'blob') continue;
    if (/^projects\/[^/]+\/tasks\/[^/]+\.md$/.test(e.path)) tasks.push(e.path);
    else if (/^projects\/[^/]+\/archive\/[^/]+\.md$/.test(e.path)) archived.push(e.path);   // 数えるだけで、読まない
    else if (/^projects\/[^/]+\/project\.md$/.test(e.path)) projects.push(e.path);
    else if (/^state\/pcs\/[^/]+\.json$/.test(e.path)) pcs.push(e.path);
    else if (e.path === 'inbox.md') inbox = e.path;
    else if (e.path === 'roster.md') roster = e.path;
  }
  return { tasks, pcs, inbox, projects, archived, roster };
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

// ---- リンクの組み立て（外部の URL は決まったホストだけ） ----

export const LINK_HOSTS = ['github.com', 'gitlab.com'];

// <ホスト>/<パス> の URL を組み立てる。ホストが決まったもの以外・パスに使えない文字があれば空
export function hostUrl(host, path = '') {
  const h = String(host || '').trim().toLowerCase();
  if (!LINK_HOSTS.includes(h)) return '';
  const p = String(path || '').trim().replace(/^\/+|\/+$/g, '');
  if (p && (!/^[A-Za-z0-9._~\-]+(\/[A-Za-z0-9._~\-]+)*$/.test(p) || p.split('/').some((x) => /^\.+$/.test(x)))) return '';
  return p ? `https://${h}/${p}` : `https://${h}/`;
}

// アカウント（ユーザー・組織）のプロフィール。'-' や空は無し
export function accountUrl(host, account) {
  const a = String(account || '').trim().replace(/^@/, '');
  if (!a || a === '-' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(a)) return '';
  return hostUrl(host, a);
}

// リポジトリ（<owner>/<repo>。GitLab はグループを重ねてよい）のページ。'-'・空・1 段だけのもの（未確定の書き方）は無し
export function repoUrl(host, repo) {
  const r = String(repo || '').trim().replace(/^\/+|\/+$/g, '');
  if (!r || r === '-' || r.split('/').length < 2) return '';
  return hostUrl(host, r);
}

const unquote = (s) => String(s || '').trim().replace(/^`+|`+$/g, '').trim();

// project.md の先頭と「## リポジトリ」の表（列: キー・ホスト・リポジトリ・アカウント・本流リモート・基準ブランチ・備考）
export function parseProject(path, text) {
  const fm = parseFrontMatter(text);
  const m = /^projects\/([^/]+)\/project\.md$/.exec(path);
  const repos = [];
  for (const l of section(text, 'リポジトリ').split(/\r?\n/)) {
    if (!/^\s*\|/.test(l) || /^\s*\|\s*-/.test(l)) continue;
    const cells = l.trim().replace(/^\||\|$/g, '').split('|').map(unquote);
    if (cells[0] === 'キー' || cells.length < 4) continue;
    const [key, host, repo, account, remote = '', branch = ''] = cells;
    repos.push({ key, host, repo, account, remote, branch, url: repoUrl(host, repo), accountUrl: accountUrl(host, account) });
  }
  return { path, id: m ? m[1] : (fm.project || ''), title: fm.title || '', stage: fm.default_stage || '', repos };
}

// roster.md の名簿の表。line は 1 始まりの行の番号（GitHub の #L<n> で辿る）
export function parseRoster(text) {
  const out = [];
  String(text).split(/\r?\n/).forEach((l, i) => {
    if (!/^\s*\|/.test(l) || /^\s*\|\s*-/.test(l)) return;
    const cells = l.trim().replace(/^\||\|$/g, '').split('|').map(unquote);
    if (cells[0] === 'ID' || !cells[0]) return;
    out.push({ id: cells[0], pc: cells[1] || '', tool: cells[2] || '', account: cells[3] || '', note: cells[5] || '', line: i + 1 });
  });
  return out;
}

// 本文の中の PR / MR。完全な URL（github.com の /pull/<n>、gitlab.com の /-/merge_requests/<n>）と、
// 案件のリポジトリが 1 つに決まるときの #<n>（GitHub）・!<n>（GitLab）
export function findPullRequests(text, repos = []) {
  const s = String(text || '');
  const seen = new Set();
  const out = [];
  const add = (url, label) => { if (url && !seen.has(url)) { seen.add(url); out.push({ url, label }); } };
  const re = /https:\/\/(github\.com|gitlab\.com)\/([A-Za-z0-9._\-]+(?:\/[A-Za-z0-9._\-]+)+?)\/(pull|-\/merge_requests)\/(\d+)/g;
  let m;
  while ((m = re.exec(s))) {
    const url = hostUrl(m[1], `${m[2]}/${m[3]}/${m[4]}`);
    add(url, `${m[2].split('/').pop()}${m[3] === 'pull' ? '#' : '!'}${m[4]}`);
  }
  const one = (host) => { const r = repos.filter((x) => String(x.host).toLowerCase() === host && x.url); return r.length === 1 ? r[0] : null; };
  const gh = one('github.com');
  const gl = one('gitlab.com');
  // コードの囲み（`...`・...）の中は、色コード（#475569）などで PR 番号ではないことが多いので見ない。番号は 5 桁まで
  const plain = s.replace(re, ' ').replace(/https?:\/\/\S+/g, ' ').replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const ref = /(^|[\s（(、,])([#!])(\d{1,5})(?![\w#!])/g;
  while ((m = ref.exec(plain))) {
    if (m[2] === '#' && gh) add(`${gh.url}/pull/${m[3]}`, `${gh.repo.split('/').pop()}#${m[3]}`);
    if (m[2] === '!' && gl) add(`${gl.url}/-/merge_requests/${m[3]}`, `${gl.repo.split('/').pop()}!${m[3]}`);
  }
  return out;
}

// ---- 信号（3 色）とグラフ用の集計 ----

const HOUR = 3600 * 1000;

// タスクの信号: red = 止まっている、yellow = 判断待ち・着手待ち（日数によらず）・印が古い（24 時間超）、green = 進んでいる、off = 下書き
export function taskSignal(t, now = Date.now()) {
  if (t.status === 'blocked') return 'red';
  if (t.status === 'waiting' || t.status === 'ready') return 'yellow';
  if (t.status === 'doing') {
    const hb = Date.parse(t.heartbeatAt);
    return !Number.isNaN(hb) && now - hb > 24 * HOUR ? 'yellow' : 'green';
  }
  return 'off';
}

// PC の信号: red = 失敗・3 時間超の無音、yellow = 上限で止まったセッションがある・見送り、green = それ以外
export function pcSignal(p, now = Date.now()) {
  const u = Date.parse(p.updatedAt);
  if (p.error || p.decision === 'error' || Number.isNaN(u) || now - u > 3 * HOUR) return 'red';
  if ((p.sessions && p.sessions.limit > 0) || p.decision === 'skip') return 'yellow';
  return 'green';
}

// 全体の信号: 赤が 1 つでもあれば赤、次に黄、緑があれば緑、何も無ければ off
export function overallSignal(signals) {
  for (const c of ['red', 'yellow', 'green']) if (signals.includes(c)) return c;
  return 'off';
}

// 案件ごと・状態ごとの件数（グラフの積み上げ）
export function countByProject(tasks, statuses = ['doing', 'waiting', 'blocked', 'ready', 'draft']) {
  const map = new Map();
  for (const t of tasks) {
    if (!statuses.includes(t.status)) continue;
    if (!map.has(t.project)) map.set(t.project, Object.fromEntries(statuses.map((s) => [s, 0])));
    map.get(t.project)[t.status]++;
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([project, counts]) => ({ project, counts }));
}

// タスクの ID（先頭の 8 桁の日付）で、日ごとの起票（tasks と archive）と完了（archive）の数。直近 days 日
export function countByDay(treePaths, days = 14, now = Date.now()) {
  const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push({ day: ymd(new Date(now - i * 24 * HOUR)), created: 0, archived: 0 });
  const idx = new Map(out.map((d, i) => [d.day, i]));
  for (const p of treePaths) {
    const m = /^projects\/[^/]+\/(tasks|archive)\/(\d{8})-[^/]+\.md$/.exec(p);
    if (!m || !idx.has(m[2])) continue;
    const d = out[idx.get(m[2])];
    d.created++;
    if (m[1] === 'archive') d.archived++;
  }
  return out;
}

// 完了の割合（0〜1）。archive の数 /（archive + 進行中・待ち）
export function doneRatio(archivedCount, openCount) {
  const all = archivedCount + openCount;
  return all ? archivedCount / all : 0;
}
