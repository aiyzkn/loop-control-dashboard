// loop-control ダッシュボード（参照だけ）。
// ブラウザから GitHub の API（https://api.github.com）を、利用者の fine-grained の個人用トークンで読む。
// このページ（公開）には、データを置かない。読めるかどうかは、トークンの権限（非公開の loop-control を読めるか）で決まる。
import { parseTask, sortTasks, parseInbox, pickFiles, ageText, isOrgMember } from './parse.js';

const CONFIG = {
  org: 'aiyzkn',                 // 所属を確かめる組織
  owner: 'aiyzkn',               // 指令リポジトリ
  repo: 'loop-control',
  api: 'https://api.github.com',
};
const KEY = 'loop-control-dashboard.token';

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'href') { e.href = v; e.rel = 'noopener noreferrer'; e.target = '_blank'; }
    else e.setAttribute(k, v);
  }
  for (const c of children) e.append(c instanceof Node ? c : document.createTextNode(c == null ? '' : String(c)));
  return e;
};

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

async function gh(token, path, { raw = false, allow404 = false } = {}) {
  const res = await fetch(CONFIG.api + path, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    cache: 'no-store',
  });
  if (allow404 && (res.status === 404 || res.status === 403)) return { status: res.status, body: null };
  if (!res.ok) {
    const err = new Error(`GitHub API ${res.status}: ${path}`);
    err.status = res.status;
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
  const tree = (await gh(token, `/repos/${CONFIG.owner}/${CONFIG.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`)).body;
  const files = pickFiles(tree.tree || []);
  const read = (p) => gh(token, `/repos/${CONFIG.owner}/${CONFIG.repo}/contents/${p.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`, { raw: true }).then((r) => r.body);
  const [taskTexts, pcTexts, inboxText] = await Promise.all([
    mapLimit(files.tasks, 6, read),
    mapLimit(files.pcs, 6, read),
    files.inbox ? read(files.inbox) : Promise.resolve(''),
  ]);
  const tasks = sortTasks(files.tasks.map((p, i) => parseTask(p, taskTexts[i])));
  const pcs = pcTexts.map((t, i) => { try { return JSON.parse(t); } catch { return { agentId: files.pcs[i], error: '読めない' }; } });
  const inbox = parseInbox(inboxText);
  render({ me, branch, tasks, pcs, inbox, truncated: tree.truncated });
  setStatus(`${me.login} として表示しています（${new Date().toLocaleString()} 時点。自動では更新しません）`, 'ok');
}

const STATUS_JA = { doing: '作業中', waiting: '判断待ち', blocked: '止まっている', ready: '着手待ち', draft: '下書き' };
const PRIORITY_JA = { urgent: '緊急', high: '高', normal: '普通', low: '低' };
const DECISION_JA = { 'kick-work': '起こした（作業）', 'kick-idle': '起こした（手が空いたとき）', skip: '見送り', error: '失敗' };

