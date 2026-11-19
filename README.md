# loop-control-dashboard

ループエンジニアリングの指令リポジトリ [`aiyzkn/loop-control`](https://github.com/aiyzkn/loop-control)（非公開）のタスクと PC の状況を、**参照だけ**で表示する静的なページです。GitHub Pages で公開します。

- このリポジトリ（公開）には、**データを置きません**。画面のコードだけです
- 画面は、利用者の GitHub の fine-grained の個人用トークンで、ブラウザから GitHub の API（`api.github.com`）を読みます。トークンで非公開の `loop-control` を読めない人には、何も表示されません
- 組織 `aiyzkn` のメンバーであることも確かめます（画面の中の確認です。実際に読めるかどうかは、トークンの権限で決まります）
- 書き込みはしません（優先度・順の変更、PC のスリープ・再開の指示はできません）

## 表示するもの

| 区分 | 中身 | 出どころ |
|---|---|---|
| まとめ | 作業中・判断待ち・止まっている・着手待ち・受付の未整理・緊急の件数 | `projects/*/tasks/*.md`・`inbox.md` |
| PC の状況 | 最後の確認・判断（起こした / 見送り）と理由・セッションの数（動いている / 入力待ち / 上限 / 指示なし）・次の復帰・次の週次の起動 | `state/pcs/<エージェントの ID>.json`（自動起動 `kick.ps1` が書く） |
| タスク | 状態・優先・案件・件名・段階・担当・現在地（進行中・次の一手） | タスクファイルの先頭と「現在地」 |
| 受付 | 未整理の依頼、手が空いた時に実行するタスクの定義 | `inbox.md` |

読み方は、auto-loop スキル（[aiyzkn/auto-loop-engineering](https://github.com/aiyzkn/auto-loop-engineering) の `skills/auto-loop`）の決まりに合わせています。受付の数え方は `Get-InboxSummary` と同じです。

## 使い方

1. GitHub で fine-grained の個人用トークンを作る（Settings → Developer settings → Personal access tokens → Fine-grained tokens）
   - Resource owner: `aiyzkn`
   - Repository access: Only select repositories → `loop-control`
   - Repository permissions: **Contents: Read-only**（Metadata: Read-only は自動で付く）
   - Organization permissions: **Members: Read-only**（組織への所属を確かめるため）
   - 有効期限は短めに。組織の設定で承認が要る場合は、管理者の承認を待つ
2. 公開したページを開き、トークンを入れて「表示する」
3. トークンは、既定ではタブを閉じるまでブラウザの中（`sessionStorage`）にだけ置きます。「このブラウザに覚えさせる」を選ぶと `localStorage` に置きます（共有の PC では使わない）。「トークンを消す」で消えます

## 安全のための作り

- `Content-Security-Policy` で、通信先を `https://api.github.com` だけに、スクリプトをこのサイトのものだけに絞っています。外部のライブラリ・解析のスクリプトは使いません
- 表示はすべて `textContent` で入れ、タスクファイルの中身を HTML として解釈しません
- 書き込みの API は呼びません。トークンにも読み取りの権限だけを付けてください

## 開発

依存はありません。読み取りの関数（`parse.js`）の試験:

```
node --test test/
```

手元で開くときは、ファイルを直接開く（`file://`）とモジュールが読めないので、簡単なサーバーを使います（例 `npx serve .`、`python -m http.server`）。

## 確かめていないこと

- fine-grained のトークンで、組織への所属の確認（`/user/memberships/orgs/aiyzkn`、だめなら `/orgs/aiyzkn/members/<login>`）が通ること。API の呼び出しは、`gh` の認証（OAuth のトークン）で通ることを確かめました（2026-11-19）
- ブラウザでの実際の表示（画面は、公開後に確かめる）
