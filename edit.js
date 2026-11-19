// 指令リポジトリのタスクファイルを書き換えるための、純粋な関数（ブラウザでも Node.js の試験でも使う）。
// どれも「元の文字列 → 新しい文字列」で、通信はしない。書き込み（コミット）は app.js が行う。
// 形は auto-loop スキルの決まり（指令リポジトリの AGENTS.md 3 章）に合わせる。
import { parseQuestions, compareInPriority } from './parse.js';

export const PRIORITIES = ['urgent', 'high', 'normal', 'low'];
export const STATUSES = ['draft', 'ready', 'doing', 'waiting', 'blocked', 'done', 'dropped'];
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
  for (const [qid, ans] of Object.entries(edits.answers || {})) {
    if (!oneLine(ans)) continue;
    out = setAnswer(out, qid, ans);
    notes.push(`${qid} に回答`);
  }
  if (!notes.length && !oneLine(edits.log)) return { text: String(text), changed: false, notes };
  out = setFrontMatter(out, { ...front, updated: now });
  out = appendLog(out, `${now} [${who}] ${oneLine(edits.log) || notes.join('、')}`);
  return { text: out, changed: true, notes };
}
