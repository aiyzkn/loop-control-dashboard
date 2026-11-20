// 見栄えのための部品（カード・マトリックス・ツリーマップ）の、純粋な計算（ブラウザでも Node.js の試験でも使う）。
// 描くのは app.js（SVG と DOM）。ここは数と配置だけを返す。

export const OPEN_STATUSES = ['doing', 'waiting', 'blocked', 'ready', 'draft'];

// 案件ごとのまとめ（カード・ツリーマップ・マトリックスの元）。
// openTasks = 進行中・待ちのタスク（parseTask の形）、archivedPaths = projects/<案件>/archive/*.md の一覧、projectIds = 案件の名前
export function projectSummary(openTasks, archivedPaths = [], projectIds = []) {
  const map = new Map();
  const get = (p) => {
    if (!map.has(p)) map.set(p, { project: p, counts: Object.fromEntries(OPEN_STATUSES.map((s) => [s, 0])), open: 0, done: 0, high: 0, latest: '' });
    return map.get(p);
  };
  for (const p of projectIds) get(p);
  for (const t of openTasks) {
    if (!OPEN_STATUSES.includes(t.status)) continue;
    const r = get(t.project);
    r.counts[t.status]++;
    r.open++;
    if (t.priority === 'urgent' || t.priority === 'high') r.high++;
    const u = t.updated || t.created || '';
    if (u > r.latest) r.latest = u;
  }
  for (const path of archivedPaths) {
    const m = /^projects\/([^/]+)\/archive\/[^/]+\.md$/.exec(path);
    if (m) get(m[1]).done++;
  }
  return [...map.values()]
    .map((r) => ({ ...r, total: r.open + r.done }))
    .sort((a, b) => b.open - a.open || b.total - a.total || a.project.localeCompare(b.project));
}

// マトリックス（行 × 列の件数と合計）。rows = 行の名前の並び、cols = 列の名前の並び、
// pick(t) = [行, 列]。返すのは { rows, cols, cells[行][列], rowTotal, colTotal, total, max }
export function matrix(tasks, rows, cols, pick) {
  const cells = rows.map(() => cols.map(() => 0));
  const ri = new Map(rows.map((r, i) => [r, i]));
  const ci = new Map(cols.map((c, i) => [c, i]));
  for (const t of tasks) {
    const [r, c] = pick(t);
    if (!ri.has(r) || !ci.has(c)) continue;
    cells[ri.get(r)][ci.get(c)]++;
  }
  const rowTotal = cells.map((row) => row.reduce((a, b) => a + b, 0));
  const colTotal = cols.map((_, j) => cells.reduce((a, row) => a + row[j], 0));
  return { rows, cols, cells, rowTotal, colTotal, total: rowTotal.reduce((a, b) => a + b, 0), max: Math.max(0, ...cells.flat()) };
}

// 濃さ（0〜1）。0 件は 0、1 件以上は 0.15〜1 に広げる（少ない件数も見えるように）
export function shade(value, max) {
  if (!value || !max) return 0;
  return Math.round((0.15 + 0.85 * (value / max)) * 100) / 100;
}

// ツリーマップの配置（squarified。Bruls ほか 2000）。items = [{ key, value }]（value > 0 だけを使う）。
// 返すのは [{ key, value, x, y, w, h }]（入力の大きい順）。面積は value に比例する
export function squarify(items, x, y, w, h) {
  const list = items.filter((i) => i.value > 0).sort((a, b) => b.value - a.value || String(a.key).localeCompare(String(b.key)));
  const sum = list.reduce((a, i) => a + i.value, 0);
  if (!sum || w <= 0 || h <= 0) return [];
  const scale = (w * h) / sum;
  const areas = list.map((i) => ({ ...i, area: i.value * scale }));
  const out = [];
  let rect = { x, y, w, h };
  let row = [];
  const worst = (r, side) => {
    const s = r.reduce((a, i) => a + i.area, 0);
    const mx = Math.max(...r.map((i) => i.area));
    const mn = Math.min(...r.map((i) => i.area));
    return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
  };
  const layout = (r) => {
    const s = r.reduce((a, i) => a + i.area, 0);
    if (rect.w >= rect.h) {
      const cw = s / rect.h;
      let cy = rect.y;
      for (const i of r) { const ch = i.area / cw; out.push({ key: i.key, value: i.value, x: rect.x, y: cy, w: cw, h: ch }); cy += ch; }
      rect = { x: rect.x + cw, y: rect.y, w: rect.w - cw, h: rect.h };
    } else {
      const ch = s / rect.w;
      let cx = rect.x;
      for (const i of r) { const cw = i.area / ch; out.push({ key: i.key, value: i.value, x: cx, y: rect.y, w: cw, h: ch }); cx += cw; }
      rect = { x: rect.x, y: rect.y + ch, w: rect.w, h: rect.h - ch };
    }
  };
  for (const item of areas) {
    const side = Math.min(rect.w, rect.h);
    if (!row.length || worst([...row, item], side) <= worst(row, side)) row.push(item);
    else { layout(row); row = [item]; }
  }
  if (row.length) layout(row);
  return out;
}

// ---- 時間の軸（ガントチャート・リボンチャート） ----

const DAY = 24 * 3600 * 1000;
const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

// 直近 days 日の窓（今日を含む。ローカルの日付の 0 時から）。{ from, to, days: ['YYYYMMDD', …] }
export function dayWindow(days, now = Date.now()) {
  const today = new Date(now);
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1));
  const list = [];
  for (let i = 0; i < days; i++) list.push(ymd(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)));
  return { from: start.getTime(), to: now, days: list };
}

