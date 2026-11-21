// loop-control ダッシュボード。
// ブラウザから GitHub の API（https://api.github.com）を、利用者の fine-grained の個人用トークンで読む。
// トークンに書き込みの権限があれば、タスクの書き換え・並べ替え・依頼の登録を、確認の画面（差分）のあと 1 回 = 1 コミットで書く。
// このページ（公開）には、データを置かない。読めるかどうかは、トークンの権限（非公開の loop-control を読めるか）で決まる。
// 表示はすべて textContent と、組み立てた href（github.com / gitlab.com と、このリポジトリの blob だけ）で入れる。
import {
  parseTask, sortTasks, parseInbox, pickFiles, ageText, isOrgMember,
  parseProject, parseRoster, findPullRequests, taskSignal, pcSignal, overallSignal,
  countByProject, countByDay, doneRatio,
} from './parse.js';
import {
  PRIORITIES, STATUSES, STAGES, staleChanges, applyTaskEdits, planReorder, priorityColumns, lineDiff, commitMessage, isoLocal,
  MERGE_METHODS, parsePrUrl, summarizeChecks, mergeVerdict, githubRepos, taskForPr,
  normalizeSlug, newTaskId, inboxEntry, appendToInbox, renderTask,
} from './edit.js';
import { OPEN_STATUSES, projectSummary, matrix, shade, squarify, dayWindow, ganttRows, createdSeries, ribbonLayout, cumulative,
  calendarDays, sumDays, gridCells, timeTicks, limitRows, nightSpans, SUN_PLACE } from './viz.js';

const CONFIG = {
  org: 'aiyzkn',                 // 所属を確かめる組織
  owner: 'aiyzkn',               // 指令リポジトリ
  repo: 'loop-control',
  api: 'https://api.github.com',
};
const KEY = 'loop-control-dashboard.token';
const SVG_NS = 'http://www.w3.org/2000/svg';

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'href') { e.href = v; e.rel = 'noopener noreferrer'; e.target = '_blank'; }
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c != null) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
};
const svg = (tag, attrs = {}, ...children) => {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, String(v));
  for (const c of children) if (c != null) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
};
// href が空なら、ただの文字にする
const link = (href, text, cls) => (href ? el('a', { href, class: cls }, text) : el('span', { class: cls }, text));

function loadToken() {
  try { return sessionStorage.getItem(KEY) || localStorage.getItem(KEY) || ''; } catch { return ''; }
}
function saveToken(token, remember) {
  try {
    sessionStorage.setItem(KEY, token);
    if (remember) localStorage.setItem(KEY, token); else localStorage.removeItem(KEY);
  } catch { /* 保存できない環境（プライベートウィンドウなど）では、その場だけ使う */ }
}
function clearToken() {
  try { sessionStorage.removeItem(KEY); localStorage.removeItem(KEY); } catch { }
}

async function gh(token, path, { raw = false, allow404 = false, method = 'GET', body } = {}) {
  const res = await fetch(CONFIG.api + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  if (allow404 && (res.status === 404 || res.status === 403)) return { status: res.status, body: null };
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).message || ''; } catch { }
    const err = new Error(`GitHub API ${res.status}: ${method} ${path}${detail ? `（${detail}）` : ''}`);
    err.status = res.status;
    err.detail = detail;
    throw err;
  }
  if (res.status === 204) return { status: 204, body: null };
  return { status: res.status, body: raw ? await res.text() : await res.json() };
}

// 並列の数を絞って読む（API の二次的な制限を避ける）
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  });
  await Promise.all(workers);
  return out;
}

function setStatus(text, kind = '') {
  const s = $('status');
  s.textContent = text;
  s.className = 'status ' + kind;
}

async function load(token) {
  setStatus('確かめています…');
  // 1. 利用者と、組織への所属
  const me = (await gh(token, '/user')).body;
  const membership = (await gh(token, `/user/memberships/orgs/${CONFIG.org}`, { allow404: true })).body;
  let membersStatus = 0;
  if (!membership) membersStatus = (await gh(token, `/orgs/${CONFIG.org}/members/${encodeURIComponent(me.login)}`, { allow404: true })).status;
  if (!isOrgMember(membership, membersStatus)) {
    throw Object.assign(new Error(`${me.login} は ${CONFIG.org} の組織のメンバーと確かめられませんでした（トークンに組織の Members: Read が無い場合も、ここで止まります）`), { status: 'org' });
  }
  // 2. 指令リポジトリの一覧
  setStatus('読み込んでいます…');
  const repoInfo = (await gh(token, `/repos/${CONFIG.owner}/${CONFIG.repo}`)).body;
  const branch = repoInfo.default_branch;
  // 読んだ時点のコミットに固定して読む（書き込みのとき、ほかの変更との競合をこのコミットから見分ける）
  const head = await headOf(token, branch);
  const tree = (await gh(token, `${REPO()}/git/trees/${head.tree}?recursive=1`)).body;
  const entries = tree.tree || [];
  const files = pickFiles(entries);
  const read = (p) => gh(token, `${REPO()}/contents/${p.split('/').map(encodeURIComponent).join('/')}?ref=${head.sha}`, { raw: true }).then((r) => r.body);
  const [taskTexts, pcTexts, projectTexts, inboxText, rosterText] = await Promise.all([
    mapLimit(files.tasks, 6, read),
    mapLimit(files.pcs, 6, read),
    mapLimit(files.projects, 6, read),
    files.inbox ? read(files.inbox) : Promise.resolve(''),
    files.roster ? read(files.roster) : Promise.resolve(''),
  ]);
  const projects = new Map(files.projects.map((p, i) => { const x = parseProject(p, projectTexts[i]); return [x.id, x]; }));
  const tasks = sortTasks(files.tasks.map((p, i) => parseTask(p, taskTexts[i])));
  const pcs = pcTexts.map((t, i) => { try { return JSON.parse(t); } catch { return { agentId: files.pcs[i], error: '読めない' }; } });
  const inbox = parseInbox(inboxText);
  const roster = parseRoster(rosterText);
  // 書き込みに使う、読んだ時点の状態
  archivedCache = null;   // ガントチャートの完了は、読み込みのたびに読み直す（ボタンで）
  contribCache = null;    // GitHub の芝も、読み込みのたびに（ビジュアルの節を開いたときに）読み直す
  openPrsCache = null;    // 未マージの PR も、読み込みのたびに（節を開いたときに）読み直す
  ctx = {
    token, login: me.login, branch, head,
    canWrite: !!(repoInfo.permissions && repoInfo.permissions.push),
    blobs: new Map(entries.filter((e) => e.type === 'blob').map((e) => [e.path, e.sha])),
    texts: new Map(files.tasks.map((p, i) => [p, taskTexts[i]])),
    tasks,
    inboxPath: files.inbox, inboxText,
    taskPaths: [...files.tasks, ...files.archived],
    projectIds: [...projects.keys()].sort(),
  };
  view = {
    branch, tasks, pcs, inbox, projects, roster,
    archivedCount: files.archived.length,
    paths: entries.filter((e) => e.type === 'blob').map((e) => e.path),
    files, truncated: tree.truncated,
  };
  render(view);
  newRequestForm = ctx.canWrite ? buildNewRequestForm(roster) : null;
  $('newRequestBtn').hidden = !ctx.canWrite;
  $('tokenBox').open = false;
  setStatus(`${me.login} として表示しています（${new Date().toLocaleString()} 時点。自動では更新しません）${ctx.canWrite ? '。書き込みできます' : '。書き込みの権限が無いので、参照だけです'}`, 'ok');
}

let view = null;          // 表示に使った材料（書き込みの後は、ここを手元で直して描き直す）

// 書き込みの後に、全体を読み直さず、書いたファイルだけを手元の状態に反映して描き直す（API は tree の 1 回だけ）。
// changes = [{ path, content }]、commit = { sha, tree }。
// 書いていないファイルの blob の sha は、読んだ時点のままにする（ほかで変わっていたら、次の書き込みで競合として止めるため）
async function applyLocal(changes, commit) {
  ctx.head = commit;
  let now = null;
  try { now = new Map(((await gh(ctx.token, `${REPO()}/git/trees/${commit.tree}?recursive=1`)).body.tree || []).map((e) => [e.path, e.sha])); } catch { }
  for (const c of changes) {
    // 読めなければ消しておく（次にこのファイルを書くとき、ほかで変わっていなくても競合として止まる。「読み直す」で直る）
    if (now && now.has(c.path)) ctx.blobs.set(c.path, now.get(c.path)); else ctx.blobs.delete(c.path);
    if (c.path === ctx.inboxPath) {
      ctx.inboxText = c.content;
      view.inbox = parseInbox(c.content);
      continue;
    }
    if (!/^projects\/[^/]+\/tasks\/[^/]+\.md$/.test(c.path)) continue;
    if (!ctx.texts.has(c.path)) {
      view.files.tasks.push(c.path);
      view.paths.push(c.path);
      ctx.taskPaths.push(c.path);
    }
    ctx.texts.set(c.path, c.content);
    ctx.tasks = sortTasks([...ctx.tasks.filter((x) => x.path !== c.path), parseTask(c.path, c.content)]);
  }
  view.tasks = ctx.tasks;
  render(view);
}

// ---- 書き込み（1 回の操作 = 1 コミット。Git Data API） ----

let ctx = null;          // 読んだ時点の状態（load が作る）
let busy = false;        // 送っている間は、ほかの操作をしない
const REPO = () => `/repos/${CONFIG.owner}/${CONFIG.repo}`;

async function headOf(token, branch) {
  const ref = (await gh(token, `${REPO()}/git/ref/heads/${encodeURIComponent(branch)}`)).body;
  const commit = (await gh(token, `${REPO()}/git/commits/${ref.object.sha}`)).body;
  return { sha: ref.object.sha, tree: commit.tree.sha };
}

class Conflict extends Error {}

// changes = [{ path, content }]。読んだ時点から、書き換えるファイルがほかで変わっていたら、上書きせずに Conflict。
// ほかのファイルだけが変わっていた（PC の状況の更新など）なら、最新の上に積む。
// 先頭が手元の ctx.head と同じでも、必ず blob を比べる: 自分の書き込みのあと applyLocal が ctx.head を進めるが、
// 書いていないファイルの blob は読んだ時点のままなので、その間にエージェントが push した変更を見落とす（2026-11-21 に古い版で上書きした）
async function commitChanges(changes, message) {
  const { token, branch } = ctx;
  let base = await headOf(token, branch);
  const now = (await gh(token, `${REPO()}/git/trees/${base.tree}?recursive=1`)).body.tree || [];
  const moved = staleChanges(changes, now, ctx.blobs);
  if (moved.length) throw new Conflict(`読んだ後に、ほかで書き換えられています: ${moved.join('、')}`);
  const tree = (await gh(token, `${REPO()}/git/trees`, {
    method: 'POST',
    body: { base_tree: base.tree, tree: changes.map((c) => ({ path: c.path, mode: '100644', type: 'blob', content: c.content })) },
  })).body;
  const commit = (await gh(token, `${REPO()}/git/commits`, { method: 'POST', body: { message, tree: tree.sha, parents: [base.sha] } })).body;
  try {
    await gh(token, `${REPO()}/git/refs/heads/${encodeURIComponent(branch)}`, { method: 'PATCH', body: { sha: commit.sha, force: false } });
  } catch (e) {
    // fast-forward にならない = 送る間に、ほかの push が入った。作ったコミットは捨てる（どこからも指されない）
    if (e.status === 422) throw new Conflict('送っている間に、ほかの書き込みが入りました');
    throw e;
  }
  return { sha: commit.sha, tree: tree.sha };
}

// 送る（確認の画面から、または並べ替えで確認を省いたとき）。成功したら手元に反映して描き直す（全体は読み直さない）
async function sendChanges(items, message) {
  const changes = items.map((it) => ({ path: it.path, content: it.after }));
  const commit = await commitChanges(changes, message);
  await applyLocal(changes, commit);
  setStatus(`書き込みました（${commit.sha.slice(0, 7)}・${new Date().toLocaleTimeString()}）。ほかの変更は「読み直す」で取り込みます`, 'ok');
}

function writeError(e) {
  return e instanceof Conflict
    ? `${e.message}。上書きはしていません。「読み直す」で最新を読んでから、やり直してください`
    : e.status === 403 || e.status === 404
      ? `書き込めませんでした（${e.status}）。トークンに Contents: Read and write の権限があるか確かめてください`
      : (e.message || String(e));
}

