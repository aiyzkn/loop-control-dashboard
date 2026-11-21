// 表示の色（自動 / ライト / ダーク）。描く前に <html data-theme> を決めるため、モジュールではなく <head> で同期に読む。
// 選んだものは、ほかの設定と同じ場所（localStorage の loop-control-dashboard.prefs の theme）に覚えさせる。
// 保存できない環境では、その場だけ。'auto'（既定）は data-theme を付けず、OS の設定（prefers-color-scheme）に合わせる
(function () {
  'use strict';
  var KEY = 'loop-control-dashboard.prefs';
  var VALUES = ['auto', 'light', 'dark'];
  function read() {
    try { var v = JSON.parse(localStorage.getItem(KEY) || '{}').theme; return VALUES.indexOf(v) >= 0 ? v : 'auto'; } catch (e) { return 'auto'; }
  }
  function save(v) {
    try { var all = JSON.parse(localStorage.getItem(KEY) || '{}'); all.theme = v; localStorage.setItem(KEY, JSON.stringify(all)); } catch (e) { }
  }
  function apply(v) {
    var root = document.documentElement;
    if (v === 'light' || v === 'dark') root.setAttribute('data-theme', v); else root.removeAttribute('data-theme');
  }
  var current = read();
  apply(current);
  document.addEventListener('DOMContentLoaded', function () {
    var sel = document.getElementById('theme');
    if (!sel) return;
    sel.value = current;
    sel.addEventListener('change', function () {
      current = VALUES.indexOf(sel.value) >= 0 ? sel.value : 'auto';
      apply(current); save(current);
    });
  });
})();
