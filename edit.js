// 指令リポジトリのタスクファイルを書き換えるための、純粋な関数（ブラウザでも Node.js の試験でも使う）。
// どれも「元の文字列 → 新しい文字列」で、通信はしない。書き込み（コミット）は app.js が行う。
// 形は auto-loop スキルの決まり（指令リポジトリの AGENTS.md 3 章）に合わせる。
import { parseQuestions, compareInPriority } from './parse.js';

export const PRIORITIES = ['urgent', 'high', 'normal', 'low'];
export const STATUSES = ['draft', 'ready', 'doing', 'waiting', 'review', 'blocked', 'done', 'dropped'];
// 利用者の番の状態（waiting = 判断・回答待ち、review = マージ待ち）。回答がそろう・PR をマージすると、エージェントの番（doing）に戻す
export const USER_TURN = ['waiting', 'review'];
export const STAGES = ['propose', 'implement', 'merge'];

// 1 行の値にする（改行・制御文字を空白に。前後の空白を除く）
export function oneLine(v) {
  return String(v ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const eolOf = (s) => (s.includes('\r\n') ? '\r\n' : '\n');

// 先頭の「キー: 値」を書き換える。updates の値が null なら、そのキーを消す。無いキーは、閉じの --- の前に足す。
// 先頭が無いファイルは変えない（例外を投げる）
export function setFrontMatter(text, updates) {
  const src = String(text);
  const lines = src.split(/\r?\n/);
  if (lines[0] !== '---') throw new Error('先頭（---）がありません');
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new Error('先頭の閉じ（---）がありません');
  const rest = { ...updates };
  const head = [];
  for (let i = 1; i < end; i++) {
    const m = /^([A-Za-z_][\w-]*):/.exec(lines[i]);
    if (m && Object.prototype.hasOwnProperty.call(rest, m[1])) {
      const v = rest[m[1]];
      delete rest[m[1]];
      if (v === null) continue;
      head.push(`${m[1]}: ${oneLine(v)}`.trimEnd());
    } else head.push(lines[i]);
  }
  for (const [k, v] of Object.entries(rest)) {
    if (v === null) continue;
    if (!/^[A-Za-z_][\w-]*$/.test(k)) throw new Error(`キーの名前が使えません: ${k}`);
    head.push(`${k}: ${oneLine(v)}`.trimEnd());
  }
  return ['---', ...head, ...lines.slice(end)].join(eolOf(src));
}

// 「## ログ」の末尾に 1 行を足す（AGENTS.md の形 `- <時刻> [<ID>] <出来事>`）。節が無ければ、ファイルの末尾に節を作る
export function appendLog(text, line) {
  const src = String(text);
  const lines = src.split(/\r?\n/);
  const entry = '- ' + oneLine(line).replace(/^-\s*/, '');
  const start = lines.findIndex((l) => l.trim() === '## ログ');
  if (start < 0) {
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return [...lines, '', '## ログ', '', entry, ''].join(eolOf(src));
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^## /.test(lines[i])) { end = i; break; }
  let last = start;   // 節の中の、最後の空でない行
  for (let i = start + 1; i < end; i++) if (lines[i].trim() !== '') last = i;
  const out = last === start
    ? [...lines.slice(0, start + 1), '', entry, ...lines.slice(start + 1)]
    : [...lines.slice(0, last + 1), entry, ...lines.slice(last + 1)];
  if (out[out.length - 1] !== '') out.push('');
  return out.join(eolOf(src));
}

// 質問 qid の「回答:」の行に、回答を書く（既に回答があれば、置き換える）。回答の行が無ければ、質問の下に足す
export function setAnswer(text, qid, answer) {
  const src = String(text);
  const lines = src.split(/\r?\n/);
  const q = parseQuestions(src).find((x) => x.id === qid);
  if (!q) throw new Error(`質問 ${qid} が見つかりません`);
  const body = oneLine(answer);
  if (!body) throw new Error('回答が空です');
  const row = `  - 回答: ${body}`;
  if (q.answerLine >= 0) lines[q.answerLine] = row;
  else lines.splice(q.line + 1, 0, row);
  return lines.join(eolOf(src));
}

// 優先度ごとの列（並べ替えの画面）。priority → order（無いものは後ろ）→ 古い順
export function priorityColumns(tasks) {
  const cols = Object.fromEntries(PRIORITIES.map((p) => [p, []]));
  for (const t of tasks) cols[PRIORITIES.includes(t.priority) ? t.priority : 'normal'].push(t);
  for (const p of PRIORITIES) cols[p].sort(compareInPriority);
  return cols;
}

// 並べ替え。columns は priorityColumns の形（いまの表示の順）。
// タスク id を、優先度 toPriority の列の toIndex 番目（その列から id を抜いた並びでの位置）に置く。
// 返すのは、書き換えるタスクごとの { id, priority?, order? }（変わらないものは返さない）。
// order の無いタスクは列の後ろに並ぶので、動かしたタスクの order は、できれば前後の間の値 1 つで済ませる。
// 済まないとき（間が無い・order の無いタスクの間に置いた）は、その列を 10 刻みで振り直す
export function planReorder(columns, id, toPriority, toIndex) {
  if (!PRIORITIES.includes(toPriority)) throw new Error(`優先度が使えません: ${toPriority}`);
  let moved = null;
  let from = null;
  for (const p of PRIORITIES) {
    const t = (columns[p] || []).find((x) => x.id === id);
    if (t) { moved = t; from = p; }
  }
  if (!moved) throw new Error(`タスク ${id} が見つかりません`);
  const before = columns[toPriority] || [];
  const dest = before.filter((x) => x.id !== id);
  const at = Math.max(0, Math.min(Math.trunc(Number(toIndex)) || 0, dest.length));
  if (from === toPriority && before.findIndex((x) => x.id === id) === at) return [];
  const after = [...dest.slice(0, at), moved, ...dest.slice(at)];
  const prev = after[at - 1];
  const next = after[at + 1];
  const po = prev ? prev.order ?? null : null;
  const no = next ? next.order ?? null : null;
  const int = (v) => v !== null && Number.isInteger(v);
  let order = null;
  if (!prev && (!next || no === null)) order = 10;                       // 先頭（後ろは order の無いものだけ）
  else if (!prev && int(no)) order = no > 10 ? no - 10 : no >= 2 ? Math.floor(no / 2) : null;
  else if (int(po) && (!next || no === null)) order = po + 10;          // order のある並びの最後
  else if (int(po) && int(no) && no - po >= 2) order = po + Math.floor((no - po) / 2);
  const priority = from !== toPriority ? { priority: toPriority } : {};
  if (order !== null) return [{ id, ...priority, order }];
  const changes = [];
  after.forEach((t, i) => {
    const c = t.id === id ? { ...priority } : {};
    const o = (i + 1) * 10;
    if (t.order !== o) c.order = o;
    if (Object.keys(c).length) changes.push({ id: t.id, ...c });
  });
  return changes;
}

// 時刻（ISO 8601、ローカルの時差つき。例 2026-11-20T08:00:00+09:00）
export function isoLocal(d = new Date()) {
  const pad = (n) => String(Math.trunc(Math.abs(n))).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${off >= 0 ? '+' : '-'}${pad(off / 60)}:${pad(off % 60)}`;
}

// 行の差分（確認の画面で見せる）。変わらない行は、変わった行の前後 ctx 行だけ残し、ほかは '…' にまとめる。
// 返すのは [{ kind: ' ' | '-' | '+' | '…', text }]
export function lineDiff(a, b, ctx = 1) {
  const x = String(a).split(/\r?\n/), y = String(b).split(/\r?\n/);
  // 先頭と末尾の同じ行を除いてから比べる（タスクファイルの書き換えは、ほとんどが数行）
  let s = 0;
  while (s < x.length && s < y.length && x[s] === y[s]) s++;
  let e = 0;
  while (e < x.length - s && e < y.length - s && x[x.length - 1 - e] === y[y.length - 1 - e]) e++;
  const xm = x.slice(s, x.length - e), ym = y.slice(s, y.length - e);
  const n = xm.length, m = ym.length;
  const ops = x.slice(0, s).map((t) => ({ kind: ' ', text: t }));
  if (n * m > 1_000_000) {
    ops.push(...xm.map((t) => ({ kind: '-', text: t })), ...ym.map((t) => ({ kind: '+', text: t })));
  } else {
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = xm[i] === ym[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && xm[i] === ym[j]) { ops.push({ kind: ' ', text: xm[i] }); i++; j++; }
      else if (i < n && (j >= m || L[i + 1][j] >= L[i][j + 1])) { ops.push({ kind: '-', text: xm[i] }); i++; }
      else { ops.push({ kind: '+', text: ym[j] }); j++; }
    }
  }
  ops.push(...x.slice(x.length - e).map((t) => ({ kind: ' ', text: t })));
  const near = ops.map((o, k) => o.kind !== ' ' || ops.slice(Math.max(0, k - ctx), k + ctx + 1).some((p) => p.kind !== ' '));
  const out = [];
  ops.forEach((o, k) => {
    if (near[k]) out.push(o);
    else if (!out.length || out[out.length - 1].kind !== '…') out.push({ kind: '…', text: '' });
  });
  return out;
}

// コミットのメッセージ（AGENTS.md の形に寄せる）: [dashboard:<ログイン>] <操作> <タスク ID…>
export function commitMessage(login, action, ids = []) {
  const who = /^[A-Za-z0-9-]+$/.test(String(login)) ? login : 'unknown';
  const list = [...new Set(ids)];
  const tail = list.length > 3 ? `${list.slice(0, 3).join(' ')} ほか ${list.length - 3} 件` : list.join(' ');
  return oneLine(`[dashboard:${who}] ${action}${tail ? ' ' + tail : ''}`);
}

// 書き込みの前の確かめ。changes = [{ path, overwrite? }]、treeEntries = 最新の tree（[{ path, sha }]）、blobs = 読んだ時点の Map(path → sha)。
// 読んだ時点から blob が変わった（ほかで書き換えられた・作られた・消された）ファイルの path を返す。
// overwrite の付いたもの（中身をすべてこのページが決めるファイル。即時実行の依頼）は比べない
export function staleChanges(changes, treeEntries, blobs) {
  const sha = new Map((treeEntries || []).map((e) => [e.path, e.sha]));
  return changes.filter((c) => !c.overwrite && sha.get(c.path) !== blobs.get(c.path)).map((c) => c.path);
}

// ---- 即時実行の依頼（キットの kick-poll.ps1 が kick.pollMinutes 分ごと（既定 3 分）に見に行き、kick.ps1 -Trigger now で起こす） ----

const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TASK_ID = /^\d{8}-[A-Za-z0-9][A-Za-z0-9-]*$/;

// 依頼のファイルの場所: state/kick/<エージェントの ID>.json
export function kickRequestPath(agentId) {
  if (!AGENT_ID.test(String(agentId || ''))) throw new Error(`エージェントの ID が使えません: ${agentId}`);
  return `state/kick/${agentId}.json`;
}

// 依頼の中身。task は任意（空なら /auto-loop next と同じ。あれば、そのタスクを先に再開・着手させる）
export function kickRequest({ by, task = '', now = isoLocal() }) {
  const t = String(task || '').trim();
  if (t && !TASK_ID.test(t)) throw new Error(`タスクの ID が使えません: ${t}`);
  return JSON.stringify({ requestedAt: now, by: oneLine(by), task: t }, null, 2) + '\n';
}

// 1 つのタスクの書き換えをまとめて行う。edits = { front?: {キー: 値}, answers?: {Q1: '…'}, log?: '出来事' }。
// front の値が元と同じものは書かない。何か変わったら updated を now にし、ログに 1 行を足す（log が無ければ変更の要約）
export function applyTaskEdits(text, edits, { who, now = isoLocal() } = {}) {
  let out = String(text);
  const notes = [];
  const fmNow = Object.fromEntries((/^---\r?\n([\s\S]*?)\r?\n---/.exec(out)?.[1] || '').split(/\r?\n/)
    .map((l) => /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].trim()]));
  const front = {};
  for (const [k, v] of Object.entries(edits.front || {})) {
    const nv = v === null ? null : oneLine(v);
    if ((fmNow[k] ?? null) === nv) continue;
    if (nv === null && !(k in fmNow)) continue;
    front[k] = nv;
    notes.push(nv === null ? `${k} を消す` : `${k}: ${fmNow[k] ?? '（なし）'} → ${nv}`);
  }
  let answered = 0;
  for (const [qid, ans] of Object.entries(edits.answers || {})) {
    if (!oneLine(ans)) continue;
    out = setAnswer(out, qid, ans);
    notes.push(`${qid} に回答`);
    answered++;
  }
  if (!('status' in front) && USER_TURN.includes(fmNow.status || '')) {
    const qs = parseQuestions(out);
    const allAnswered = answered > 0 && qs.length > 0 && qs.every((q) => q.answer);
    if (allAnswered || edits.handBack) {
      front.status = 'doing';
      notes.push(`${allAnswered ? '回答がそろったので' : 'マージしたので'} status: ${fmNow.status} → doing（エージェントの番）`);
    }
  }
  if (!notes.length && !oneLine(edits.log)) return { text: String(text), changed: false, notes };
  out = setFrontMatter(out, { ...front, updated: now });
  out = appendLog(out, `${now} [${who}] ${oneLine(edits.log) || notes.join('、')}`);
  return { text: out, changed: true, notes };
}

// ---- 依頼の登録（受付への追記・タスクファイルの作成） ----

export const SOURCES = ['inbox', 'direct', 'file', 'idle'];
const STAGE_INBOX = { propose: '提案だけ', implement: '実装まで', merge: 'マージまで' };
const PRIORITY_INBOX = { urgent: '緊急', high: '高', normal: '普通', low: '低' };

// 案件の名前（projects/ のフォルダ名）。英数字とハイフン・下線・点
export function isProjectName(v) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(v || '')) && !/^\.+$/.test(String(v));
}

// 短い名前（タスク ID の後半）。new-task.ps1 と同じく、小文字の英数字とハイフンにし、40 文字まで
export function normalizeSlug(v) {
  let s = String(v || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length > 40) s = s.slice(0, 40).replace(/-+$/, '');
  return s;
}

// タスク ID: <日付 8 桁>-<短い名前>。同じ案件の tasks/・archive/ に同じ名前があれば -2, -3 …（new-task.ps1 と同じ）
export function newTaskId(slug, existing, now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const base = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${slug}`;
  const taken = new Set(existing);
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

// 本文を、タスクファイル・受付の節を壊さない形にする。行頭の # は \# にする（「## ログ」などの見出しと取り違えないため）。
// 制御文字（改行・タブ以外）を除き、改行は LF に揃え、前後の空行を除く
export function safeBody(v) {
  return String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/g, '')
    .split('\n').map((l) => l.replace(/^(\s*)#/, '$1\\#').replace(/^(\s*)```/, '$1\\`\\`\\`')).join('\n')
    .replace(/^\n+|\s+$/g, '');
}

// 受付（inbox.md）に足す 1 件の文面。AGENTS.md・inbox.md の書き方（見出し + 段階・担当・優先 + 本文）
export function inboxEntry({ project, title, stage, priority, assignee, body }) {
  const p = String(project || '') === '新規' ? '新規' : project;
  if (p !== '新規' && !isProjectName(p)) throw new Error('案件を選んでください');
  const t = oneLine(title);
  if (!t) throw new Error('件名が空です');
  const lines = [`## ${p}: ${t}`];
  if (STAGE_INBOX[stage]) lines.push(`段階: ${STAGE_INBOX[stage]}`);
  const a = oneLine(assignee);
  if (a && a !== 'any') lines.push(`担当: ${a}`);
  if (PRIORITY_INBOX[priority]) lines.push(`優先: ${PRIORITY_INBOX[priority]}`);
  const b = safeBody(body);
  if (b) lines.push('', b);
  return lines.join('\n');
}

// 受付の末尾（目印 `<!-- ここから下に追記 -->` の下。無ければファイルの末尾）に 1 件を足す
export function appendToInbox(text, entry) {
  const src = String(text);
  const eol = eolOf(src);
  const lines = src.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return [...lines, '', ...String(entry).split('\n'), ''].join(eol);
}

// タスクファイルを、指令リポジトリのひな形（templates/task.md）から作る。new-task.ps1 と同じ置き換え
export function renderTask(template, { id, title, project, stage, priority, assignee, source = 'direct', request, now, agent }) {
  if (!isProjectName(project)) throw new Error('案件を選んでください');
  if (!STAGES.includes(stage)) throw new Error(`段階が使えません: ${stage}`);
  if (!PRIORITIES.includes(priority)) throw new Error(`優先度が使えません: ${priority}`);
  const t = oneLine(title);
  if (!t) throw new Error('件名が空です');
  const map = {
    '{{id}}': id, '{{title}}': t, '{{project}}': project, '{{stage}}': stage, '{{priority}}': priority,
    '{{source}}': SOURCES.includes(source) ? source : 'direct', '{{assignee}}': oneLine(assignee) || 'any',
    '{{now}}': now, '{{agent}}': agent, '{{request}}': safeBody(request) || '（依頼の原文をここに写す）',
  };
  let out = String(template).replace(/\r\n/g, '\n');
  if (!out.includes('{{id}}')) throw new Error('ひな形（templates/task.md）の形が想定と違います');
  for (const [k, v] of Object.entries(map)) out = out.split(k).join(String(v));
  return out;
}

// ---- PR のマージ（GitHub だけ。GitLab の MR は対象外） ----

export const MERGE_METHODS = ['merge', 'squash', 'rebase'];

// https://github.com/<owner>/<repo>/pull/<n> を分ける。ほかは null
export function parsePrUrl(url) {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d{1,7})$/.exec(String(url || ''));
  if (!m || /^\.+$/.test(m[2])) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

// 検査の結果をまとめる。checkRuns = GET …/commits/<sha>/check-runs の check_runs（読めなければ null）、
// status = GET …/commits/<sha>/status の結果（読めなければ null）。
// state: 'failure'（失敗がある）/ 'pending'（終わっていない）/ 'success'（全部成功・飛ばし）/ 'none'（検査が無い・読めない）
export function summarizeChecks(checkRuns, status) {
  const c = { success: 0, failure: 0, pending: 0, total: 0, failed: [] };
  for (const r of checkRuns || []) {
    c.total++;
    if (r.status !== 'completed') c.pending++;
    else if (['success', 'neutral', 'skipped'].includes(r.conclusion)) c.success++;
    else { c.failure++; c.failed.push(r.name); }
  }
  for (const s of (status && status.statuses) || []) {
    c.total++;
    if (s.state === 'success') c.success++;
    else if (s.state === 'pending') c.pending++;
    else { c.failure++; c.failed.push(s.context); }
  }
  const state = c.failure ? 'failure' : c.pending ? 'pending' : c.total ? 'success' : 'none';
  return { state, ...c };
}

// マージしてよいか（画面で止める理由）。pr = GET /repos/{o}/{r}/pulls/{n} の結果
// access = { canPush, login, repo }。canPush が false なら、アカウント（トークンの持ち主）にそのリポジトリへの書き込みの権限が無い。
// fine-grained のトークンは、持ち主の権限を超えられないので、トークンを直しても足りない
export function mergeVerdict(pr, checks, access = {}) {
  const reasons = [];
  if (!pr) return { ok: false, reasons: ['PR を読めません'] };
  if (pr.merged) return { ok: false, merged: true, reasons: ['マージ済みです'] };
  if (pr.state !== 'open') reasons.push('閉じています');
  if (pr.draft) reasons.push('下書き（draft）です');
  if (pr.mergeable === false || pr.mergeable_state === 'dirty') reasons.push('競合があります（手元で解消が要ります）');
  if (pr.mergeable === null || pr.mergeable === undefined) reasons.push('マージできるかを GitHub が計算中です。少し待って読み直してください');
  if (pr.mergeable_state === 'blocked') reasons.push('ブランチの保護の条件（レビュー・必須の検査など）を満たしていません');
  if (pr.mergeable_state === 'behind') reasons.push('基準ブランチより遅れています（保護の設定で、最新化が要ります）');
  if (checks && checks.state === 'failure') reasons.push(`検査が失敗しています: ${checks.failed.join('、')}`);
  if (checks && checks.state === 'pending') reasons.push('検査が終わっていません');
  if (access.canPush === false) reasons.push(`${access.login || 'このアカウント'} は ${access.repo || 'このリポジトリ'} に書き込めません（アカウントの権限。トークンでは足せません）。「GitHub で開く」から、書き込めるアカウントでマージしてください`);
  return { ok: reasons.length === 0, reasons, ...(access.canPush === false ? { noAccess: true } : {}) };
}

// ---- 未マージの PR の一覧 ----

// 案件の「リポジトリ」の表から、GitHub のリポジトリを重ねずに集める。[{ owner, repo, full, projects: [案件…] }]（名前の順）
export function githubRepos(projects) {
  const map = new Map();
  for (const p of projects) {
    for (const r of p.repos || []) {
      if (String(r.host).toLowerCase() !== 'github.com') continue;
      const m = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(String(r.repo || ''));
      if (!m || /^\.+$/.test(m[2])) continue;
      const full = `${m[1]}/${m[2]}`;
      const key = full.toLowerCase();
      if (!map.has(key)) map.set(key, { owner: m[1], repo: m[2], full, projects: [] });
      const e = map.get(key);
      if (!e.projects.includes(p.id)) e.projects.push(p.id);
    }
  }
  return [...map.values()].sort((a, b) => a.full.localeCompare(b.full));
}

// PR の URL に関係するタスク（成果物・現在地にその PR が書かれているもの）。進行中・待ちを先に、無ければ null。
// prsOf(t) = そのタスクの PR の URL の一覧（app.js が findPullRequests で作る）
export function taskForPr(tasks, url, prsOf) {
  const u = String(url).toLowerCase();
  const hit = tasks.filter((t) => prsOf(t).some((x) => String(x).toLowerCase() === u));
  return hit.find((t) => ['doing', 'waiting', 'review', 'blocked', 'ready', 'draft'].includes(t.status)) || hit[0] || null;
}