// 確認の画面: 差分を見せ、「送る」でコミットする。items = [{ path, before, after }]
// back があれば「戻る」で前の画面へ、onSent は送れた後に呼ぶ
function confirmAndSend(title, items, message, { back, onSent } = {}) {
  const dlg = $('dialog');
  const body = el('div', { class: 'dlg-body' },
    el('p', { class: 'sub' }, `コミット: ${message}`),
    ...items.map((it) => el('div', { class: 'diff-file' },
      el('div', { class: 'diff-path' }, link(blobUrl(ctx.branch, it.path), it.path)),
      el('pre', { class: 'diff' }, ...lineDiff(it.before, it.after, 1).map((d) =>
        el('span', { class: d.kind === '+' ? 'add' : d.kind === '-' ? 'del' : d.kind === '…' ? 'gap' : '' }, `${d.kind === '…' ? '…' : d.kind} ${d.text}\n`))))));
  const msg = el('p', { class: 'status', role: 'status' });
  const send = el('button', { type: 'button', class: 'primary' }, `送る（${items.length} ファイル・1 コミット）`);
  const cancel = el('button', { type: 'button' }, 'やめる');
  cancel.addEventListener('click', () => dlg.close());
  send.addEventListener('click', async () => {
    if (busy) return;
    busy = true; send.disabled = true; cancel.disabled = true;
    msg.textContent = '送っています…'; msg.className = 'status';
    try {
      await sendChanges(items, message);
      if (onSent) onSent();
      dlg.close();
    } catch (e) {
      msg.className = 'status error';
      msg.textContent = writeError(e);
    } finally {
      busy = false; send.disabled = false; cancel.disabled = false;
    }
  });
  let backBtn = null;
  if (back) {
    backBtn = el('button', { type: 'button' }, '戻る');
    backBtn.addEventListener('click', () => { if (!busy) back(); });
  }
  dlg.replaceChildren(el('h2', {}, title), body, msg, el('div', { class: 'dlg-actions' }, cancel, backBtn, send));
  if (!dlg.open) dlg.showModal();
}

const WHO = () => `dashboard:${ctx.login}`;

// タスクの書き換えの画面（先頭の priority・status・stage・assignee、質問への回答、ログのメモ）
function openEditor(t) {
  if (!ctx || !ctx.canWrite || busy) return;
  const text = ctx.texts.get(t.path);
  const dlg = $('dialog');
  const select = (name, values, cur, labels = {}) => {
    const s = el('select', { name });
    for (const v of values) { const o = el('option', { value: v }, labels[v] ? `${labels[v]}（${v}）` : v); if (v === cur) o.selected = true; s.append(o); }
    if (!values.includes(cur)) { const o = el('option', { value: cur }, cur || '（なし）'); o.selected = true; s.prepend(o); }
    return s;
  };
  const f = {
    priority: select('priority', PRIORITIES, t.priority, PRIORITY_JA),
    status: select('status', STATUSES, t.status, STATUS_JA),
    stage: select('stage', STAGES, t.stage),
    assignee: el('input', { name: 'assignee', value: t.assignee, spellcheck: 'false' }),
  };
  const answers = t.questions.map((q) => ({ q, input: el('input', { name: q.id, placeholder: q.answer ? '置き換えるときだけ書く' : '回答を書く', spellcheck: 'false' }) }));
  const note = el('input', { name: 'log', placeholder: '（任意）ログに残すメモ。空なら変更の要約', spellcheck: 'false' });
  const row = (label, input, sub) => el('label', { class: 'field' }, el('span', {}, label), input, sub ? el('span', { class: 'sub' }, sub) : null);
  const msg = el('p', { class: 'status', role: 'status' });
  const next = el('button', { type: 'button', class: 'primary' }, '差分を見る');
  const cancel = el('button', { type: 'button' }, 'やめる');
  cancel.addEventListener('click', () => dlg.close());
  next.addEventListener('click', () => {
    const ans = {};
    for (const a of answers) if (a.input.value.trim()) { const v = a.input.value.trim(); ans[a.q.id] = `${isoLocal().slice(0, 10)}${/^[「『（(]/.test(v) ? '' : ' '}${v}`; }
    try {
      const r = applyTaskEdits(text, {
        front: { priority: f.priority.value, status: f.status.value, stage: f.stage.value, assignee: f.assignee.value },
        answers: ans, log: note.value,
      }, { who: WHO() });
      if (!r.changed) { msg.className = 'status'; msg.textContent = '変わったところがありません'; return; }
      confirmAndSend(`書き換えの確認: ${t.id}`, [{ path: t.path, before: text, after: r.text }], commitMessage(ctx.login, '書き換え', [t.id]));
    } catch (e) { msg.className = 'status error'; msg.textContent = e.message; }
  });
  dlg.replaceChildren(
    el('h2', {}, `書き換え: ${t.title || t.id}`),
    el('div', { class: 'dlg-body' },
      el('p', { class: 'sub' }, link(blobUrl(ctx.branch, t.path), t.path), t.claimedBy ? ` ・ 担当 ${t.claimedBy}（エージェントが作業中のことがあります。状態の書き換えは控えめに）` : ''),
      el('div', { class: 'fields' },
        row('優先度', f.priority, '緊急（urgent）にできるのは利用者だけ（AGENTS.md 7.1）'),
        row('状態', f.status, 'done・dropped にしても、archive/ への移動と担当の解放はしません（エージェントの finish で行う）'),
        row('段階', f.stage),
        row('割り当て（assignee）', f.assignee, 'any・エージェントの ID・道具の名前')),
      answers.length ? el('h3', {}, '利用者への質問と回答') : null,
      ...answers.map(({ q, input }) => el('div', { class: 'question' },
        el('div', {}, el('strong', {}, q.id), ' ', q.question),
        el('div', { class: 'sub' }, '回答: ', q.answer || '（まだ）'),
        input)),
      el('h3', {}, 'ログ'), note),
    msg, el('div', { class: 'dlg-actions' }, cancel, next));
  if (!dlg.open) dlg.showModal();
}

// 並べ替え: 動かしたタスクと、振り直しで order の変わるタスクを、1 コミットで
function moveTask(columns, id, toPriority, toIndex) {
  if (!ctx || !ctx.canWrite || busy) return;
  let plan;
  try { plan = planReorder(columns, id, toPriority, toIndex); } catch (e) { setStatus(e.message, 'error'); return; }
  if (!plan.length) return;
  const byId = new Map(ctx.tasks.map((t) => [t.id, t]));
  const now = isoLocal();
  const items = plan.map((c) => {
    const t = byId.get(c.id);
    const before = ctx.texts.get(t.path);
    const front = { ...(c.priority ? { priority: c.priority } : {}), ...(c.order != null ? { order: String(c.order) } : {}) };
    const what = c.id === id
      ? `並べ替え: ${c.priority ? `優先度 ${PRIORITY_JA[t.priority] || t.priority} → ${PRIORITY_JA[c.priority]}、` : ''}${PRIORITY_JA[toPriority]}の ${toIndex + 1} 番目へ（order ${c.order ?? t.order}）`
      : `並べ替え: ${id} を動かしたため order を ${t.order ?? '（なし）'} → ${c.order} に振り直し`;
    return { path: t.path, before, after: applyTaskEdits(before, { front, log: what }, { who: WHO(), now }).text };
  });
  const message = commitMessage(ctx.login, '並べ替え', plan.map((c) => c.id));
  if (!prefs.get('quickReorder')) { confirmAndSend(`並べ替えの確認: ${id}`, items, message); return; }
  // 確認を省くとき: 先に画面の並びを動かし（送っている間は操作できない）、送れたら確定、だめなら元に戻す
  const after = new Map(items.map((it) => [it.path, it.after]));
  const guess = ctx.tasks.map((t) => (after.has(t.path) ? parseTask(t.path, after.get(t.path)) : t));
  busy = true;
  renderBoard(guess.filter((t) => OPEN.includes(t.status)), { pending: true });
  setStatus(`並べ替えを送っています…（${id}）`);
  sendChanges(items, message)
    .catch((e) => { renderBoard(ctx.tasks.filter((t) => OPEN.includes(t.status))); setStatus(`並べ替えを送れませんでした: ${writeError(e)}`, 'error'); })
    .finally(() => { busy = false; });
}

