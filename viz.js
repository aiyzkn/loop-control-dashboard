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