function blobUrl(branch, path) {
  return `https://github.com/${CONFIG.owner}/${CONFIG.repo}/blob/${encodeURIComponent(branch)}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

function render({ branch, tasks, pcs, inbox, truncated }) {
  const open = tasks.filter((t) => ['doing', 'waiting', 'blocked', 'ready', 'draft'].includes(t.status));
  // まとめ
  const counts = {};
  for (const t of open) counts[t.status] = (counts[t.status] || 0) + 1;
  const urgent = open.filter((t) => t.priority === 'urgent' && t.status !== 'draft').length + inbox.urgent;
  const summary = $('summary');
  summary.replaceChildren(
    ...[['作業中', counts.doing || 0], ['判断待ち', counts.waiting || 0], ['止まっている', counts.blocked || 0], ['着手待ち', counts.ready || 0], ['受付の未整理', inbox.items.length], ['緊急', urgent]]
      .map(([k, v]) => el('div', { class: 'card' + (k === '緊急' && v ? ' alert' : '') }, el('div', { class: 'num' }, v), el('div', { class: 'label' }, k))),
  );
  if (truncated) summary.append(el('p', { class: 'note' }, '※ ファイルが多く、一覧の一部しか読めませんでした'));

  // PC
  const pcBody = $('pcs');
  if (pcs.length === 0) {
    pcBody.replaceChildren(el('p', { class: 'note' }, 'PC の状況はまだありません（自動起動 kick.ps1 を有効にした PC が state/pcs/ に書きます）'));
  } else {
    const rows = pcs.sort((a, b) => String(a.agentId).localeCompare(String(b.agentId))).map((p) => {
      const s = p.sessions || {};
      const sess = p.sessions ? `動いている ${s.working ?? 0} / 入力待ち ${s['waiting-input'] ?? 0} / 上限 ${s.limit ?? 0} / 指示なし ${s.empty ?? 0} / 古い ${s.stale ?? 0}` : '—';
      const stale = Date.now() - Date.parse(p.updatedAt) > 3 * 3600 * 1000;
      return el('tr', {},
        el('td', {}, p.agentId || '', el('div', { class: 'sub' }, p.pc || '')),
        el('td', { class: stale ? 'warn' : '' }, ageText(p.updatedAt), el('div', { class: 'sub' }, p.updatedAt || '')),
        el('td', {}, DECISION_JA[p.decision] || p.decision || '', el('div', { class: 'sub' }, p.reason || '')),
        el('td', {}, sess),
        el('td', {}, p.nextWakeAt ? `${ageText(p.nextWakeAt)}（${p.nextWakeAt}）` : '—'),
        el('td', {}, p.weeklyNextAt ? `${ageText(p.weeklyNextAt)}（${p.weeklyNextAt}）` : '—'),
        el('td', {}, p.lastLaunchedAt ? `${ageText(p.lastLaunchedAt)}（${p.lastKind || ''}）` : '—'),
      );
    });
    pcBody.replaceChildren(el('table', {},
      el('thead', {}, el('tr', {}, ...['エージェント / PC', '最後の確認', '判断', 'セッション', '次の復帰（上限の解除）', '次の週次の起動', '前に起こした'].map((h) => el('th', {}, h)))),
      el('tbody', {}, ...rows)));
  }

  // タスク
  const taskBody = $('tasks');
  if (open.length === 0) taskBody.replaceChildren(el('p', { class: 'note' }, '進行中・待ちのタスクはありません'));
  else {
    taskBody.replaceChildren(el('table', {},
      el('thead', {}, el('tr', {}, ...['状態', '優先', '案件', 'タスク', '段階', '担当', '現在地'].map((h) => el('th', {}, h)))),
      el('tbody', {}, ...open.map((t) => el('tr', { class: 'st-' + t.status },
        el('td', {}, STATUS_JA[t.status] || t.status),
        el('td', { class: 'pr-' + t.priority }, PRIORITY_JA[t.priority] || t.priority),
        el('td', {}, t.project),
        el('td', {}, el('a', { href: blobUrl(branch, t.path) }, t.title || t.id), el('div', { class: 'sub' }, t.id)),
        el('td', {}, t.stage),
        el('td', {}, t.claimedBy || t.assignee, el('div', { class: 'sub' }, t.heartbeatAt ? '印 ' + ageText(t.heartbeatAt) : '')),
        el('td', {}, t.progress, el('div', { class: 'sub' }, t.next ? '次: ' + t.next : ''))))),
    ));
  }

  // 受付と、手が空いた時の定義
  const ib = $('inbox');
  ib.replaceChildren(
    el('h3', {}, `受付の未整理 ${inbox.items.length} 件`),
    inbox.items.length ? el('ul', {}, ...inbox.items.map((i) => el('li', {}, (i.urgent ? '【緊急】' : '') + i.heading))) : el('p', { class: 'note' }, 'ありません'),
    el('h3', {}, `手が空いた時に実行するタスク ${inbox.idle.length} 件`),
    inbox.idle.length ? el('ul', {}, ...inbox.idle.map((d) => el('li', {}, `${d.project}: ${d.title}`, el('span', { class: 'sub' }, `（${d.stage === 'implement' ? '実装まで' : '提案だけ'}・${d.interval || '週 1 回'}・最終実施 ${d.last || 'なし'}）`)))) : el('p', { class: 'note' }, 'ありません'),
    el('p', {}, el('a', { href: blobUrl(branch, 'inbox.md') }, 'inbox.md を GitHub で開く')),
  );
  $('main').hidden = false;
}

function showError(e) {
  let msg = e.message || String(e);
  if (e.status === 401) msg = 'トークンが無効か、期限が切れています（401）。作り直して入れ直してください';
  else if (e.status === 404 || e.status === 403) msg = `${CONFIG.owner}/${CONFIG.repo} を読めません（${e.status}）。トークンの対象リポジトリと Contents: Read の権限を確かめてください`;
  setStatus(msg, 'error');
  $('main').hidden = true;
}

function init() {
  $('repoName').textContent = `${CONFIG.owner}/${CONFIG.repo}`;
  $('orgName').textContent = CONFIG.org;
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
  $('forget').addEventListener('click', () => { clearToken(); $('main').hidden = true; setStatus('トークンを消しました'); });
  const t = loadToken();
  if (t) load(t).catch(showError);
  else setStatus('トークンを入れてください');
}
init();