// 並べ替えの画面: 優先度ごとの列。ドラッグ＆ドロップ、またはカードのボタン・Alt + 矢印キー
function renderBoard(open, { pending = false } = {}) {
  const board = $('board');
  if (!ctx.canWrite) {
    board.replaceChildren(el('p', { class: 'note' }, 'トークンに書き込みの権限が無いので、並べ替えはできません（README の「使い方」）'));
    return;
  }
  const columns = priorityColumns(open);
  let dragId = null;
  const indexAt = (list, y) => {
    const cards = [...list.querySelectorAll('.task-card')].filter((c) => c.dataset.id !== dragId);
    const i = cards.findIndex((c) => { const r = c.getBoundingClientRect(); return y < r.top + r.height / 2; });
    return i < 0 ? cards.length : i;
  };
  const cols = PRIORITIES.map((p, pi) => {
    const list = el('div', { class: 'col-list', 'data-priority': p });
    columns[p].forEach((t, i) => {
      const btn = (label, title, fn, disabled) => {
        const b = el('button', { type: 'button', class: 'mini', title, 'aria-label': `${t.id} を${title}` }, label);
        b.disabled = !!disabled;
        b.addEventListener('click', fn);
        return b;
      };
      const up = () => moveTask(columns, t.id, p, i - 1);
      const down = () => moveTask(columns, t.id, p, i + 1);
      const left = () => moveTask(columns, t.id, PRIORITIES[pi - 1], columns[PRIORITIES[pi - 1]].length);
      const right = () => moveTask(columns, t.id, PRIORITIES[pi + 1], 0);
      const card = el('div', { class: `task-card st-${t.status}`, draggable: 'true', tabindex: '0', 'data-id': t.id, 'aria-label': `${t.title || t.id}（${PRIORITY_JA[p]}の ${i + 1} 番目）。Alt + 矢印キーで動かす` },
        el('div', {}, el('span', { class: `badge st-${t.status}` }, STATUS_JA[t.status] || t.status), ' ', el('span', { class: 'sub' }, t.project)),
        el('div', { class: 'card-title' }, t.title || t.id),
        el('div', { class: 'card-foot' }, el('span', { class: 'sub' }, t.order != null ? `order ${t.order}` : 'order なし'),
          el('span', { class: 'card-btns' },
            btn('↑', '上へ', up, i === 0), btn('↓', '下へ', down, i === columns[p].length - 1),
            btn('←', '優先度を上げる', left, pi === 0), btn('→', '優先度を下げる', right, pi === PRIORITIES.length - 1),
            btn('✎', '書き換える', () => openEditor(t)))));
      card.addEventListener('dragstart', (ev) => { dragId = t.id; ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', t.id); card.classList.add('dragging'); });
      card.addEventListener('dragend', () => { dragId = null; card.classList.remove('dragging'); board.querySelectorAll('.over').forEach((x) => x.classList.remove('over')); });
      card.addEventListener('keydown', (ev) => {
        if (!ev.altKey) return;
        const fn = { ArrowUp: i > 0 && up, ArrowDown: i < columns[p].length - 1 && down, ArrowLeft: pi > 0 && left, ArrowRight: pi < PRIORITIES.length - 1 && right }[ev.key];
        if (fn) { ev.preventDefault(); fn(); }
      });
      list.append(card);
    });
    list.addEventListener('dragover', (ev) => { if (!dragId) return; ev.preventDefault(); ev.dataTransfer.dropEffect = 'move'; list.classList.add('over'); });
    list.addEventListener('dragleave', (ev) => { if (!list.contains(ev.relatedTarget)) list.classList.remove('over'); });
    list.addEventListener('drop', (ev) => { ev.preventDefault(); list.classList.remove('over'); if (dragId) moveTask(columns, dragId, p, indexAt(list, ev.clientY)); });
    return el('div', { class: `col pr-${p}` }, el('h3', {}, `${PRIORITY_JA[p]}（${columns[p].length}）`), list);
  });
  const quick = el('input', { type: 'checkbox', id: 'quickReorder' });
  quick.checked = !!prefs.get('quickReorder');
  quick.addEventListener('change', () => prefs.set('quickReorder', quick.checked));
  const reload = el('button', { type: 'button', class: 'mini' }, '読み直す');
  reload.addEventListener('click', () => $('reload').click());
  board.replaceChildren(
    el('div', { class: 'board-tools' },
      el('p', { class: 'note' }, '列の中・列の間でカードを動かすと、優先度（priority）と並びの順（order）を書き換えます。キーボードでは、カードを選んで Alt + 矢印キー。'),
      el('span', {}, el('label', {}, quick, ' 確認を省いてすぐ送る（このブラウザに覚えさせる）'), ' ', reload)),
    el('div', { class: 'board' + (pending ? ' pending' : '') }, ...cols));
}

// このブラウザに覚えさせる設定（開閉・確認を省くか・表示の色）。保存できない環境では、その場だけ
const prefs = {
  key: 'loop-control-dashboard.prefs',
  all() { try { return JSON.parse(localStorage.getItem(this.key) || '{}'); } catch { return {}; } },
  get(k) { return this.all()[k]; },
  set(k, v) { try { localStorage.setItem(this.key, JSON.stringify({ ...this.all(), [k]: v })); } catch { } },
};

const STATUS_JA = { doing: '作業中', waiting: '判断待ち', blocked: '止まっている', ready: '着手待ち', draft: '下書き' };
const OPEN = ['doing', 'waiting', 'blocked', 'ready', 'draft'];
const PRIORITY_JA = { urgent: '緊急', high: '高', normal: '普通', low: '低' };
const DECISION_JA = { 'kick-work': '起こした（作業）', 'kick-idle': '起こした（手が空いたとき）', skip: '見送り', error: '失敗' };
const SIGNAL_JA = { red: '赤（止まっている・失敗）', yellow: '黄（判断待ち・着手待ち・注意）', green: '緑（進んでいる）', off: '消灯（下書き・動きなし）' };

// 指令リポジトリ（CONFIG で固定）の blob。line を渡すと、その行へ
function blobUrl(branch, path, line) {
  const base = `https://github.com/${CONFIG.owner}/${CONFIG.repo}/blob/${encodeURIComponent(branch)}/${path.split('/').map(encodeURIComponent).join('/')}`;
  return line ? `${base}?plain=1#L${Number(line)}` : base;
}

// ---- 部品: 3 色信号・アナログメーター・グラフ ----

function signal(color, title) {
  return el('span', { class: `signal sig-${color}`, role: 'img', 'aria-label': `信号: ${SIGNAL_JA[color] || color}`, title: title || SIGNAL_JA[color] },
    el('span', { class: 'lamp r' }), el('span', { class: 'lamp y' }), el('span', { class: 'lamp g' }));
}

// 半円のメーター。ratio は 0〜1。tone は 'good-high'（高いほど緑）/ 'good-low'（低いほど緑）
function gauge({ ratio, label, value, sub, tone = 'good-high' }) {
  const r = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  const cx = 60, cy = 60, R = 48;
  const pt = (t) => [cx - R * Math.cos(Math.PI * t), cy - R * Math.sin(Math.PI * t)];
  const arc = (t0, t1) => { const [x0, y0] = pt(t0); const [x1, y1] = pt(t1); return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${R} ${R} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`; };
  const bands = tone === 'good-high' ? ['bad', 'mid', 'good'] : ['good', 'mid', 'bad'];
  const angle = -90 + 180 * r;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => {
    const [x0, y0] = [cx - (R - 12) * Math.cos(Math.PI * t), cy - (R - 12) * Math.sin(Math.PI * t)];
    const [x1, y1] = [cx - (R - 7) * Math.cos(Math.PI * t), cy - (R - 7) * Math.sin(Math.PI * t)];
    return svg('line', { x1: x0.toFixed(2), y1: y0.toFixed(2), x2: x1.toFixed(2), y2: y1.toFixed(2), class: 'tick' });
  });
  const face = svg('svg', { viewBox: '0 0 120 72', class: 'gauge-face', role: 'img', 'aria-label': `${label}: ${value}` },
    svg('path', { d: arc(0, 1 / 3), class: `band ${bands[0]}` }),
    svg('path', { d: arc(1 / 3, 2 / 3), class: `band ${bands[1]}` }),
    svg('path', { d: arc(2 / 3, 1), class: `band ${bands[2]}` }),
    ...ticks,
    svg('g', { transform: `rotate(${angle.toFixed(1)} ${cx} ${cy})` },
      svg('line', { x1: cx, y1: cy + 6, x2: cx, y2: cy - R + 4, class: 'needle' })),
    svg('circle', { cx, cy, r: 4, class: 'hub' }));
  return el('figure', { class: 'gauge' }, face,
    el('figcaption', {}, el('div', { class: 'gauge-value' }, value), el('div', { class: 'label' }, label), sub ? el('div', { class: 'sub' }, sub) : null));
}

// 案件ごとの状態の積み上げ横棒
function projectBars(rows, projects, branch) {
  if (!rows.length) return el('p', { class: 'note' }, '進行中・待ちのタスクはありません');
  const max = Math.max(...rows.map((r) => OPEN.reduce((a, s) => a + r.counts[s], 0)), 1);
  const list = el('div', { class: 'bars' });
  for (const r of rows) {
    const total = OPEN.reduce((a, s) => a + r.counts[s], 0);
    const W = 100;
    let x = 0;
    const segs = [];
    for (const s of OPEN) {
      const n = r.counts[s];
      if (!n) continue;
      const w = (n / max) * W;
      segs.push(svg('rect', { x: x.toFixed(2), y: 0, width: Math.max(w - 0.6, 0.4).toFixed(2), height: 10, class: `seg st-${s}` }, svg('title', {}, `${STATUS_JA[s]} ${n} 件`)));
      x += w;
    }
    const p = projects.get(r.project);
    list.append(el('div', { class: 'bar-row' },
      el('div', { class: 'bar-label' }, link(p ? blobUrl(branch, p.path) : '', r.project)),
      el('div', { class: 'bar-track' }, svg('svg', { viewBox: `0 0 ${W} 10`, preserveAspectRatio: 'none', class: 'bar-svg', role: 'img', 'aria-label': `${r.project}: ` + OPEN.filter((s) => r.counts[s]).map((s) => `${STATUS_JA[s]} ${r.counts[s]}`).join('、') }, ...segs)),
      el('div', { class: 'bar-num' }, String(total))));
  }
  const legend = el('div', { class: 'legend' }, ...OPEN.map((s) => el('span', {}, el('i', { class: `key st-${s}` }), STATUS_JA[s])));
  return el('div', {}, legend, list);
}

// 日ごとの起票と完了（縦棒）
function dayChart(days) {
  const max = Math.max(...days.map((d) => d.created), 1);
  const W = 14 * days.length, H = 60;
  const bars = [];
  days.forEach((d, i) => {
    const x = i * 14 + 2;
    const hc = (d.created / max) * (H - 4);
    const ha = (d.archived / max) * (H - 4);
    const tip = `${d.day.slice(4, 6)}/${d.day.slice(6)}: 起票 ${d.created} 件・うち完了 ${d.archived} 件`;
    bars.push(svg('g', {},
      svg('title', {}, tip),
      svg('rect', { x, y: H - hc, width: 10, height: Math.max(hc, d.created ? 1 : 0), class: 'col created' }),
      svg('rect', { x, y: H - ha, width: 10, height: ha, class: 'col archived' })));
  });
  const labels = days.map((d, i) => (i % 2 === days.length % 2 ? null :
    svg('text', { x: i * 14 + 7, y: H + 11, class: 'axis', 'text-anchor': 'middle' }, `${Number(d.day.slice(6))}`)));
  return el('div', {},
    el('div', { class: 'legend' }, el('span', {}, el('i', { class: 'key created' }), '起票'), el('span', {}, el('i', { class: 'key archived' }), 'うち完了')),
    svg('svg', { viewBox: `0 0 ${W} ${H + 14}`, class: 'day-chart', role: 'img', 'aria-label': `直近 ${days.length} 日の起票と完了` },
      svg('line', { x1: 0, y1: H, x2: W, y2: H, class: 'baseline' }), ...bars, ...labels.filter(Boolean)));
}

// 上限（5 時間・週）の帯と、夜（日の入り〜日の出。東京）の背景。PC の状況の limits から（20261121-dashboard-improve D4）。
// 行 = roster.md の「AI のアカウント」（未記入なら PC ごと）。窓の始まりは記録に無いので、解除時刻から窓の長さを引いた推定
function limitBlock({ pcs, roster, now }) {
  const t0 = new Date(now);
  const from = new Date(t0.getFullYear(), t0.getMonth(), t0.getDate() - 6).getTime();
  const to = new Date(t0.getFullYear(), t0.getMonth(), t0.getDate() + 2).getTime();
  const head = el('h3', {}, '上限の帯（直近 7 日と明日）');
  if (!pcs.some((p) => Array.isArray(p.limits))) {
    return el('div', { class: 'limits' }, head, el('p', { class: 'note' }, '上限の記録はまだありません（kick.ps1 が PC の状況に limits を書くようになると出ます）'));
  }
  const rows = limitRows(pcs, roster, from, to, now);
  const W = 960, L = 170, laneH = 12, gap = 4, top = 20, rowH = laneH * 2 + gap + 14;
  const H = top + rows.length * rowH;
  const x = (f) => L + f * (W - L);
  const two = (n) => String(n).padStart(2, '0');
  const fmt = (ms) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${two(d.getHours())}:${two(d.getMinutes())}`; };
  const chart = svg('svg', { class: 'limit-chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': '上限の帯（直近 7 日と明日）' });
  for (const n of nightSpans(from, to)) {
    chart.append(svg('rect', { class: 'night', x: x(n.x0), y: top - 4, width: Math.max(0, x(n.x1) - x(n.x0)), height: H - top + 4 },
      svg('title', {}, `夜（${SUN_PLACE.name}の日の入り〜日の出） ${fmt(n.from)} 〜 ${fmt(n.to)}`)));
  }
  for (const tk of timeTicks(from, to, 8)) {
    chart.append(svg('line', { class: 'grid', x1: x(tk.f), x2: x(tk.f), y1: top - 4, y2: H }));
    if (tk.label) chart.append(svg('text', { class: 'axis', x: x(tk.f) + 3, y: 12 }, tk.label));
  }
  rows.forEach((r, i) => {
    const y = top + i * rowH;
    const lanes = { seven_day: y, five_hour: y + laneH + gap };
    chart.append(
      svg('text', { class: 'row-name', x: 0, y: y + laneH - 1 }, r.name, svg('title', {}, r.agents.join(', '))),
      svg('text', { class: 'axis', x: L - 6, y: lanes.seven_day + laneH - 2, 'text-anchor': 'end' }, '週'),
      svg('text', { class: 'axis', x: L - 6, y: lanes.five_hour + laneH - 2, 'text-anchor': 'end' }, '5 時間'));
    for (const b of r.bands) {
      const label = b.kind === 'five_hour' ? '5 時間' : '週';
      chart.append(svg('rect', {
        class: `band k-${b.kind}${b.hit ? ' hit' : ''}${b.active ? ' active' : ''}`,
        x: x(b.x0), y: lanes[b.kind], width: Math.max(2, x(b.x1) - x(b.x0)), height: laneH, rx: 2,
      }, svg('title', {}, `${r.name}: ${label}の窓 開始（推定）${fmt(b.start)} 〜 解除 ${fmt(b.reset)}${b.hit ? '（上限に当たった）' : ''}${b.active ? '・いまの窓' : ''}`)));
    }
  });
  if (now >= from && now <= to) {
    const nx = x((now - from) / (to - from));
    chart.append(svg('line', { class: 'now', x1: nx, x2: nx, y1: top - 6, y2: H }, svg('title', {}, `いま ${fmt(now)}`)));
  }
  const key = (cls, text) => el('span', { class: 'key' }, el('span', { class: `swatch ${cls}` }), text);
  return el('div', { class: 'limits' }, head,
    el('div', { class: 'scroll' }, chart),
    el('p', { class: 'limit-legend sub' }, key('k-five_hour hit', '5 時間の窓'), key('k-seven_day hit', '週の窓'), key('miss', '上限に当たっていない窓'),
      key('night', `夜（${SUN_PLACE.name}の日の入り〜日の出）`), key('now', 'いま')),
    el('p', { class: 'note sub' }, '窓の始まりは記録に無いので、解除時刻から窓の長さ（5 時間・7 日）を引いた推定です。行は roster.md の「AI のアカウント」ごと（未記入なら PC ごと）。'));
}
// エージェントの ID → roster.md の行
function agentLink(id, roster, branch, files) {
  if (!id) return el('span', {}, '');
  const r = roster.find((x) => x.id === id);
  // 名簿に無いもの（any・道具の名前など）は、ただの文字
  return r && files.roster ? link(blobUrl(branch, files.roster, r.line), id, 'agent') : el('span', { class: 'agent' }, id);
}

function repoLinks(p) {
  if (!p || !p.repos.length) return el('span', { class: 'sub' }, '—');
  return el('ul', { class: 'repos' }, ...p.repos.map((r) => el('li', {},
    el('code', {}, r.key), ' ',
    link(r.url, r.repo || '(なし)'),
    r.url && r.branch ? el('span', { class: 'sub' }, ' ', link(`${r.url}/${r.host === 'gitlab.com' ? '-/' : ''}tree/${encodeURIComponent(r.branch)}`, r.branch)) : null,
    r.url ? el('span', { class: 'sub' }, ' ・ ', link(r.host === 'gitlab.com' ? `${r.url}/-/merge_requests` : `${r.url}/pulls`, r.host === 'gitlab.com' ? 'MR' : 'PR')) : null,
    r.account && r.account !== '-' ? el('span', { class: 'sub' }, ' ・ ', link(r.accountUrl, '@' + r.account, 'account')) : null)));
}

function render({ branch, tasks, pcs, inbox, projects, roster, archivedCount, paths, files, truncated }) {
  const now = Date.now();
  const open = tasks.filter((t) => OPEN.includes(t.status));
  const active = open.filter((t) => ['doing', 'waiting', 'blocked'].includes(t.status));
  const taskSigs = open.map((t) => taskSignal(t, now));
  const pcSigs = pcs.map((p) => pcSignal(p, now));
  const overall = overallSignal([...taskSigs, ...pcSigs]);

  // 参照のリンク（指令リポジトリの Markdown）
  $('repoName').replaceChildren(link(`https://github.com/${CONFIG.owner}/${CONFIG.repo}`, `${CONFIG.owner}/${CONFIG.repo}`));
  $('docs').replaceChildren(...['inbox.md', 'roster.md', 'policy.md', 'AGENTS.md', 'README.md']
    .filter((p) => paths.includes(p)).flatMap((p, i) => [i ? ' ・ ' : '', link(blobUrl(branch, p), p)]));

  // まとめ: 全体の信号・メーター・件数
  const counts = {};
  for (const t of open) counts[t.status] = (counts[t.status] || 0) + 1;
  const urgent = open.filter((t) => t.priority === 'urgent' && t.status !== 'draft').length + inbox.urgent;
  const newest = pcs.map((p) => Date.parse(p.updatedAt)).filter((x) => !Number.isNaN(x)).sort((a, b) => b - a)[0];
  const freshMin = newest ? Math.max(0, Math.round((now - newest) / 60000)) : null;
  const ratio = doneRatio(archivedCount, open.length);
  const moving = active.length ? (counts.doing || 0) / active.length : 0;

  $('overall').replaceChildren(
    el('div', { class: 'overall' }, signal(overall, SIGNAL_JA[overall]),
      el('div', {}, el('div', { class: 'overall-title' }, '全体の信号'), el('div', { class: 'sub' }, SIGNAL_JA[overall]),
        el('div', { class: 'sub' }, `タスク 赤 ${taskSigs.filter((s) => s === 'red').length} / 黄 ${taskSigs.filter((s) => s === 'yellow').length} / 緑 ${taskSigs.filter((s) => s === 'green').length}・PC 赤 ${pcSigs.filter((s) => s === 'red').length} / 黄 ${pcSigs.filter((s) => s === 'yellow').length} / 緑 ${pcSigs.filter((s) => s === 'green').length}`))),
    el('div', { class: 'gauges' },
      gauge({ ratio, label: '完了の割合', value: `${Math.round(ratio * 100)}%`, sub: `完了 ${archivedCount} / 全 ${archivedCount + open.length} 件` }),
      gauge({ ratio: moving, label: '手が動いている割合', value: active.length ? `${Math.round(moving * 100)}%` : '—', sub: `作業中 ${counts.doing || 0} / 担当中 ${active.length} 件` }),
      gauge({ ratio: freshMin == null ? 1 : Math.min(freshMin / 180, 1), label: 'PC の最後の確認', value: freshMin == null ? '—' : ageText(new Date(newest).toISOString(), now), sub: '3 時間で振り切れ', tone: 'good-low' })),
  );

  const summary = $('summary');
  summary.replaceChildren(
    ...[['作業中', counts.doing || 0, 'doing'], ['判断待ち', counts.waiting || 0, 'waiting'], ['止まっている', counts.blocked || 0, 'blocked'], ['着手待ち', counts.ready || 0, 'ready'], ['受付の未整理', inbox.items.length, 'inbox'], ['緊急', urgent, 'urgent']]
      .map(([k, v, c]) => el('div', { class: `card c-${c}` + ((c === 'urgent' || c === 'blocked') && v ? ' alert' : '') }, el('div', { class: 'num' }, v), el('div', { class: 'label' }, k))),
  );
  if (truncated) summary.append(el('p', { class: 'note' }, '※ ファイルが多く、一覧の一部しか読めませんでした'));

  // グラフ
  $('charts').replaceChildren(
    el('div', { class: 'chart' }, el('h3', {}, '案件ごとのタスク'), projectBars(countByProject(open), projects, branch)),
    el('div', { class: 'chart' }, el('h3', {}, '直近 14 日の起票と完了（タスク ID の日付）'), dayChart(countByDay(paths, 14, now))),
  );

  // ビジュアル（カード・マトリックス・ツリーマップ）
  renderVisuals({ open, files, projects, branch, now });

  // PC
  const pcBody = $('pcs');
  if (pcs.length === 0) {
    pcBody.replaceChildren(el('p', { class: 'note' }, 'PC の状況はまだありません（自動起動 kick.ps1 を有効にした PC が state/pcs/ に書きます）'));
  } else {
    const rows = pcs.sort((a, b) => String(a.agentId).localeCompare(String(b.agentId))).map((p) => {
      const s = p.sessions || {};
      const stale = Date.now() - Date.parse(p.updatedAt) > 3 * 3600 * 1000;
      const file = files.pcs.find((f) => f === `state/pcs/${p.agentId}.json`);
      const sess = p.sessions ? el('div', { class: 'sessions' },
        ...[['working', '動いている'], ['waiting-input', '入力待ち'], ['limit', '上限'], ['empty', '指示なし'], ['stale', '古い']]
          .map(([k, ja]) => el('span', { class: `pill s-${k}` + ((s[k] ?? 0) ? '' : ' zero') }, `${ja} ${s[k] ?? 0}`))) : '—';
      return el('tr', {},
        el('td', {}, signal(pcSignal(p, now))),
        el('td', {}, agentLink(p.agentId || '', roster, branch, files), el('div', { class: 'sub' }, p.pc || '', file ? ' ・ ' : '', file ? link(blobUrl(branch, file), 'JSON') : null)),
        el('td', { class: stale ? 'warn' : '' }, ageText(p.updatedAt), el('div', { class: 'sub' }, p.updatedAt || '')),
        el('td', {}, DECISION_JA[p.decision] || p.decision || '', el('div', { class: 'sub' }, p.reason || '')),
        el('td', {}, sess),
        el('td', {}, p.nextWakeAt ? `${ageText(p.nextWakeAt)}（${p.nextWakeAt}）` : '—'),
        el('td', {}, p.weeklyNextAt ? `${ageText(p.weeklyNextAt)}（${p.weeklyNextAt}）` : '—'),
        el('td', {}, p.lastLaunchedAt ? `${ageText(p.lastLaunchedAt)}（${p.lastKind || ''}）` : '—'),
      );
    });
    pcBody.replaceChildren(el('table', {},
      el('thead', {}, el('tr', {}, ...['信号', 'エージェント / PC', '最後の確認', '判断', 'セッション', '次の復帰（上限の解除）', '次の週次の起動', '前に起こした'].map((h) => el('th', {}, h)))),
      el('tbody', {}, ...rows)), limitBlock({ pcs, roster, now }));
  }

  // タスク
  const taskBody = $('tasks');
  if (open.length === 0) taskBody.replaceChildren(el('p', { class: 'note' }, '進行中・待ちのタスクはありません'));
  else {
    taskBody.replaceChildren(el('table', {},
      el('thead', {}, el('tr', {}, ...['信号', '状態', '優先', '案件', 'タスク', '段階', '担当', 'PR / MR', '現在地', ...(ctx.canWrite ? ['操作'] : [])].map((h) => el('th', {}, h)))),
      el('tbody', {}, ...open.map((t) => {
        const p = projects.get(t.project);
        const prs = findPullRequests(t.refsText, p ? p.repos : []);
        const who = t.claimedBy || t.assignee;
        return el('tr', { class: 'st-' + t.status },
          el('td', {}, signal(taskSignal(t, now))),
          el('td', {}, el('span', { class: `badge st-${t.status}` }, STATUS_JA[t.status] || t.status)),
          el('td', { class: 'pr-' + t.priority }, PRIORITY_JA[t.priority] || t.priority),
          el('td', {}, link(p ? blobUrl(branch, p.path) : '', t.project)),
          el('td', {}, link(blobUrl(branch, t.path), t.title || t.id), el('div', { class: 'sub' }, t.id)),
          el('td', {}, t.stage),
          el('td', {}, agentLink(who, roster, branch, files), el('div', { class: 'sub' }, t.heartbeatAt ? '印 ' + ageText(t.heartbeatAt) : '')),
          el('td', {}, prs.length ? el('ul', { class: 'prs' }, ...prs.map((x) => el('li', {}, link(x.url, x.label), parsePrUrl(x.url) ? mergeButton(t, x) : null))) : el('span', { class: 'sub' }, '—')),
          el('td', {}, t.progress, el('div', { class: 'sub' }, t.next ? '次: ' + t.next : '')),
          ctx.canWrite ? el('td', {}, editButton(t)) : null);
      })),
    ));
  }

  // 並べ替え
  renderBoard(open);

  // 未マージの PR（節を開いたときだけ読む）
  renderOpenPrs({ tasks, projects });

  // 案件とリポジトリ
  const pj = [...projects.values()].sort((a, b) => a.id.localeCompare(b.id));
  $('projects').replaceChildren(pj.length ? el('table', {},
    el('thead', {}, el('tr', {}, ...['案件', '進行中・待ち', '完了', 'リポジトリ・アカウント'].map((h) => el('th', {}, h)))),
    el('tbody', {}, ...pj.map((p) => {
      const mine = open.filter((t) => t.project === p.id);
      const done = files.archived.filter((x) => x.startsWith(`projects/${p.id}/archive/`)).length;
      return el('tr', {},
        el('td', {}, link(blobUrl(branch, p.path), p.id), el('div', { class: 'sub' }, p.title)),
        el('td', {}, String(mine.length), el('div', { class: 'sub' }, OPEN.filter((s) => mine.some((t) => t.status === s)).map((s) => `${STATUS_JA[s]} ${mine.filter((t) => t.status === s).length}`).join('・'))),
        el('td', {}, String(done)),
        el('td', {}, repoLinks(p)));
    }))) : el('p', { class: 'note' }, '案件がありません'));

  // 受付と、手が空いた時の定義
  const ib = $('inbox');
  ib.replaceChildren(
    el('h3', {}, `受付の未整理 ${inbox.items.length} 件`),
    inbox.items.length ? el('ul', {}, ...inbox.items.map((i) => el('li', {}, i.urgent ? el('span', { class: 'badge st-blocked' }, '緊急') : null, i.urgent ? ' ' : null, i.heading))) : el('p', { class: 'note' }, 'ありません'),
    el('h3', {}, `手が空いた時に実行するタスク ${inbox.idle.length} 件`),
    inbox.idle.length ? el('ul', {}, ...inbox.idle.map((d) => {
      const p = projects.get(d.project);
      return el('li', {}, link(p ? blobUrl(branch, p.path) : '', d.project), `: ${d.title}`,
        el('span', { class: 'sub' }, `（${d.stage === 'implement' ? '実装まで' : '提案だけ'}・${d.interval || '週 1 回'}・最終実施 ${d.last || 'なし'}）`));
    })) : el('p', { class: 'note' }, 'ありません'),
    files.inbox ? el('p', {}, link(blobUrl(branch, files.inbox), 'inbox.md を GitHub で開く')) : null,
  );
  $('main').hidden = false;
}

// ---- 依頼の登録（受付への追記、またはタスクファイルの作成。どちらも 1 コミット） ----

// 入力欄は読み込みのたびに 1 つ作り、ダイアログを閉じても入力を残す（送れたら空にする）
let newRequestForm = null;

function openNewRequest() {
  if (!ctx || !ctx.canWrite || busy || !newRequestForm) return;
  const dlg = $('dialog');
  dlg.replaceChildren(el('h2', {}, '依頼の登録'), newRequestForm.node);
  if (!dlg.open) dlg.showModal();
  newRequestForm.focus();
}

function buildNewRequestForm(roster) {
  const f = {
    dest: el('select', { name: 'dest' },
      el('option', { value: 'inbox' }, '受付（inbox.md）に追記する。エージェントが次の機会にタスクへ起こす'),
      el('option', { value: 'task' }, 'タスクファイルを直接作る（status: ready ですぐ一覧に出る）')),
    project: el('select', { name: 'project' }, el('option', { value: '' }, '（選ぶ）'), ...ctx.projectIds.map((p) => el('option', { value: p }, p))),
    title: el('input', { name: 'title', placeholder: '何をしてほしいか（1 行）', spellcheck: 'false' }),
    slug: el('input', { name: 'slug', placeholder: '英数字の短い名前（例 ui-audit）', spellcheck: 'false', autocomplete: 'off' }),
    stage: el('select', { name: 'stage' }, ...STAGES.map((s) => el('option', { value: s }, { propose: '提案だけ（propose）', implement: '実装・PR まで（implement）', merge: 'マージまで（merge）' }[s]))),
    priority: el('select', { name: 'priority' }, ...PRIORITIES.map((p) => el('option', { value: p }, `${PRIORITY_JA[p]}（${p}）`))),
    assignee: el('input', { name: 'assignee', value: 'any', spellcheck: 'false', list: 'agentIds' }),
    body: el('textarea', { name: 'body', rows: '6', placeholder: 'やってほしいこと・完了の条件・やらないこと・参考の場所（自由に。タスクファイルでは「依頼（原文）」に入る）', spellcheck: 'false' }),
  };
  f.priority.value = 'normal';
  const newOpt = el('option', { value: '新規' }, '新規（受付だけ。本文にリポジトリの場所を書く）');
  f.project.append(newOpt);
  const agents = el('datalist', { id: 'agentIds' }, ...['any', 'claude', 'copilot', ...roster.map((r) => r.id)].map((v) => el('option', { value: v })));
  const row = (label, input, sub) => el('label', { class: 'field' }, el('span', {}, label), input, sub ? el('span', { class: 'sub' }, sub) : null);
  const slugRow = row('短い名前（タスク ID の後半）', f.slug, 'タスクファイルを直接作るときだけ使う。小文字の英数字とハイフン');
  const sync = () => {
    const task = f.dest.value === 'task';
    slugRow.hidden = !task;
    newOpt.disabled = task;
    if (task && f.project.value === '新規') f.project.value = '';
  };
  f.dest.addEventListener('change', sync);
  sync();
  const msg = el('p', { class: 'status', role: 'status' });
  const next = el('button', { type: 'button', class: 'primary' }, '差分を見る');
  const cancel = el('button', { type: 'button' }, '閉じる（入力は残す）');
  cancel.addEventListener('click', () => $('dialog').close());
  const form = {
    node: el('div', { class: 'dlg-body new-request' },
      el('p', { class: 'note' }, '依頼を指令リポジトリに書きます。送る前に差分を見せます。緊急（urgent）は、作業中のエージェントが中断して先に行います（AGENTS.md 7.2）。'),
      agents,
      el('div', { class: 'fields' },
        row('書く先', f.dest), row('案件', f.project), row('件名', f.title), slugRow,
        row('段階', f.stage), row('優先度', f.priority), row('担当（assignee）', f.assignee, 'any・エージェントの ID・道具の名前')),
      el('label', { class: 'field' }, el('span', {}, '本文'), f.body),
      msg, el('div', { class: 'dlg-actions' }, cancel, next)),
    focus: () => (f.project.value ? f.title : f.project).focus(),
    reset: () => { f.title.value = ''; f.slug.value = ''; f.body.value = ''; msg.textContent = ''; },
  };
  next.addEventListener('click', () => submitNewRequest(f, msg, form).catch((e) => { msg.className = 'status error'; msg.textContent = e.message || String(e); }));
  return form;
}

async function submitNewRequest(f, msg, form) {
  const opts = { back: openNewRequest, onSent: form.reset };
  if (!ctx || !ctx.canWrite || busy) return;
  msg.className = 'status'; msg.textContent = '';
  const v = { project: f.project.value, title: f.title.value, stage: f.stage.value, priority: f.priority.value, assignee: f.assignee.value, body: f.body.value };
  if (f.dest.value === 'inbox') {
    if (!ctx.inboxPath) throw new Error('指令リポジトリに inbox.md がありません');
    const entry = inboxEntry(v);
    const after = appendToInbox(ctx.inboxText, entry);
    confirmAndSend(`受付への追記の確認: ${v.project}`, [{ path: ctx.inboxPath, before: ctx.inboxText, after }],
      commitMessage(ctx.login, `受付に追記 ${v.project}: ${v.title}`.slice(0, 100)), opts);
    return;
  }
  const slug = normalizeSlug(f.slug.value);
  if (!slug) throw new Error('短い名前（英数字）を入れてください');
  f.slug.value = slug;
  const prefix = `projects/${v.project}/`;
  const ids = ctx.taskPaths.filter((p) => p.startsWith(prefix)).map((p) => p.split('/').pop().replace(/\.md$/, ''));
  const id = newTaskId(slug, ids);
  const tpl = (await gh(ctx.token, `${REPO()}/contents/templates/task.md?ref=${ctx.head.sha}`, { raw: true })).body;
  const text = renderTask(tpl, { ...v, id, source: 'direct', request: v.body, now: isoLocal(), agent: WHO() });
  confirmAndSend(`タスクの作成の確認: ${id}`, [{ path: `${prefix}tasks/${id}.md`, before: '', after: text }], commitMessage(ctx.login, '起票', [id]), opts);
}

// ---- ビジュアル（見栄えのための部品。データはいまの一覧だけ。外部のライブラリは使わず DOM と SVG） ----

function renderVisuals({ open, files, projects, branch, now }) {
  const rows = projectSummary(open, files.archived, [...projects.keys()]);
  const projLink = (id, cls) => { const p = projects.get(id); return link(p ? blobUrl(branch, p.path) : '', id, cls); };
  $('visuals').replaceChildren(
    el('div', { class: 'viz-block' }, el('h3', {}, 'カード（案件ごと）'), projectCards(rows, projLink, now)),
    el('div', { class: 'viz-block' }, el('h3', {}, 'マトリックス（案件 × 状態・優先度）'), taskMatrix(open, rows, projLink)),
    el('div', { class: 'viz-block' }, el('h3', {}, 'ツリーマップ（案件の大きさ = タスクの数。中は状態と完了）'), treemap(rows)),
    el('div', { class: 'viz-block' }, el('h3', {}, 'ガントチャート（起票から今・完了まで）'), ganttBlock({ open, files, branch, now })),
    el('div', { class: 'viz-block' }, el('h3', {}, `リボンチャート（直近 ${RIBBON_DAYS} 日の起票の累計。日ごとに多い案件が上）`), ribbonChart(files, now)),
    el('div', { class: 'viz-block' }, el('h3', {}, `GitHub の芝（組織 ${CONFIG.org} とメンバー。直近 1 年）`), contribBlock()),
  );
}

// ---- ガントチャート ----

const GANTT_PERIODS = [1, 3, 7, 14, 30];   // 期間の選択肢（日）。1 = 今日だけ（3 時間ごとの目盛り）
const GANTT_DEFAULT = 14;
const GANTT_LIMIT = 20;           // 最初に出す行の数（新しい順）。「すべて表示」で残りを開く（ブラウザに覚える）
const GANTT_ARCHIVE_MAX = 40;    // 完了を読むのは、ID の日付が窓の始まりより期間ぶん前までのものを、新しい順にこの数まで
let archivedCache = null;        // 読んだ完了のタスク（パス → タスク。読み込みのたびに消す）

const ganttDays = () => { const d = Number(prefs.get('ganttDays')); return GANTT_PERIODS.includes(d) ? d : GANTT_DEFAULT; };

function ganttBlock({ open, files, branch, now }) {
  const box = el('div', {});
  const draw = () => {
    const days = ganttDays();
    const win = dayWindow(days, now);
    const allRows = ganttRows([...open, ...(archivedCache ? archivedCache.values() : [])], win.from, win.to);
    const showAll = !!prefs.get('ganttAll');
    const rows = showAll ? allRows : allRows.slice(0, GANTT_LIMIT);
    const LABEL = 220, W = 960, ROW = 22, TOP = 20;
    const X = (f) => LABEL + f * (W - LABEL - 8);
    const H = TOP + rows.length * ROW + 4;
    const ticks = timeTicks(win.from, win.to, days).map((tk) => {
      const x = X(tk.f);
      return svg('g', {}, svg('line', { x1: x.toFixed(1), y1: TOP - 4, x2: x.toFixed(1), y2: H, class: 'grid' }),
        tk.label ? svg('text', { x: (x + 2).toFixed(1), y: 12, class: 'axis' }, tk.label) : null);
    });
    const bars = rows.map((r, i) => {
      const y = TOP + i * ROW;
      const x0 = X(r.x0), x1 = Math.max(X(r.x1), X(r.x0) + 4);
      const tip = `${r.project} / ${r.title || r.id}（${r.done ? (r.status === 'dropped' ? '取りやめ' : '完了') : STATUS_JA[r.status] || r.status}）\n${new Date(r.start).toLocaleString()} 〜 ${r.done ? new Date(r.end).toLocaleString() : '今'}`;
      return svg('g', { class: 'gantt-row' },
        svg('title', {}, tip),
        svg('rect', { x: 0, y, width: W, height: ROW, class: 'gantt-hit' }),
        svg('text', { x: 4, y: y + 15, class: 'gantt-label' }, truncate(`${r.project} / ${r.title || r.id}`, 30)),
        svg('rect', { x: x0.toFixed(1), y: y + 5, width: (x1 - x0).toFixed(1), height: ROW - 10, rx: 3, class: r.done ? 'seg done gantt-bar' : `seg st-${r.status} gantt-bar` }),
        r.clipped ? svg('text', { x: (x0 + 2).toFixed(1), y: y + 15, class: 'gantt-clip' }, '‹') : null,
        r.hb != null ? svg('circle', { cx: X(r.hb).toFixed(1), cy: y + ROW / 2, r: 3, class: 'gantt-hb' }, svg('title', {}, '最後の印（heartbeat）')) : null);
    });
    const nowX = X(1);
    const chart = rows.length
      ? svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'gantt', role: 'img', 'aria-label': `ガントチャート: ${allRows.length} 件のうち ${rows.length} 件` }, ...ticks, ...bars,
        svg('line', { x1: nowX, y1: TOP - 4, x2: nowX, y2: H, class: 'gantt-now' }))
      : el('p', { class: 'note' }, `${periodLabel(days)}に掛かるタスクはありません`);
    const legend = el('div', { class: 'legend' }, ...OPEN_STATUSES.map((s) => el('span', {}, el('i', { class: `key st-${s}` }), STATUS_JA[s])),
      el('span', {}, el('i', { class: 'key done' }), '完了'), el('span', {}, el('i', { class: 'key hb' }), '最後の印'));
    // 完了は、まだ読んでいないものだけを、押したときに読む（期間を延ばすと、足りない分だけを読む）
    const missing = archivedCandidates(files.archived, win, days).filter((p) => !(archivedCache && archivedCache.has(p)));
    let more = null;
    if (missing.length) {
      more = el('button', { type: 'button', class: 'mini gantt-more' }, `完了したタスクも読む（${missing.length} 件。API を ${missing.length} 回）`);
      more.addEventListener('click', async () => {
        more.disabled = true; more.textContent = '読んでいます…';
        try {
          const texts = await mapLimit(missing, 6, (p) => gh(ctx.token, `${REPO()}/contents/${p.split('/').map(encodeURIComponent).join('/')}?ref=${ctx.head.sha}`, { raw: true }).then((r) => r.body));
          archivedCache ||= new Map();
          missing.forEach((p, i) => archivedCache.set(p, parseTask(p, texts[i])));
          draw();
        } catch (e) { more.disabled = false; more.textContent = `読めませんでした（${e.status || e.message}）。もう一度`; }
      });
    }
    // 期間の切り替え（ブラウザに覚える）
    const period = el('span', { class: 'gantt-period', role: 'group', 'aria-label': '期間' }, ...GANTT_PERIODS.map((d) => {
      const b = el('button', { type: 'button', class: 'mini' + (d === days ? ' primary' : ''), 'aria-pressed': d === days ? 'true' : 'false' }, d === 1 ? '今日' : `${d} 日`);
      b.addEventListener('click', () => { if (d !== days) { prefs.set('ganttDays', d); draw(); } });
      return b;
    }));
    let toggle = null;
    if (allRows.length > GANTT_LIMIT) {
      toggle = el('button', { type: 'button', class: 'mini gantt-toggle' }, showAll ? `新しい ${GANTT_LIMIT} 件だけにする` : `すべて表示（残り ${allRows.length - GANTT_LIMIT} 件）`);
      toggle.addEventListener('click', () => { prefs.set('ganttAll', !showAll); draw(); });
    }
    const count = el('span', { class: 'sub' }, allRows.length > GANTT_LIMIT ? `${allRows.length} 件のうち${showAll ? 'すべて' : `新しい ${rows.length} 件`}（進行中・待ちが先）` : `${allRows.length} 件`);
    box.replaceChildren(...[
      el('div', { class: 'gantt-tools' }, el('span', { class: 'sub' }, `期間: ${periodLabel(days)}`), period),
      legend, more ? el('p', {}, more) : null, el('div', { class: 'scroll' }, chart),
      el('p', { class: 'gantt-foot' }, count, toggle ? ' ' : null, toggle)].filter(Boolean));
  };
  draw();
  return box;
}

