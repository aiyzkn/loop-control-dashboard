# loop-control-dashboard

ループエンジニアリングの指令リポジトリ [`aiyzkn/loop-control`](https://github.com/aiyzkn/loop-control)（非公開）のタスクと PC の状況を表示し、トークンに書き込みの権限があれば、タスクの書き換え・並べ替えもできる静的なページです。GitHub Pages で公開します。

- このリポジトリ（公開）には、**データを置きません**。画面のコードだけです
- 画面は、利用者の GitHub の fine-grained の個人用トークンで、ブラウザから GitHub の API（`api.github.com`）を読みます。トークンで非公開の `loop-control` を読めない人には、何も表示されません
- 組織 `aiyzkn` のメンバーであることも確かめます（画面の中の確認です。実際に読めるかどうかは、トークンの権限で決まります）
- 書き込みは、トークンに `Contents: Read and write` があるときだけ、確認の画面（差分）で「送る」を押したときに行います（下の「書き込み」）。PC のスリープ・再開の指示はできません

## 表示するもの

| 区分 | 中身 | 出どころ |
|---|---|---|
| まとめ | 全体の 3 色信号、アナログメーター（完了の割合・手が動いている割合・PC の最後の確認）、作業中・判断待ち・止まっている・着手待ち・受付の未整理・緊急の件数 | `projects/*/tasks/*.md`・`projects/*/archive/*.md`（数だけ）・`state/pcs/*.json`・`inbox.md` |
| グラフ | 案件ごとの状態の積み上げ、直近 14 日の起票と完了（タスク ID の日付で数える） | タスクの一覧（git の tree） |
| PC の状況 | 信号・最後の確認・判断（起こした / 見送り）と理由・セッションの数（動いている / 入力待ち / 上限 / 指示なし）・次の復帰・次の週次の起動 | `state/pcs/<エージェントの ID>.json`（自動起動 `kick.ps1` が書く） |
| タスク | 信号・状態・優先・案件・件名・段階・担当・PR / MR・現在地（進行中・次の一手） | タスクファイルの先頭と「成果物」「現在地」 |
| 案件とリポジトリ | 案件ごとの件数・完了の数・リポジトリ（本流のブランチ・PR / MR の一覧）・アカウント | `projects/*/project.md` の「リポジトリ」の表 |
| 受付 | 未整理の依頼、手が空いた時に実行するタスクの定義 | `inbox.md` |

### 信号の意味

| 対象 | 赤 | 黄 | 緑 | 消灯 |
|---|---|---|---|---|
| タスク | 止まっている（`blocked`） | 判断待ち（`waiting`）・着手待ち（`ready`。日数によらず）・作業中で印が 24 時間超 | 作業中 | 下書き |
| PC | 判断が失敗・最後の確認から 3 時間超 | 見送り・上限で止まったセッションがある | それ以外 | — |
| 全体 | 赤が 1 つでもある | 黄がある | 緑がある | どれも無い |

### リンク

案件（`project.md`）・タスク・Markdown（`inbox.md`・`roster.md`・`policy.md`・`AGENTS.md`）・PC の JSON は、指令リポジトリの GitHub の画面へ。エージェントの ID は `roster.md` のその行へ。リポジトリ・ブランチ・PR / MR の一覧・アカウントは、`project.md` の表のホストとパスから組み立てます。タスクの PR / MR は、「成果物」「現在地」に書かれた URL と、案件のリポジトリが 1 つに決まるときの `#番号`（GitHub）・`!番号`（GitLab）から拾います。外部へのリンクは `https://github.com/` と `https://gitlab.com/` だけで、使えない文字を含むパスにはリンクを張りません。

読み方は、auto-loop スキル（[aiyzkn/auto-loop-engineering](https://github.com/aiyzkn/auto-loop-engineering) の `skills/auto-loop`）の決まりに合わせています。受付の数え方は `Get-InboxSummary` と同じです。

## 書き込み

| 操作 | 書き換えるもの | 画面 |
|---|---|---|
| 書き換え | タスクの先頭の `priority`・`status`・`stage`・`assignee`、「利用者への質問と回答」の `回答:`（日付を付けて書く）、ログのメモ | タスクの表の「書き換える」「回答する（未回答の数）」 |
| 並べ替え | 先頭の `priority` と `order`（任意の数。小さいほど先。無いものは同じ優先度の後ろ） | 「並べ替え」の優先度ごとの列。ドラッグ＆ドロップ、カードのボタン、Alt + 矢印キー（上下 = 順、左右 = 優先度） |

- **1 回の操作 = 1 コミット。** Git Data API で、読んだ時点のコミットの上に tree → commit を作り、ブランチを fast-forward でだけ進めます（`force: false`）。コミットのメッセージは `[dashboard:<GitHub のログイン>] <操作> <タスク ID>`
- **上書きしません。** 読んだ後に、書き換えるファイルがほかで変わっていたら送りません。送る間にほかの push が入ったら（fast-forward にならない）、作ったコミットは捨てます。どちらも「読み直す」から、やり直します。書き換えないファイル（PC の状況など）だけが変わっていたときは、最新の上に積みます
- 書き換えたタスクは、先頭の `updated` を書き、末尾の「## ログ」に 1 行（`- <時刻> [dashboard:<ログイン>] <出来事>`）を足します（指令リポジトリの `AGENTS.md` の形）
- 並べ替えは、動かしたタスクの `order` を前後の間の値 1 つで済ませます。間が無い・`order` の無いタスクの間に置いたときは、その列を 10 刻みで振り直します（変わるタスクを、まとめて 1 コミット）
- `status` を `done`・`dropped` にしても、`archive/` への移動と担当の解放はしません（エージェントの `finish` で行います）。`urgent` に上げてよいのは利用者だけ（`AGENTS.md` 7.1）なので、このページを使う人が判断します
- 並びの `order` は、auto-loop スキルの `status.ps1`・`kick.ps1` の並べ方に入れる変更（aiyzkn/auto-loop-engineering）と合わせて使います。スクリプトが `order` を知らない間は、ダッシュボードの中だけの並びです
- 書き込みの権限は、リポジトリの情報（`permissions.push`）で見分けます。fine-grained のトークンの権限そのものは、ここに出ないので、`Contents: Read-only` のトークンでは「送る」で 403 になります

## 使い方

1. GitHub で fine-grained の個人用トークンを作る（Settings → Developer settings → Personal access tokens → Fine-grained tokens）
   - Resource owner: `aiyzkn`
   - Repository access: Only select repositories → `loop-control`
   - Repository permissions: 見るだけなら **Contents: Read-only**、書き換え・並べ替えもするなら **Contents: Read and write**（Metadata: Read-only は自動で付く）
   - Organization permissions: **Members: Read-only**（組織への所属を確かめるため）
   - 有効期限は短めに。組織の設定で承認が要る場合は、管理者の承認を待つ
2. 公開したページを開き、トークンを入れて「表示する」
3. トークンは、既定ではタブを閉じるまでブラウザの中（`sessionStorage`）にだけ置きます。「このブラウザに覚えさせる」を選ぶと `localStorage` に置きます（共有の PC では使わない）。「トークンを消す」で消えます

## 安全のための作り

- `Content-Security-Policy` で、通信先を `https://api.github.com` だけに、スクリプトをこのサイトのものだけに絞っています。外部のライブラリ・解析のスクリプトは使いません
- 表示はすべて `textContent` で入れ、タスクファイルの中身を HTML として解釈しません。リンクの `href` は、決まったホスト（`github.com`・`gitlab.com`）の URL を組み立てて張ります。メーター・グラフは、外部のライブラリを使わず SVG で描きます
- 書き込みの API（`git/trees`・`git/commits`・`git/refs` の作成・更新）は、確認の画面で「送る」を押したときだけ呼びます。見るだけの人は、トークンに読み取りの権限だけを付けてください。書き込む値は 1 行にし（改行・制御文字は空白に）、先頭・質問の行の形を崩さないようにしています

## 開発

依存はありません。読み取りの関数（`parse.js`）と書き換えの関数（`edit.js`）の試験:

```
node --test test/
```

手元で開くときは、ファイルを直接開く（`file://`）とモジュールが読めないので、簡単なサーバーを使います（例 `npx serve .`、`python -m http.server`）。

## 確かめていないこと

- fine-grained のトークンで、組織への所属の確認（`/user/memberships/orgs/aiyzkn`、だめなら `/orgs/aiyzkn/members/<login>`）が通ること。API の呼び出しは、`gh` の認証（OAuth のトークン）で通ることを確かめました（2026-11-19）
- ブラウザでの実際の表示（画面は、公開後に確かめる）
- 書き込みを、実物の GitHub の API と書き込みの権限のあるトークンで行うこと。API を偽物に差し替えたブラウザ（Playwright・Chromium）で、ドラッグ・キーボードでの並べ替え、回答と状態の書き換え、変更が無いとき、送る間の競合（422）、読んだ後の変更の検出、書き込みの権限が無いときの表示を確かめました（2026-11-20）
