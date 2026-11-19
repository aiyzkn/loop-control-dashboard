// loop-control ダッシュボード（参照だけ）。
// ブラウザから GitHub の API（https://api.github.com）を、利用者の fine-grained の個人用トークンで読む。
// このページ（公開）には、データを置かない。読めるかどうかは、トークンの権限（非公開の loop-control を読めるか）で決まる。
// 表示はすべて textContent と、組み立てた href（github.com / gitlab.com と、このリポジトリの blob だけ）で入れる。
import {
  parseTask, sortTasks, parseInbox, pickFiles, ageText, isOrgMember,
  parseProject, parseRoster, findPullRequests, taskSignal, pcSignal, overallSignal,
  countByProject, countByDay, doneRatio,
} from './parse.js';

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
  const entries = tree.tree || [];
  const files = pickFiles(entries);
  const read = (p) => gh(token, `/repos/${CONFIG.owner}/${CONFIG.repo}/contents/${p.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`, { raw: true }).then((r) => r.body);
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
  render({
    branch, tasks, pcs, inbox, projects, roster,
    archivedCount: files.archived.length,
    paths: entries.filter((e) => e.type === 'blob').map((e) => e.path),
    files, truncated: tree.truncated,
  });
  setStatus(`${me.login} として表示しています（${new Date().toLocaleString()} 時点。自動では更新しません）`, 'ok');
}

const STATUS_JA = { doing: '作業中', waiting: '判断待ち', blocked: '止まっている', ready: '着手待ち', draft: '下書き' };
const OPEN = ['doing', 'waiting', 'blocked', 'ready', 'draft'];
const PRIORITY_JA = { urgent: '緊急', high: '高', normal: '普通', low: '低' };
const DECISION_JA = { 'kick-work': '起こした（作業）', 'kick-idle': '起こした（手が空いたとき）', skip: '見送り', error: '失敗' };
const SIGNAL_JA = { red: '赤（止まっている・失敗）', yellow: '黄（判断待ち・注意）', green: '緑（進んでいる）', off: '消灯（動きなし）' };

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
      el('tbody', {}, ...rows)));
  }

  // タスク
  const taskBody = $('tasks');
  if (open.length === 0) taskBody.replaceChildren(el('p', { class: 'note' }, '進行中・待ちのタスクはありません'));
  else {
    taskBody.replaceChildren(el('table', {},
      el('thead', {}, el('tr', {}, ...['信号', '状態', '優先', '案件', 'タスク', '段階', '担当', 'PR / MR', '現在地'].map((h) => el('th', {}, h)))),
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
          el('td', {}, prs.length ? el('ul', { class: 'prs' }, ...prs.map((x) => el('li', {}, link(x.url, x.label)))) : el('span', { class: 'sub' }, '—')),
          el('td', {}, t.progress, el('div', { class: 'sub' }, t.next ? '次: ' + t.next : '')));
      })),
    ));
  }

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

function showError(e) {
  let msg = e.message || String(e);
  if (e.status === 401) msg = 'トークンが無効か、期限が切れています（401）。作り直して入れ直してください';
  else if (e.status === 404 || e.status === 403) msg = `${CONFIG.owner}/${CONFIG.repo} を読めません（${e.status}）。トークンの対象リポジトリと Contents: Read の権限を確かめてください`;
  setStatus(msg, 'error');
  $('main').hidden = true;
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
  $('forget').addEventListener('click', () => { clearToken(); $('main').hidden = true; setStatus('トークンを消しました'); });
  const t = loadToken();
  if (t) load(t).catch(showError);
  else setStatus('トークンを入れてください');
}
init();