const periodLabel = (days) => (days === 1 ? '今日' : `直近 ${days} 日`);

// 完了（archive）のうち、ID の日付が窓の始まりより期間ぶん前以降のものを、新しい順に
function archivedCandidates(paths, win, days) {
  const from = new Date(win.from - days * 24 * 3600 * 1000);
  const min = `${from.getFullYear()}${String(from.getMonth() + 1).padStart(2, '0')}${String(from.getDate()).padStart(2, '0')}`;
  return paths.filter((p) => { const m = /\/archive\/(\d{8})-/.exec(p); return m && m[1] >= min; })
    .sort((a, b) => b.split('/').pop().localeCompare(a.split('/').pop())).slice(0, GANTT_ARCHIVE_MAX);
}

const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// ---- リボンチャート ----

const RIBBON_DAYS = 14;
const RIBBON_TOP = 7;            // 名前を出す案件の数。ほかは「その他」にまとめる
// 案件の色（dataviz の既定の分類の色。明暗それぞれ検査済み）。色は案件の名前の順で決め、順位では変えない
const RIBBON_SLOTS = 7;

function ribbonChart(files, now) {
  const win = dayWindow(RIBBON_DAYS, now);
  const raw = createdSeries([...files.tasks, ...files.archived], win.days);
  if (!raw.projects.length) return el('p', { class: 'note' }, `直近 ${RIBBON_DAYS} 日の起票はありません`);
  // 上位 RIBBON_TOP 件のほかは「その他」
  const named = raw.projects.slice(0, RIBBON_TOP);
  const values = Object.fromEntries(named.map((p) => [p, raw.values[p]]));
  const rest = raw.projects.slice(RIBBON_TOP);
  if (rest.length) values['その他'] = win.days.map((_, i) => rest.reduce((a, p) => a + raw.values[p][i], 0));
  const series = { projects: [...named, ...(rest.length ? ['その他'] : [])], days: win.days, values };
  const colorOf = new Map([...named].sort().map((p, i) => [p, `cat-${(i % RIBBON_SLOTS) + 1}`]));
  colorOf.set('その他', 'cat-other');
  const lay = ribbonLayout(cumulative(series));
  const W = 960, H = 260, TOP = 8, BOTTOM = 22, LEFT = 4, RIGHT = 120;
  const n = win.days.length;
  const colW = (W - LEFT - RIGHT) / n;
  const barW = Math.min(colW * 0.42, 28);
  const cx = (i) => LEFT + colW * i + colW / 2;
  const Y = (f) => TOP + f * (H - TOP - BOTTOM);
  const parts = [];
  // 帯（隣の期間の同じ案件を結ぶ）。帯を先に、棒を上に描く
  for (let i = 0; i < n - 1; i++) {
    const a = lay.columns[i], b = lay.columns[i + 1];
    for (const sa of a.segs) {
      const sb = b.segs.find((s) => s.project === sa.project);
      if (!sb) continue;
      const x0 = cx(i) + barW / 2, x1 = cx(i + 1) - barW / 2, xm = (x0 + x1) / 2;
      const d = `M${x0.toFixed(1)},${Y(sa.y0).toFixed(1)} C${xm.toFixed(1)},${Y(sa.y0).toFixed(1)} ${xm.toFixed(1)},${Y(sb.y0).toFixed(1)} ${x1.toFixed(1)},${Y(sb.y0).toFixed(1)}`
        + ` L${x1.toFixed(1)},${Y(sb.y1).toFixed(1)} C${xm.toFixed(1)},${Y(sb.y1).toFixed(1)} ${xm.toFixed(1)},${Y(sa.y1).toFixed(1)} ${x0.toFixed(1)},${Y(sa.y1).toFixed(1)} Z`;
      parts.push(svg('path', { d, class: `ribbon ${colorOf.get(sa.project)}` }, svg('title', {}, `${sa.project}: 累計 ${dayLabel(win.days[i])} ${sa.value} 件 → ${dayLabel(win.days[i + 1])} ${sb.value} 件`)));
    }
  }
  lay.columns.forEach((c, i) => {
    for (const s of c.segs) {
      const y0 = Y(s.y0) + 1, y1 = Y(s.y1) - 1;
      parts.push(svg('rect', { x: (cx(i) - barW / 2).toFixed(1), y: y0.toFixed(1), width: barW.toFixed(1), height: Math.max(y1 - y0, 1).toFixed(1), rx: 2, class: `ribbon-bar ${colorOf.get(s.project)}` },
        svg('title', {}, `${dayLabel(win.days[i])} ${s.project}: 累計 ${s.value} 件（${s.rank + 1} 位）`)));
    }
    if (i % 2 === (n - 1) % 2) parts.push(svg('text', { x: cx(i).toFixed(1), y: H - 6, class: 'axis', 'text-anchor': 'middle' }, dayLabel(win.days[i])));
  });
  // 直接のラベル: 最後に値のある期間の右に、案件の名前（色だけに頼らない）
  for (const p of series.projects) {
    let last = -1;
    for (let i = n - 1; i >= 0; i--) if (lay.columns[i].segs.some((s) => s.project === p)) { last = i; break; }
    if (last !== n - 1) continue;
    const s = lay.columns[last].segs.find((x) => x.project === p);
    if (Y(s.y1) - Y(s.y0) < 10) continue;
    parts.push(svg('text', { x: (cx(last) + barW / 2 + 4).toFixed(1), y: ((Y(s.y0) + Y(s.y1)) / 2 + 4).toFixed(1), class: 'ribbon-label' }, truncate(p, 16)));
  }
  const legend = el('div', { class: 'legend' }, ...series.projects.map((p) => el('span', {}, el('i', { class: `key ${colorOf.get(p)}` }), p)));
  return el('div', {}, legend, el('div', { class: 'scroll' }, svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'ribbon-chart', role: 'img', 'aria-label': `直近 ${RIBBON_DAYS} 日の案件ごとの起票: ` + series.projects.map((p) => `${p} ${series.values[p].reduce((a, b) => a + b, 0)} 件`).join('、') }, ...parts)));
}

