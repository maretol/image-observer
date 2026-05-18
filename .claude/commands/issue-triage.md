---
description: GitHub issue を分類 / 優先度付け / タスク選定 → spec or 直接実装 → PR 作成までを一括実行
argument-hint: [issue番号 | "list"] (省略時 = list モード)
allowed-tools: Bash, Read, Edit, Write, Grep, Glob, Agent
---

# Issue トリアージ & 着手

GitHub issue を見て:

1. **ラベル未付与 issue にラベルを付与**
2. ラベルベースで **重要度 / 影響度から次に取り組むべきタスクをリストアップ**
3. ユーザーから issue 番号が指定されたら **対応**:
   - **大きい (`difficulty:hard`)** → `docs/spec-<topic>.md` を書き、レビュー合意後に実装 → **セルフレビュー (AGENTS.md H 章)** → PR
   - **数ファイル程度 (`difficulty:easy` / 場合により `medium`)** → そのまま実装 → **セルフレビュー (AGENTS.md H 章)** → PR

> PR 作成前のセルフレビュー (3-E) は **省略不可**。Copilot レビュー往復で繰り返し
> 指摘されていたパターンを事前に潰すために導入。`difficulty:easy` でも必ず通す。

## 引数

- `$ARGUMENTS` が空 / `list` → **list モード** (Step 1 + Step 2 まで実行して停止)
- `$ARGUMENTS` が数値 → **着手モード** (その issue 番号を対象に Step 3 以降を実行)
- `$ARGUMENTS` が `label` → ラベル付与だけ実行して停止 (Step 1 のみ)

## このリポジトリのラベル体系 (参考)

```
difficulty:easy    — 1ファイル程度の単純修正・小粒な変更
difficulty:medium  — 複数ファイル・中程度の設計やリファクタを伴う
difficulty:hard    — 新機能追加・スキーマやアーキ変更を伴う大規模変更

impact:high    — コア機能・実害解消などユーザ体験に直結
impact:medium  — UI整理・利便性などユーザ体験に中程度寄与
impact:low     — 内部品質・開発体験中心でユーザ体験への影響は小

bug / enhancement / documentation / question / good first issue / wontfix / duplicate / invalid
go / javascript / github_actions / dependencies
```

ラベル一覧の最新は `gh api repos/$OWNER_REPO/labels --jq '.[] | .name'` で確認できる。

---

## Step 1: ラベル未付与 issue にラベル付与

```bash
OWNER_REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)

# 全 open issue を取得 (PR は除外)
gh issue list --state open --limit 200 \
  --json number,title,body,labels,createdAt,url
```

各 issue について以下を判定:

### 1-A. `difficulty:*` の付与基準

| ラベル | 目安 |
|--------|------|
| `difficulty:easy` | 1 ファイル程度、ロジック変更なし or 局所的。例: typo / 微 UI 調整 / 設定値変更 |
| `difficulty:medium` | 複数ファイル、既存設計の中での拡張 / リファクタ。新しいデータ構造は持ち込まない |
| `difficulty:hard` | 新機能、state schema / IPC API / 永続化形式の変更、アーキ変更、`docs/spec-*.md` が必要 |

過去事例:
- #47 (画像削除機能追加) = `difficulty:medium` + `impact:high`
- #23 (アップデート機能追加) = `difficulty:hard` + `impact:medium`
- #19 (フォルダー監視機能) = `difficulty:hard` + `impact:high`

### 1-B. `impact:*` の付与基準

| ラベル | 目安 |
|--------|------|
| `impact:high` | コア機能 (画像表示 / フォルダ操作 / セッション) の改善、明確な実害 (クラッシュ / データ消失リスク) 解消 |
| `impact:medium` | UI 整理、利便性向上、よくある操作の摩擦低減 |
| `impact:low` | 内部品質、ドキュメント、開発体験、滅多に発生しないエッジケース |

### 1-C. その他のラベル

- bug 報告口調 → `bug` 追加
- 新機能要望 → `enhancement` 追加
- ドキュメント整備のみ → `documentation` 追加
- 質問口調 → `question` 追加 (`impact:*` / `difficulty:*` は付けない)
- Go / JS / Actions に閉じる変更ならその技術ラベルも付与

### 1-D. ラベル適用

判定結果を **テキストで表示してからユーザーに確認** する:

