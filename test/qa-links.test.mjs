// node --test test/  （利用者への質問と回答: URL のリンク・質問の下の行・指示の追加）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuestions } from '../parse.js';
import { linkSegments, appendInstruction, applyTaskEdits } from '../edit.js';

test('URL の切り出し: 句読点・全角の閉じかっこを含めない', () => {
  assert.deepEqual(linkSegments('PR https://github.com/a/b/pull/3 を見て'), [{ text: 'PR ' }, { url: 'https://github.com/a/b/pull/3' }, { text: ' を見て' }]);
  assert.deepEqual(linkSegments('（https://github.com/a/b/pull/3）。'), [{ text: '（' }, { url: 'https://github.com/a/b/pull/3' }, { text: '）。' }]);
  assert.deepEqual(linkSegments('see https://x.example/a.'), [{ text: 'see ' }, { url: 'https://x.example/a' }, { text: '.' }]);
  assert.deepEqual(linkSegments('https://ja.wikipedia.org/wiki/A_(B)'), [{ url: 'https://ja.wikipedia.org/wiki/A_(B)' }]);
  assert.deepEqual(linkSegments('(https://x.example/a)'), [{ text: '(' }, { url: 'https://x.example/a' }, { text: ')' }]);
  assert.deepEqual(linkSegments('URL なし'), [{ text: 'URL なし' }]);
  assert.deepEqual(linkSegments(''), []);
  assert.deepEqual(linkSegments('javascript:alert(1) http://'), [{ text: 'javascript:alert(1) http://' }], 'http(s) だけ。ホストの無いものは文字のまま');
});

const task = `---
id: 20261126-demo
status: waiting
updated: 2026-11-26T00:00:00+09:00
---

# demo

## 利用者への質問と回答

- Q1（2026-11-26、a）: 次の PR をマージするか
  - https://github.com/a/b/pull/1
  - 回答:
  - 補足 https://github.com/a/b/pull/2

## 決定事項

## ログ

- 2026-11-26T00:00:00+09:00 [a] 起票
`;

test('質問の下の字下げした行を details に。回答の行は含めない', () => {
  const [q] = parseQuestions(task);
  assert.equal(q.question, '次の PR をマージするか');
  assert.deepEqual(q.details, ['https://github.com/a/b/pull/1', '補足 https://github.com/a/b/pull/2']);
  assert.equal(q.answer, '');
});

test('指示の追加: 節の末尾に、日付と書き手つきで。複数行は字下げ', () => {
  const out = appendInstruction(task, '先に #2 を見て\nそのあと #1', { who: 'dashboard:me', now: '2026-11-26T09:00:00+09:00' });
  assert.match(out, /  - 補足 https:\/\/github.com\/a\/b\/pull\/2\n- 指示（2026-11-26、dashboard:me）: 先に #2 を見て\n  そのあと #1\n\n## 決定事項/);
  // 指示の行のあとに回答の行が来ても、Q1 の回答にはしない
  const qs = parseQuestions(out + '');
  assert.equal(qs.length, 1);
  assert.throws(() => appendInstruction(task, '  \n ', { who: 'x' }));
  // 見出しの形は崩さない
  assert.match(appendInstruction(task, '## 決定', { who: 'x', now: '2026-11-26T09:00:00+09:00' }), /: \\## 決定/);
});

test('指示の追加: 節が無ければ「決定事項」の前に作る', () => {
  const t = task.replace(/## 利用者への質問と回答[\s\S]*?(?=## 決定事項)/, '');
  const out = appendInstruction(t, 'やって', { who: 'x', now: '2026-11-26T09:00:00+09:00' });
  assert.match(out, /## 利用者への質問と回答\n\n- 指示（2026-11-26、x）: やって\n\n## 決定事項/);
});

test('applyTaskEdits の instruction: 状態は変えず、ログに残す', () => {
  const r = applyTaskEdits(task, { instruction: 'これもお願い' }, { who: 'dashboard:me', now: '2026-11-26T09:00:00+09:00' });
  assert.ok(r.changed);
  assert.match(r.text, /^status: waiting$/m);
  assert.match(r.text, /- 指示（2026-11-26、dashboard:me）: これもお願い/);
  assert.match(r.text, /\[dashboard:me\] 指示を追加/);
  assert.equal(applyTaskEdits(task, { instruction: '  ' }, { who: 'x' }).changed, false);
});

test('質問の見た目の分け方: 回答の行が無い・空は未回答、書いてあれば回答済み', async () => {
  const { questionState } = await import('../parse.js');
  const qs = parseQuestions([
    '## 利用者への質問と回答',
    '',
    '- Q1（2026-11-28、a）: 進めてよいか',
    '  - 回答: 2026-11-28 はい',
    '- Q2（2026-11-28、a）: どちらにするか',
    '  - 回答:',
    '- Q3（2026-11-28、a）: 回答の行が無い',
    '',
    '## 決定事項',
  ].join('\n'));
  assert.deepEqual(qs.map(questionState), ['answered', 'open', 'open']);
  assert.equal(questionState({ answer: '   ' }), 'open');
  assert.equal(questionState(null), 'open');
});