const dayLabel = (d) => `${Number(d.slice(4, 6))}/${Number(d.slice(6))}`;

// ---- GitHub の芝（GraphQL の contributionsCollection） ----
// 行: 組織（メンバーごとの organizationID で絞った貢献の合計）と、メンバーそれぞれ（すべての貢献）。
// API は 3 回（メンバーの一覧・組織の ID・メンバーの貢献をまとめて）。ビジュアルの節を開いたときだけ読む

let contribCache = null;     // { rows } または { error }
let contribLoading = null;

function contribBlock() {
  const box = el('div', { class: 'contrib' }, el('p', { class: 'note' }, 'ビジュアルの節を開くと読みます'));
  const details = document.querySelector('details[data-fold=visuals]');
  const start = () => {
    if (contribCache) { drawContrib(box); return; }
    box.replaceChildren(el('p', { class: 'note' }, '読んでいます…'));
    contribLoading ||= fetchContributions().then((r) => { contribCache = r; }, (e) => { contribCache = { error: e }; }).finally(() => { contribLoading = null; });
    contribLoading.then(() => drawContrib(box));
  };
  if (details && details.open) start();
  else if (details) details.addEventListener('toggle', function once() { if (details.open) { details.removeEventListener('toggle', once); start(); } });
  return box;
}