```
ラベル未付与 issue: N 件

#52 右クリックのコンテキストメニュー修正
  → 付与: difficulty:easy, impact:medium, bug

#50 ビューアタブ入れ替え対応
  → 付与: difficulty:medium, impact:medium, enhancement
```

確認が取れたら適用:

```bash
gh issue edit <issue番号> --add-label "difficulty:easy,impact:medium,bug"
```

判断に迷う issue (口調が曖昧 / 影響範囲不明) は **付与せず** ユーザー判断を仰ぐリストにして表示する。

`label` 引数で呼ばれた場合は **ここで停止**。

---

## Step 2: 次に取り組むべきタスクをリストアップ

優先度スコアは **impact × (1 / difficulty)** が直感に近い (高 impact / 低 difficulty が最優先):

| impact \ difficulty | easy | medium | hard |
|---------------------|------|--------|------|
| **high**            | S    | A      | B    |
| **medium**          | A    | B      | C    |
| **low**             | B    | C      | D    |

ただし以下は **個別に判断** して並び順を調整:

- `bug` ラベル付き → 同スコア帯の中で優先
- 既に着手中 (assignee あり / 関連 PR open) → リストから除外 or 末尾
- 依存関係 ([init.md](../../init.md) や [docs/todo.md](../../docs/todo.md) / spec ファイルで「先に X が必要」と書かれているもの) → 後ろに回す

出力形式:

```
## 次に取り組むべきタスク (open: N 件)

### S: 高 impact / 着手しやすい
- #52 [bug] 右クリックのコンテキストメニュー修正 (easy / high)
  → 想定スコープ: <短い見立て>

### A: 着手価値が高い
- #47 画像削除機能追加 (medium / high)
  → spec 不要 / 直接実装可能と判断 (理由: ...)

### B: 中位
- #50 ビューアタブ入れ替え対応 (medium / medium)

### 大きいので spec が要りそう
- #19 フォルダー監視機能 (hard / high) — spec 必須
- #23 アップデート機能追加 (hard / medium) — spec 必須
```

`list` モード / 引数なしならここで停止し、ユーザーから「#47 やって」のような指示を待つ。

---

## Step 3: 着手モード (issue 番号指定時)

### 3-A. 対象 issue の精読

```bash
gh issue view <番号> --json number,title,body,labels,comments,url
```

本文 + コメント全部を読み、以下をテキストで整理してユーザーに表示する:

```
#<番号> <タイトル>
ラベル: difficulty:X, impact:Y, ...
要件サマリ:
- ...
未確定の論点:
- ...
着手方針: [spec を書く / 直接実装]
理由: ...
```

### 3-B. 着手方法の判断

| 条件 | 着手方法 |
|------|---------|
| `difficulty:hard` | **spec 必須**。3-C へ |
| `difficulty:medium` で **設計判断が必要** (新規データ構造 / IPC 追加 / state schema 変更 / 既存方針との衝突) | **spec を書く**。3-C へ |
| `difficulty:medium` で **既存方針に沿った機械的拡張** | spec 省略。3-D へ (ただし PR description で設計判断を明記) |
| `difficulty:easy` | spec 不要。3-D へ |
| ラベル未付与 | Step 1 のラベル判定を先に流す |

**spec 要否で迷ったら spec 側に倒す**。後出しでアーキ変更が出ると CLAUDE.md / AGENTS.md の積み重ねが崩れる。

### 3-C. Spec を書くフロー (`difficulty:hard` / 設計判断あり)

1. ファイル名規約: `docs/spec-<topic>.md` (kebab-case)。例: `spec-image-delete.md`
2. 既存 spec の構成を踏襲する: 改訂履歴 / ゴール (DoD) / 用語 / データモデル / 画面・操作 / IPC / 永続化 / マイグレーション / テスト / 決定事項 / Out of scope / Phase 分割
   - 既存 spec 参考: [docs/spec-multi-viewer.md](docs/spec-multi-viewer.md), [docs/spec-folder-tree.md](docs/spec-folder-tree.md), [docs/spec-thumbnail.md](docs/spec-thumbnail.md)