// ガントチャートの行。tasks = parseTask の形（完了したものは archived: true・status: done など）。
// 始まり = created、終わり = 完了したものは updated、進行中は now。窓（from〜to）に掛からないものは除く。
// x0・x1 は窓の中の位置（0〜1）。clipped は始まりが窓より前。並びは 進行中が先 → 始まりの古い順
export function ganttRows(tasks, from, to) {
  const span = Math.max(to - from, 1);
  const rows = [];
  for (const t of tasks) {
    const s = Date.parse(t.created);
    if (Number.isNaN(s)) continue;
    const doneLike = t.archived || t.status === 'done' || t.status === 'dropped';
    let e = doneLike ? Date.parse(t.updated) : to;
    if (Number.isNaN(e) || e < s) e = s;
    if (e < from || s > to) continue;
    const hb = Date.parse(t.heartbeatAt);
    rows.push({
      id: t.id, title: t.title, project: t.project, status: doneLike ? (t.status === 'dropped' ? 'dropped' : 'done') : t.status,
      start: s, end: e, done: doneLike,
      x0: Math.max(0, (s - from) / span), x1: Math.min(1, (e - from) / span), clipped: s < from,
      hb: !doneLike && !Number.isNaN(hb) && hb >= from && hb <= to ? (hb - from) / span : null,
    });
  }
  return rows.sort((a, b) => Number(a.done) - Number(b.done) || a.start - b.start || String(a.id).localeCompare(String(b.id)));
}

// 案件ごと・日ごとの起票の数（タスク ID の日付で数える。tasks と archive）。{ projects: [...], days, values: { 案件: [日ごとの数] } }
export function createdSeries(treePaths, days) {
  const idx = new Map(days.map((d, i) => [d, i]));
  const values = {};
  for (const p of treePaths) {
    const m = /^projects\/([^/]+)\/(?:tasks|archive)\/(\d{8})-[^/]+\.md$/.exec(p);
    if (!m || !idx.has(m[2])) continue;
    (values[m[1]] ||= days.map(() => 0))[idx.get(m[2])]++;
  }
  const projects = Object.keys(values).sort((a, b) => values[b].reduce((x, y) => x + y, 0) - values[a].reduce((x, y) => x + y, 0) || a.localeCompare(b));
  return { projects, days, values };
}

// リボンチャートの配置。期間ごとに、値の大きい順に上から積む（順位が入れ替わると、帯が交差する）。
// 返すのは { columns: [{ total, segs: [{ project, value, y0, y1, rank }] }], max }。y は 0〜1（期間の最大の合計で割る）
export function ribbonLayout(series) {
  const n = series.days.length;
  const totals = [];
  const columns = [];
  for (let i = 0; i < n; i++) {
    const vals = series.projects.map((p) => ({ project: p, value: series.values[p][i] })).filter((v) => v.value > 0)
      .sort((a, b) => b.value - a.value || series.projects.indexOf(a.project) - series.projects.indexOf(b.project));
    totals.push(vals.reduce((a, v) => a + v.value, 0));
    columns.push(vals);
  }
  const max = Math.max(1, ...totals);
  return {
    max,
    columns: columns.map((vals, i) => {
      let y = 0;
      return { total: totals[i], segs: vals.map((v, rank) => { const y0 = y; y += v.value / max; return { ...v, y0, y1: y, rank }; }) };
    }),
  };
}

// 累計にする（リボンチャート用。日ごとの数は飛び飛びで、隣の期間に帯がつながらないため）
export function cumulative(series) {
  const values = {};
  for (const p of series.projects) { let a = 0; values[p] = series.values[p].map((v) => (a += v)); }
  return { ...series, values };
}

// ---- GitHub の芝（貢献のカレンダー） ----

// GraphQL の contributionCalendar.weeks を、日の並び [{ date, count }] にする
export function calendarDays(weeks) {
  return (weeks || []).flatMap((w) => (w.contributionDays || []).map((d) => ({ date: d.date, count: d.contributionCount || 0 })));
}

// 複数の日の並びを、日付ごとに足す（組織の行 = メンバーの組織内の貢献の合計）
export function sumDays(lists) {
  const map = new Map();
  for (const list of lists) for (const d of list) map.set(d.date, (map.get(d.date) || 0) + d.count);
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, count]) => ({ date, count }));
}

// 濃さの段階（0〜4）。0 件は 0、ほかは 0 でない日の四分位で 1〜4（行ごとに決める）
export function levelScale(days) {
  const v = days.map((d) => d.count).filter((c) => c > 0).sort((a, b) => a - b);
  if (!v.length) return () => 0;
  const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  const [q1, q2, q3] = [q(0.25), q(0.5), q(0.75)];
  return (c) => (c <= 0 ? 0 : c <= q1 ? 1 : c <= q2 ? 2 : c <= q3 ? 3 : 4);
}

// 升目の位置。列 = 週（最初の日の週を 0）、行 = 曜日（日曜 = 0）。日付は YYYY-MM-DD（UTC で数える）
export function gridCells(days) {
  if (!days.length) return [];
  const t0 = Date.parse(days[0].date + 'T00:00:00Z');
  const w0 = new Date(t0).getUTCDay();
  const level = levelScale(days);
  return days.map((d) => {
    const i = Math.round((Date.parse(d.date + 'T00:00:00Z') - t0) / 86400000) + w0;
    return { ...d, col: Math.floor(i / 7), row: i % 7, level: level(d.count) };
  });
}