async function fetchContributions() {
  const token = ctx.token;
  const members = ((await gh(token, `/orgs/${CONFIG.org}/members?per_page=100`)).body || []).map((m) => m.login).filter((l) => /^[A-Za-z0-9-]{1,39}$/.test(l)).sort();
  const gql = async (query, variables) => {
    const r = (await gh(token, '/graphql', { method: 'POST', body: { query, variables } })).body;
    if (r.errors && r.errors.length) throw Object.assign(new Error(r.errors.map((e) => e.message).join(' / ')), { status: 'graphql' });
    return r.data;
  };
  const orgId = (await gql('query($o:String!){organization(login:$o){id}}', { o: CONFIG.org })).organization.id;
  const cal = 'contributionCalendar{totalContributions weeks{contributionDays{date contributionCount}}}';
  const vars = Object.fromEntries(members.map((m, i) => [`l${i}`, m]));
  const query = `query($oid:ID!${members.map((_, i) => `,$l${i}:String!`).join('')}){${members.map((_, i) => `u${i}:user(login:$l${i}){login all:contributionsCollection{${cal}} org:contributionsCollection(organizationID:$oid){${cal}}}`).join(' ')}}`;
  const data = members.length ? await gql(query, { oid: orgId, ...vars }) : {};
  const users = members.map((_, i) => data[`u${i}`]).filter(Boolean);
  const orgDays = sumDays(users.map((u) => calendarDays(u.org.contributionCalendar.weeks)));
  return {
    rows: [
      { name: CONFIG.org, url: `https://github.com/${CONFIG.org}`, note: `メンバー ${users.length} 人の組織内の貢献の合計`, days: orgDays, total: users.reduce((a, u) => a + u.org.contributionCalendar.totalContributions, 0) },
      ...users.map((u) => ({ name: u.login, url: `https://github.com/${u.login}`, note: 'すべての貢献', days: calendarDays(u.all.contributionCalendar.weeks), total: u.all.contributionCalendar.totalContributions })),
    ],
  };
}

function drawContrib(box) {
  if (!contribCache) return;
  if (contribCache.error) {
    const e = contribCache.error;
    box.replaceChildren(el('p', { class: 'status error' }, `読めませんでした（${[e.status, e.message || String(e)].filter(Boolean).join(': ')}）。トークンに組織の Members: Read-only があるか確かめてください。fine-grained のトークンでは、ほかの人の非公開の貢献は数えられないことがあります`));
    return;
  }
  const C = 11, G = 2, LEFT = 0, TOP = 14;
  const rows = contribCache.rows.map((r) => {
    const cells = gridCells(r.days);
    const cols = cells.length ? cells[cells.length - 1].col + 1 : 0;
    const W = LEFT + cols * (C + G), H = TOP + 7 * (C + G);
    const months = [];
    let last = '';
    for (const c of cells) {
      const m = c.date.slice(5, 7);
      if (c.row === 0 && m !== last && c.col < cols - 2) { months.push(svg('text', { x: LEFT + c.col * (C + G), y: 10, class: 'axis' }, `${Number(m)}月`)); last = m; }
    }
    const rects = cells.map((c) => svg('rect', { x: LEFT + c.col * (C + G), y: TOP + c.row * (C + G), width: C, height: C, rx: 2, class: `cg cg-${c.level}` }, svg('title', {}, `${c.date}: ${c.count} 件`)));
    return el('div', { class: 'contrib-row' },
      el('div', { class: 'contrib-head' }, link(r.url, r.name, 'contrib-name'), el('span', { class: 'sub' }, ` ${r.total} 件（${r.note}）`)),
      el('div', { class: 'scroll' }, svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'contrib-svg', role: 'img', 'aria-label': `${r.name}: 直近 1 年に ${r.total} 件` }, ...months, ...rects)));
  });
  const legend = el('div', { class: 'legend' }, '少ない', ...[0, 1, 2, 3, 4].map((l) => el('i', { class: `key cg-${l}` })), '多い（濃さは行ごとの四分位）');
  box.replaceChildren(legend, ...rows);
}