3. spec 冒頭に `> **ステータス**: ドラフト。§N の決定事項をユーザー合意後に着手。` を入れる
4. [init.md](init.md) (元仕様) と矛盾しないか確認、矛盾があれば spec 内に「init.md の X 節を再解釈する」として明記
5. **方針決定ログは [docs/todo.md](../../docs/todo.md) に1行追記** (実装着手前の意思決定を記録するため。CLAUDE.md の一次ソース定義に従う)

書き終わったら **PR は作らずに** ユーザーに通知:

```
docs/spec-<topic>.md を書きました。レビューをお願いします。
レビュー後の合意事項を spec に反映してから実装に入ります。
```

ここで **停止**。ユーザーから「OK 実装に入って」もしくは修正指示が来るまで待つ。
レビューフィードバックを spec に反映したら、改訂履歴に 1 行追記して再度確認を取る。

合意が取れたら 3-D へ。

### 3-D. 実装フロー (spec 合意後 / spec 不要のとき)

1. **新しいブランチを切る**:
   ```bash
   git checkout main && git pull
   git checkout -b <type>/<issue番号>-<kebab-topic>
   # type: feat / fix / refactor / docs / chore
   # 例: feat/47-image-delete, fix/52-context-menu
   ```
2. **[AGENTS.md](AGENTS.md) の該当節を確認**してから実装に着手 (Go なら A 節 / B 節, フロントなら C 節 など、現物を読んで該当箇所を引く)
3. 実装。論理単位ごとに commit を分ける。commit message の慣習:
   ```
   <type> (#<issue番号>): <短い要約>
   ```
   spec を書いた場合は 1 つ目の commit で spec をコミット (もしくは PR を分けたければ別 PR)。
4. テスト / ビルド (該当するもの):
   ```bash
   go test ./... && go vet ./...
   npm --prefix frontend run typecheck
   npm --prefix frontend test -- --run
   ```
   落ちたら直してから次へ。
5. **context.md / コメント追従**: 実装で識別子をリネーム / 機能を変更したら [AGENTS.md](AGENTS.md) A-2 / A-3 に従い、`.claude/context.md` とコード内コメントの旧情報を更新する。動く値 (テスト件数 / ファイル行数等) は書かない (AGENTS.md A-1)。

### 3-E. PR 作成前セルフレビュー (AGENTS.md H 章必須チェック)

Copilot レビューで複数ラウンド指摘されてきた頻出パターンは [AGENTS.md](AGENTS.md) H 章
(H-1〜H-7) に集約されている。PR 作成前に **必ず H 章全項目を通読** し、変更内容に
該当するチェックを grep / 目視で実行する。`difficulty:easy` でも省略しない (過去
PR では小さい変更でも H-4 CSS クラス未定義 / H-7 波及確認漏れで Round 2 が発生)。

「該当なし」も明示する — 検討した記録を残すため。

#### セルフレビュー出力テンプレ

実施結果は以下の形式でテキスト出力してからユーザーに見せ、問題なしの確認を取って
から 3-F (PR 作成) に進む:

```
## PR 作成前セルフレビュー (AGENTS.md H 章)

### H-1 ARIA / a11y
- 新規 interactive 要素: <列挙 or "なし">
- :focus-visible / :focus-within 表示: <確認結果>
- dialog / alertdialog の accessible name: <確認結果 or "該当なし">
- 同画面の周辺 interactive 要素にも同水準の focus 表示: <確認結果>
- input は label htmlFor / aria-label でラベル関連付け: <確認結果 or "該当なし">

### H-2 イベントハンドラ
- 新規 onKeyDown / onClick のバブリング二重発火: <確認結果 or "該当なし">
- 新規 onPointerDown のマルチタッチ / 二重 pointerdown 防御: <確認結果 or "該当なし">
- pointercancel / unmount cleanup で release 呼び出し: <確認結果 or "該当なし">

### H-3 グローバル / モジュール state のリーク
- 新規 module-scoped state / token stack / baseline cache: <列挙 or "なし">
- 空になった時のリセット経路: <確認結果>

### H-4 CSS クラス参照
- 新規 / 変更した className を列挙: <列挙 or "なし">
- 全クラスの実在を App.css で grep 確認: <結果>
- 周辺要素にも同じ rule が必要か: <確認結果>

### H-5 Modal / Dialog
- 新規 ModalShell 使用: <列挙 or "該当なし">
- closeOnBackdrop / closeOnEscape の default がそのダイアログの意図と一致: <確認結果>

### H-6 ドキュメント追従
- リネーム / 削除した識別子: <列挙 or "なし">
- .claude/context.md / コード内コメント / docstring の旧名残り: <git grep 結果>
- 説明文と実装の最終形が一致 (A-3): <確認結果>
- PR 説明の test plan に手動確認項目を明示: <確認結果>

### H-7 波及確認 (= 1 件の修正で同種パターンが他に無いか grep)
- 今回触ったパターン: <列挙>
- 全リポジトリで grep した結果: <結果>
```