// 案件ごとのカード: 進行中・待ちの数を大きく、完了・高以上・最終更新、状態の細い帯
function projectCards(rows, projLink, now) {
  const shown = rows.filter((r) => r.total > 0);
  if (!shown.length) return el('p', { class: 'note' }, 'タスクがありません');
  return el('div', { class: 'pcards' }, ...shown.map((r) => {
    const W = 100;
    let x = 0;
    const segs = [];
    for (const s of [...OPEN_STATUSES, 'done']) {
      const n = s === 'done' ? r.done : r.counts[s];
      if (!n) continue;
      const w = (n / r.total) * W;
      segs.push(svg('rect', { x: x.toFixed(2), y: 0, width: w.toFixed(2), height: 6, class: s === 'done' ? 'seg done' : `seg st-${s}` }, svg('title', {}, `${s === 'done' ? '完了' : STATUS_JA[s]} ${n} 件`)));
      x += w;
    }
    return el('div', { class: 'pcard' + (r.counts.blocked ? ' alert' : '') },
      el('div', { class: 'pcard-head' }, projLink(r.project, 'pcard-name'), r.high ? el('span', { class: 'badge pr-high-badge' }, `高以上 ${r.high}`) : null),
      el('div', { class: 'pcard-num' }, String(r.open), el('span', { class: 'sub' }, ' 件 進行中・待ち')),
      svg('svg', { viewBox: `0 0 ${W} 6`, preserveAspectRatio: 'none', class: 'pcard-bar', role: 'img', 'aria-label': `${r.project}: ` + [...OPEN_STATUSES.filter((s) => r.counts[s]).map((s) => `${STATUS_JA[s]} ${r.counts[s]}`), r.done ? `完了 ${r.done}` : ''].filter(Boolean).join('、') }, ...segs),
      el('div', { class: 'sub' }, `完了 ${r.done} 件`, r.latest ? ` ・ 更新 ${ageText(r.latest, now)}` : ''));
  }));
}

// マトリックス: 行 = 案件、列 = 状態と優先度。セルの濃さ = 件数
function taskMatrix(open, rows, projLink) {
  const ids = rows.filter((r) => r.open > 0).map((r) => r.project);
  if (!ids.length) return el('p', { class: 'note' }, '進行中・待ちのタスクはありません');
  const byStatus = matrix(open, ids, OPEN_STATUSES, (t) => [t.project, t.status]);
  const byPriority = matrix(open, ids, PRIORITIES, (t) => [t.project, PRIORITIES.includes(t.priority) ? t.priority : 'normal']);
  const cell = (v, max, cls) => {
    const td = el('td', { class: `mx-cell ${cls}` + (v ? '' : ' zero') }, v ? String(v) : '·');
    td.style.setProperty('--a', String(shade(v, max)));
    return td;
  };
  const cols = [...byStatus.cols.map((c) => ({ label: STATUS_JA[c], cls: `mx-st st-${c}` })), ...byPriority.cols.map((c) => ({ label: PRIORITY_JA[c], cls: `mx-pr pr-${c}` }))];
  return el('div', { class: 'scroll' }, el('table', { class: 'matrix' },
    el('thead', {},
      el('tr', {}, el('th', { rowspan: '2' }, '案件'), el('th', { colspan: String(OPEN_STATUSES.length), class: 'mx-group' }, '状態'), el('th', { colspan: String(PRIORITIES.length), class: 'mx-group' }, '優先度'), el('th', { rowspan: '2' }, '計')),
      el('tr', {}, ...cols.map((c) => el('th', { class: c.cls }, c.label)))),
    el('tbody', {}, ...ids.map((id, i) => el('tr', {},
      el('th', { scope: 'row' }, projLink(id)),
      ...byStatus.cells[i].map((v) => cell(v, byStatus.max, 'mx-st')),
      ...byPriority.cells[i].map((v, j) => cell(v, byPriority.max, `mx-pr pr-${PRIORITIES[j]}`)),
      el('td', { class: 'mx-total' }, String(byStatus.rowTotal[i]))))),
    el('tfoot', {}, el('tr', {}, el('th', {}, '計'),
      ...byStatus.colTotal.map((v) => el('td', { class: 'mx-total' }, String(v))),
      ...byPriority.colTotal.map((v) => el('td', { class: 'mx-total' }, String(v))),
      el('td', { class: 'mx-total' }, String(byStatus.total))))));
}

// ツリーマップ: 案件の大きさ = タスクの数（進行中・待ち + 完了）。中を状態と完了で分ける
function treemap(rows) {
  // 画面の幅に合わせて描く（縮めて表示すると、スマートフォンで文字が読めないほど小さくなるため）
  const W = Math.round(Math.min(960, Math.max(300, (document.documentElement.clientWidth || 960) - 32)));
  const H = W < 600 ? Math.round(W * 0.9) : 360, HEAD = 18;
  const outer = squarify(rows.map((r) => ({ key: r.project, value: r.total })), 0, 0, W, H);
  if (!outer.length) return el('p', { class: 'note' }, 'タスクがありません');
  const byId = new Map(rows.map((r) => [r.project, r]));
  const g = [];
  for (const o of outer) {
    const r = byId.get(o.key);
    const pad = 2;
    const showHead = o.h > HEAD * 2 && o.w > 48;
    const ix = o.x + pad, iy = o.y + pad + (showHead ? HEAD : 0), iw = Math.max(o.w - pad * 2, 0), ih = Math.max(o.h - pad * 2 - (showHead ? HEAD : 0), 0);
    const inner = squarify([...OPEN_STATUSES.map((s) => ({ key: s, value: r.counts[s] })), { key: 'done', value: r.done }], ix, iy, iw, ih);
    const tip = `${r.project}: 全 ${r.total} 件（` + [...OPEN_STATUSES.filter((s) => r.counts[s]).map((s) => `${STATUS_JA[s]} ${r.counts[s]}`), r.done ? `完了 ${r.done}` : ''].filter(Boolean).join('・') + '）';
    g.push(svg('g', { class: 'tm-node' },
      svg('title', {}, tip),
      svg('rect', { x: o.x.toFixed(1), y: o.y.toFixed(1), width: o.w.toFixed(1), height: o.h.toFixed(1), class: 'tm-outer' }),
      ...inner.map((i) => svg('rect', { x: (i.x + 0.5).toFixed(1), y: (i.y + 0.5).toFixed(1), width: Math.max(i.w - 1, 0).toFixed(1), height: Math.max(i.h - 1, 0).toFixed(1), class: i.key === 'done' ? 'tm-cell seg done' : `tm-cell seg st-${i.key}` })),
      showHead ? svg('text', { x: (o.x + 6).toFixed(1), y: (o.y + 14).toFixed(1), class: 'tm-label' }, `${r.project}（${r.total}）`) : null));
  }
  const legend = el('div', { class: 'legend' }, ...OPEN_STATUSES.map((s) => el('span', {}, el('i', { class: `key st-${s}` }), STATUS_JA[s])), el('span', {}, el('i', { class: 'key done' }), '完了'));
  return el('div', {}, legend, svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'treemap', role: 'img', 'aria-label': `案件ごとのタスクの数: ${rows.filter((r) => r.total).map((r) => `${r.project} ${r.total}`).join('、')}` }, ...g));
}

// ---- 未マージの PR（案件の「リポジトリ」の表にある GitHub のリポジトリの、開いている PR） ----
// リポジトリごとに API を 1 回。節を開いたときだけ読み、読み込みのたびに読み直す。マージは「状態・マージ」の画面で

let openPrsCache = null;     // { repos: [{ full, projects, prs: [...] | null（読めない） }] }
let openPrsLoading = null;

function renderOpenPrs({ tasks, projects }) {
  const box = $('openPrs');
  const repos = githubRepos([...projects.values()]);
  if (!repos.length) { box.replaceChildren(el('p', { class: 'note' }, '案件の「リポジトリ」の表に、GitHub のリポジトリがありません')); return; }
  const details = document.querySelector('details[data-fold=prs]');
  const start = () => {
    if (openPrsCache) { drawOpenPrs(box, tasks, projects); return; }
    box.replaceChildren(el('p', { class: 'note' }, `${repos.length} のリポジトリを読んでいます…`));
    openPrsLoading ||= fetchOpenPrs(repos).then((r) => { openPrsCache = r; }).finally(() => { openPrsLoading = null; });
    openPrsLoading.then(() => { if (box.isConnected) drawOpenPrs(box, tasks, projects); }, (e) => box.replaceChildren(el('p', { class: 'status error' }, `読めませんでした（${e.message || e}）`)));
  };
  if (details && details.open) start();
  else {
    box.replaceChildren(el('p', { class: 'note' }, '節を開くと読みます'));
    if (details) details.addEventListener('toggle', function once() { if (details.open) { details.removeEventListener('toggle', once); start(); } });
  }
}

async function fetchOpenPrs(repos) {
  const out = await mapLimit(repos, 4, async (r) => {
    const res = await gh(ctx.token, `/repos/${r.owner}/${encodeURIComponent(r.repo)}/pulls?state=open&per_page=50&sort=updated&direction=desc`, { allow404: true });
    // 開いている PR があるリポジトリだけ、アカウントの書き込みの権限も読む（無ければ、ここからはマージできない）
    let canPush;
    if (res.body && res.body.length) {
      const info = await gh(ctx.token, `/repos/${r.owner}/${encodeURIComponent(r.repo)}`, { allow404: true });
      if (info.body && info.body.permissions) canPush = !!info.body.permissions.push;
    }
    return { ...r, prs: res.body ? res.body : null, status: res.status, canPush };
  });
  return { repos: out };
}

function drawOpenPrs(box, tasks, projects) {
  const prsOf = (t) => findPullRequests(t.refsText, (projects.get(t.project) || {}).repos || []).map((x) => x.url);
  const rows = [];
  for (const r of openPrsCache.repos) for (const p of r.prs || []) rows.push({ r, p });
  rows.sort((a, b) => String(b.p.updated_at).localeCompare(String(a.p.updated_at)));
  const unreadable = openPrsCache.repos.filter((r) => !r.prs);
  const reload = el('button', { type: 'button', class: 'mini' }, '読み直す');
  reload.addEventListener('click', () => { openPrsCache = null; renderOpenPrs({ tasks, projects }); });
  const noPush = openPrsCache.repos.filter((r) => r.canPush === false && r.prs && r.prs.length).map((r) => r.full);
  const head = el('p', { class: 'sub' }, `${openPrsCache.repos.length - unreadable.length} のリポジトリに、開いている PR が ${rows.length} 件`, ' ', reload);
  const pushNote = noPush.length ? el('p', { class: 'sub warn-text' }, `${ctx.login} が書き込めないリポジトリ（ここからはマージできない。トークンではなくアカウントの権限）: ${noPush.join('、')}。「開く」「URL」から、書き込めるアカウントで GitHub を開いてください`) : null;
  const table = rows.length ? el('div', { class: 'scroll' }, el('table', { class: 'open-prs' },
    el('thead', {}, el('tr', {}, ...['リポジトリ', 'PR', '作成', 'ブランチ', '更新', 'タスク', '操作'].map((h) => el('th', {}, h)))),
    el('tbody', {}, ...rows.map(({ r, p }) => {
      const url = `https://github.com/${r.owner}/${r.repo}/pull/${Number(p.number)}`;
      const t = taskForPr(tasks, url, prsOf);
      const x = { url, label: `${r.repo}#${Number(p.number)}` };
      const btn = el('button', { type: 'button', class: 'mini', 'aria-label': `${x.label} の状態を見る` }, '状態・マージ');
      btn.addEventListener('click', () => openMerge(t, x));
      return el('tr', {},
        el('td', {}, link(`https://github.com/${r.owner}/${r.repo}`, r.full), el('div', { class: 'sub' }, r.projects.join('・'))),
        el('td', {}, link(url, `#${Number(p.number)} ${p.title || ''}`), p.draft ? el('span', { class: 'badge st-draft' }, '下書き') : null),
        el('td', {}, p.user && p.user.login ? link(`https://github.com/${encodeURIComponent(p.user.login)}`, p.user.login) : ''),
        el('td', { class: 'sub' }, `${p.base ? p.base.ref : '?'} ← ${p.head ? p.head.ref : '?'}`),
        el('td', {}, ageText(p.updated_at)),
        el('td', {}, t ? link(blobUrl(view.branch, t.path), t.id) : el('span', { class: 'sub' }, '—')),
        el('td', {}, el('span', { class: 'pr-actions' }, btn, prPageButtons(x, true)),
          r.canPush === false ? el('div', { class: 'sub warn-text', title: `${ctx.login} はこのリポジトリに書き込めないので、ここからはマージできません（アカウントの権限）。「開く」「URL」から、書き込めるアカウントで GitHub で開いてください` }, `${ctx.login} は書き込めない`) : null));
    })))) : el('p', { class: 'note' }, '開いている PR はありません');
  const note = unreadable.length ? el('p', { class: 'sub' }, `読めないリポジトリ（トークンの対象に入っていない・権限が無い）: ${unreadable.map((r) => `${r.full}（${r.status}）`).join('、')}`) : null;
  box.replaceChildren(...[head, pushNote, table, note].filter(Boolean));
}

function editButton(t) {
  const unanswered = t.questions.filter((q) => !q.answer).length;
  const b = el('button', { type: 'button', class: 'mini' + (unanswered ? ' primary' : '') }, unanswered ? `回答する（${unanswered}）` : '書き換える');
  b.addEventListener('click', () => openEditor(t));
  return b;
}

// ---- PR のマージ（GitHub の PR だけ） ----

function mergeButton(t, x) {
  const b = el('button', { type: 'button', class: 'mini', title: `${x.label} の状態を見て、マージする`, 'aria-label': `${x.label} の状態を見る` }, '状態・マージ');
  b.addEventListener('click', () => openMerge(t, x));
  return el('span', { class: 'pr-actions' }, b, prPageButtons(x, true));
}

// PR のページを GitHub で開くボタンと、URL を写すボタン（このページのトークンのアカウントでマージできないとき、
// 別の端末・別のアカウントで開くため）。compact は表の中の小さな形
function prPageButtons(x, compact = false) {
  const open = el('a', { href: x.url, class: 'btn-link' + (compact ? ' mini' : ''), title: `${x.label} を GitHub で開く（新しいタブ）` }, compact ? '開く' : 'GitHub で開く');
  const copy = el('button', { type: 'button', class: compact ? 'mini' : '', title: `${x.label} の URL を写す（別の端末で開くため）` }, compact ? 'URL' : 'URL を写す');
  copy.addEventListener('click', async () => {
    const label = copy.textContent;
    let ok = false;
    try { await navigator.clipboard.writeText(x.url); ok = true; } catch { }
    if (!ok) {
      // クリップボードが使えない環境（http・権限なし）では、URL を選んだ状態で見せる
      window.prompt('URL を写してください', x.url);
      return;
    }
    copy.textContent = '写しました';
    setTimeout(() => { copy.textContent = label; }, 1500);
  });
  return el('span', { class: 'pr-page' }, open, copy);
}

// PR の状態・検査を読み、確認のあとマージする。マージしたら、タスクのログに 1 行（1 コミット）
async function openMerge(t, x) {
  if (!ctx || busy) return;
  const pr = parsePrUrl(x.url);
  if (!pr) return;
  const dlg = $('dialog');
  const msg = el('p', { class: 'status', role: 'status' }, '読んでいます…');
  const cancel = el('button', { type: 'button' }, '閉じる');
  cancel.addEventListener('click', () => dlg.close());
  dlg.replaceChildren(el('h2', {}, `PR: ${x.label}`), msg, el('div', { class: 'dlg-actions' }, cancel));
  if (!dlg.open) dlg.showModal();
  const api = `/repos/${pr.owner}/${pr.repo}`;
  let info;
  let checks = null;
  let canPush;   // アカウント（トークンの持ち主）に、このリポジトリへの書き込みの権限があるか（読めなければ undefined）
  try {
    const [pull, repoInfo] = await Promise.all([
      gh(ctx.token, `${api}/pulls/${pr.number}`),
      gh(ctx.token, api, { allow404: true }),
    ]);
    info = pull.body;
    if (repoInfo.body && repoInfo.body.permissions) canPush = !!repoInfo.body.permissions.push;
    if (!info.merged && info.head && info.head.sha) {
      const sha = info.head.sha;
      const [runs, status] = await Promise.all([
        gh(ctx.token, `${api}/commits/${sha}/check-runs?per_page=100`, { allow404: true }).then((r) => (r.body ? r.body.check_runs : null)),
        gh(ctx.token, `${api}/commits/${sha}/status`, { allow404: true }).then((r) => r.body),
      ]);
      checks = runs || status ? summarizeChecks(runs, status) : null;
    }
  } catch (e) {
    msg.className = 'status error';
    msg.textContent = e.status === 404 || e.status === 403
      ? `${pr.owner}/${pr.repo} の PR を読めません（${e.status}）。トークンの対象リポジトリに ${pr.owner}/${pr.repo} を入れ、Pull requests の権限を付けてください`
      : (e.message || String(e));
    dlg.replaceChildren(el('h2', {}, `PR: ${x.label}`), msg, el('div', { class: 'dlg-actions' }, cancel, prPageButtons(x)));
    return;
  }
  const v = mergeVerdict(info, checks, { canPush, login: ctx.login, repo: `${pr.owner}/${pr.repo}` });
  const CHECK_JA = { success: '成功', failure: '失敗あり', pending: '終わっていない', none: '検査なし（または読めない）' };
  const facts = el('dl', { class: 'facts' },
    el('dt', {}, '件名'), el('dd', {}, link(x.url, info.title || x.label)),
    el('dt', {}, '状態'), el('dd', {}, info.merged ? `マージ済み（${info.merged_at || ''}）` : info.state === 'open' ? (info.draft ? '開いている（下書き）' : '開いている') : '閉じている'),
    el('dt', {}, 'ブランチ'), el('dd', {}, `${info.base ? info.base.ref : '?'} ← ${info.head ? info.head.ref : '?'}`),
    el('dt', {}, 'マージできるか'), el('dd', {}, `${info.mergeable === true ? 'できる' : info.mergeable === false ? 'できない' : '計算中'}（${info.mergeable_state || '?'}）`),
    el('dt', {}, '検査'), el('dd', {}, checks ? `${CHECK_JA[checks.state]}（成功 ${checks.success}・失敗 ${checks.failure}・途中 ${checks.pending}）` : CHECK_JA.none),
    el('dt', {}, '変更'), el('dd', {}, `${info.changed_files ?? '?'} ファイル・+${info.additions ?? '?'} / -${info.deletions ?? '?'}・コミット ${info.commits ?? '?'}`));
  msg.className = 'status' + (v.ok ? '' : ' error');
  msg.textContent = v.ok ? 'マージできます。方法を選んで「マージする」を押すと、すぐにマージします（取り消せません）' : v.reasons.join(' / ');
  const method = el('select', { name: 'method' }, ...MERGE_METHODS.map((m) => el('option', { value: m }, { merge: 'マージコミット（merge）', squash: 'まとめる（squash）', rebase: '付け替え（rebase）' }[m])));
  const go = el('button', { type: 'button', class: 'primary' }, 'マージする');
  go.disabled = !v.ok;
  go.addEventListener('click', async () => {
    if (busy) return;
    busy = true; go.disabled = true; cancel.disabled = true;
    msg.className = 'status'; msg.textContent = 'マージしています…';
    let merged;
    try {
      // head の sha を付ける: 見た後に push が入っていたら、GitHub が断る（409）
      merged = (await gh(ctx.token, `${api}/pulls/${pr.number}/merge`, { method: 'PUT', body: { sha: info.head.sha, merge_method: method.value } })).body;
    } catch (e) {
      busy = false; cancel.disabled = false;
      msg.className = 'status error';
      msg.textContent = e.status === 409 ? '見た後に PR の内容が変わりました。閉じて開き直してください'
        : e.status === 405 ? `マージできませんでした（405${e.detail ? `: ${e.detail}` : ''}）`
          : e.status === 403 || e.status === 404
            ? (canPush === false
              ? `マージできません（${e.status}）。${ctx.login} は ${pr.owner}/${pr.repo} に書き込めません（アカウントの権限。トークンでは足せません）。「GitHub で開く」から、書き込めるアカウントでマージしてください`
              : `マージできません（${e.status}）。${ctx.login} のアカウントには書き込みの権限がありますが、トークンで断られました。トークンの対象リポジトリに ${pr.owner}/${pr.repo} を入れ、Contents: Read and write を付けてください（組織の承認待ちのトークンも断られます）`)
            : (e.message || String(e));
      return;
    }
    // タスクのログに残す（書き込みの権限があるときだけ）
    let logNote = '';
    if (!t) logNote = '関係するタスクが無いので、タスクのログには書いていません';
    else if (ctx.canWrite) {
      const before = ctx.texts.get(t.path);
      const after = applyTaskEdits(before, { log: `PR ${x.url} をマージ（${method.value}、${String(merged.sha || '').slice(0, 7)}）` }, { who: WHO() }).text;
      try { await commitChanges([{ path: t.path, content: after }], commitMessage(ctx.login, 'PR のマージを記録', [t.id])); logNote = 'タスクのログに記録しました'; }
      catch (e) { logNote = `タスクのログには書けませんでした（${e.message}）。手で記録してください`; }
    } else logNote = '書き込みの権限が無いので、タスクのログには書いていません';
    busy = false; cancel.disabled = false;
    msg.className = 'status ok';
    msg.textContent = `マージしました（${String(merged.sha || '').slice(0, 7)}）。${logNote}`;
    go.remove();
    method.remove();
    openPrsCache = null;   // 未マージの PR の一覧も読み直す
    load(ctx.token).catch(showError);
  });
  dlg.replaceChildren(el('h2', {}, `PR: ${x.label}`), el('div', { class: 'dlg-body' }, facts,
    el('p', { class: 'sub' }, t
      ? `タスク ${t.id} から。マージの後、エージェントがそのタスクを再開するときに確かめます（このページは finish をしません）`
      : '関係するタスクが見つかりません（タスクの成果物に、この PR の URL が書かれていない）。マージしてもタスクのログには残りません')),
  msg, el('div', { class: 'dlg-actions' }, cancel, info.merged || info.state !== 'open' ? null : method, info.merged || info.state !== 'open' ? null : go, prPageButtons(x)));
}

function showError(e) {
  let msg = e.message || String(e);
  if (e.status === 401) msg = 'トークンが無効か、期限が切れています（401）。作り直して入れ直してください';
  else if (e.status === 404 || e.status === 403) msg = `${CONFIG.owner}/${CONFIG.repo} を読めません（${e.status}）。トークンの対象リポジトリと Contents の権限を確かめてください`;
  setStatus(msg, 'error');
  $('main').hidden = true;
  $('newRequestBtn').hidden = true;
  $('tokenBox').open = true;
}

// 折りたためる節の開閉を、このブラウザに覚えさせる
function restoreFolds() {
  const folds = prefs.get('folds') || {};
  for (const d of document.querySelectorAll('details.fold[data-fold]')) {
    const k = d.dataset.fold;
    if (typeof folds[k] === 'boolean') d.open = folds[k];
    d.addEventListener('toggle', () => prefs.set('folds', { ...(prefs.get('folds') || {}), [k]: d.open }));
  }
}

function init() {
  $('repoName').replaceChildren(link(`https://github.com/${CONFIG.owner}/${CONFIG.repo}`, `${CONFIG.owner}/${CONFIG.repo}`));
  $('orgName').replaceChildren(link(`https://github.com/${CONFIG.org}`, CONFIG.org));
  const form = $('tokenForm');
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const token = $('token').value.trim();
    if (!token) return;
    saveToken(token, $('remember').checked);
    $('token').value = '';
    load(token).catch(showError);
  });
  $('reload').addEventListener('click', () => { const t = loadToken(); if (t) load(t).catch(showError); else setStatus('トークンを入れてください'); });
  $('forget').addEventListener('click', () => { clearToken(); ctx = null; if ($('dialog').open) $('dialog').close(); $('main').hidden = true; $('newRequestBtn').hidden = true; setStatus('トークンを消しました'); });
  $('newRequestBtn').addEventListener('click', openNewRequest);
  restoreFolds();
  const t = loadToken();
  if (t) load(t).catch(showError);
  else { setStatus('トークンを入れてください（右上の「トークン」）'); $('tokenBox').open = true; }
}
init();