#### 推奨 grep コマンド (該当節で実行する)

```bash
# H-4: 今回 diff で追加 / 変更された className を抽出 → 各クラスの実在を grep
git diff main...HEAD -- 'frontend/src/**/*.tsx' 'frontend/src/**/*.ts' \
  | grep -oE 'className="[^"]+"' | sort -u
git grep -n '\.<クラス名>' frontend/src/App.css

# H-6: リネーム / 削除した識別子の旧名残り
git grep -n "<旧名>" -- '*.go' '*.ts' '*.tsx' '*.md'

# H-7 例: 新規 onPointerDown を追加した PR で、他の onPointerDown 箇所が
#        同じ二重防御パターンを備えているか確認
git grep -n "onPointerDown" -- 'frontend/src/**/*.tsx'
```

#### セルフレビューで問題が見つかった場合

PR を作らず、**修正 commit を追加してから** 再度セルフレビューを通す。
出力には「<項目>: 修正済み (commit <hash>)」と記録を残す。
ユーザーから「セルフレビュー OK」もしくは個別指示が来てから 3-F に進む。

### 3-F. PR 作成

```bash
git push -u origin HEAD

gh pr create --title "<type> (#<issue番号>): <要約>" --body "$(cat <<'EOF'
## Summary
- <要点 1-3 行>

Closes #<issue番号>

## 変更内容
- <主要な変更>

## Test plan
- [ ] go test ./... 通過
- [ ] npm --prefix frontend run typecheck 通過
- [ ] npm --prefix frontend test 通過
- [ ] (必要なら) wails dev での動作確認: <確認ポイント>

## 関連
- spec: docs/spec-<topic>.md (新規 / 更新)  ← spec を書いた場合のみ

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

PR description には:
- `Closes #<issue番号>` を必ず含める (マージで auto-close)
- spec を書いた場合は spec ファイルへのリンクを必須
- spec を省略した `difficulty:medium` の場合、PR description に「設計判断」セクションを設けて trade-off を明記 (これがレビュアー側の追跡材料になる)

PR 作成後、URL をユーザーに報告して停止。Copilot レビューが自動で走るリポジトリ設定の場合はそのまま。
走らない場合は `gh pr edit <PR番号> --add-reviewer Copilot` (失敗時は `/pr-review-handle` 側の Step 9 と同じ fallback)。

---

## 注意 (このコマンド固有のガードレール)

- **ラベル付与は確認後に実行**。勝手に大量付与しない (誤分類が広がる)。
- **spec / 直接実装の判断はテキストで提示してから進める**。ユーザーが「直接実装で」「いや spec 書いて」と redirect できる余地を残す。
- spec をコミットする前に **ユーザーのレビュー** を必ず受ける (init.md 一次ソース原則を尊重し、勝手な解釈拡張を避ける)。
- ブランチは main から切る。既存ブランチを再利用しない。
- PR は **draft で作らず通常 PR** で作る (このリポジトリの過去 PR の慣習に合わせる)。draft が必要なケースはユーザーから指示が来てから。
- **3-E セルフレビューは省略不可**。Copilot レビュー往復を減らすために導入したフロー。
  `difficulty:easy` でも必ず通す。「該当なし」も明示する (検討した記録を残すため)。
  ユーザーから「OK」を取ってから 3-F (PR 作成) に進む。
- `force push` / `--no-verify` 禁止 (CLAUDE.md / 一般則)。
- 着手中に「思ったより大きい」と分かったら **一度停止してユーザーに報告**。勝手に spec モードに切り替えない。逆に「spec で書いたが実装してみたら超単純だった」場合は spec をそのまま温存する (将来の参考になる)。
- 関連: PR 作成後のレビュー対応は [/pr-review-handle](.claude/commands/pr-review-handle.md) を使う。
