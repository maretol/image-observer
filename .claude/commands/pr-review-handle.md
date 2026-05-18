---
description: PR レビュー / コメントを分類し、対応 → commit / push → resolve → Copilot 再レビュー依頼までを一括実行
argument-hint: [PR番号] (省略時は現在ブランチに紐づく PR)
allowed-tools: Bash, Read, Edit, Write, Grep, Glob, Agent
---

# PR レビュー対応 一括実行

GitHub PR についたレビュー / コメントを取得し、対応要否を判断したうえで以下を実行する:

1. **対応すべきと判断したコメント** → コード修正 → commit → push → 対応内容をスレッドにコメント → resolve
2. **対応不要と判断したコメント** → 理由をスレッドにコメントして resolve (コード変更なし)
3. すべての処理が終わったあと、PR に対して **GitHub Copilot のレビューを再依頼** する

## 引数

- `$ARGUMENTS` — 対象 PR 番号。省略時は現在のブランチに紐づく PR を `gh pr view --json number` で解決する。

## 実行手順

### Step 1: 対象 PR の確定とコンテキスト取得

```bash
# PR 番号確定
if [ -n "$ARGUMENTS" ]; then
  PR_NUM="$ARGUMENTS"
else
  PR_NUM=$(gh pr view --json number -q .number)
fi

# リポジトリ情報
OWNER_REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)

# PR 基本情報 (head ref を控えておく — push 先ブランチの確認に使う)
gh pr view "$PR_NUM" --json number,title,headRefName,baseRefName,state,url
```

PR が `OPEN` 以外の場合はここで停止してユーザーに確認する。

### Step 2: 未 resolve のレビュースレッドを GraphQL で取得

REST API の review comments はスレッドの resolve 状態を返さないため、**GraphQL** で取得する。
`isResolved: false` のスレッドのみを処理対象にする (PR 全体への一般コメントは別途 issue comments を見る)。

```bash
gh api graphql -f query='
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first: 20) {
            nodes {
              id
              databaseId
              author { login }
              body
              url
              createdAt
            }
          }
        }
      }
    }
  }
}' -F owner="$(echo $OWNER_REPO | cut -d/ -f1)" \
   -F repo="$(echo $OWNER_REPO | cut -d/ -f2)" \
   -F number="$PR_NUM"
```

PR 全体への一般コメント (Conversation タブ最下部) も取得:

```bash
gh api "repos/$OWNER_REPO/issues/$PR_NUM/comments" \
  --jq '.[] | {id, user: .user.login, body, created_at, html_url}'
```

`pull-request-reviewer[bot]` / `copilot-pull-request-reviewer[bot]` を含む **bot のレビュー本文**
(`gh api repos/$OWNER_REPO/pulls/$PR_NUM/reviews`) も走査し、まだ未対応の指摘がないかチェックする。

### Step 3: コメントを「対応する / しない」で分類

各 未 resolve スレッドについて以下を判断する:

**対応すべき (= コード修正する) の判断基準:**
- バグ / 競合状態 / セキュリティ / 型不整合の指摘
- AGENTS.md / CLAUDE.md の方針と整合する改善提案
- 「動かない」「壊れる」「テストが落ちる」系の指摘
- 軽微でも明確な改善 (typo, dead code, 未使用 import など)

**対応しない (= 説明コメントを付けて resolve) の判断基準:**
- 既に対応済み / 別 PR で対応予定 (issue がある場合は番号を引用)
- スコープ外 (この PR の目的と無関係な refactor 提案)
- 設計方針と意図的に異なる選択をしている (理由を [.claude/context.md](.claude/context.md) や [docs/todo.md](docs/todo.md) から引用)
- 「質問」であって変更要求ではないもの → 質問に答えるコメントを付けて resolve
- false positive (bot レビューにありがち)

**判断に迷うものは原則「対応する」側に倒す**。ただし `init.md` で確定している仕様を変える提案は
ユーザー確認なしで採用しない (一次ソースの優先順位を尊重)。

分類結果を以下の形式でユーザーに **テキストで表示** してから着手する:

```
未 resolve スレッド: N 件

[対応する]
- thread#1 (path:line) — <要約> → <対応方針>
- thread#3 (path:line) — <要約> → <対応方針>

[対応しない]
- thread#2 (path:line) — <要約> → <resolve コメント文案>
```

### Step 4: 対応するコメントへの修正実装

[AGENTS.md](AGENTS.md) の該当節を必ず先に確認してから着手する。複数スレッドを **論理単位ごとに 1 commit** に分け、
1 つの commit が複数スレッドを束ねる場合は commit message で全て参照する。

commit message スタイルはこのリポジトリの慣習に従う:

```
レビュー対応 (#<PR番号>): <短い要約>

- thread#1: <変更点>
- thread#3: <変更点>
```

過去 commit 例 (参考): `git log --oneline -10` で確認できる `レビュー対応 (#54): isFromClose の型と wrapper クリック時 focus 委譲` のような形式。

### Step 5: テスト / ビルド確認

修正に応じて以下を実行 (該当しないものはスキップ):

```bash
# Go 側
go test ./...
go vet ./...

# フロント側
npm --prefix frontend run typecheck
npm --prefix frontend test -- --run

# (任意) wails build  # Linux ターゲットでの sanity check のみ。本番 EXE は対象外
```

落ちたら **commit せず** に修正を続ける。すべて通ったら commit。

### Step 6: push

```bash
# 現在のブランチが PR head と一致することを確認
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
HEAD_REF=$(gh pr view "$PR_NUM" --json headRefName -q .headRefName)
[ "$CURRENT_BRANCH" = "$HEAD_REF" ] || { echo "branch mismatch"; exit 1; }

git push
```

force push は禁止 (CLAUDE.md / 一般則)。

### Step 7: スレッドへの返信とコメント

**対応したスレッド**: 各スレッドの最後のコメントに reply する。

```bash
gh api -X POST "repos/$OWNER_REPO/pulls/$PR_NUM/comments/<root_comment_databaseId>/replies" \
  -f body="対応しました (<commit_sha>)。<具体的に何を変えたか>"
```

**対応しなかったスレッド**: 同じく reply に「対応しない理由」を書く。

文体は丁寧語で、過去の `レビュー対応` commit や PR コメントのトーンに合わせる。

### Step 8: スレッドの resolve

GraphQL `resolveReviewThread` mutation を使う:

```bash
gh api graphql -f query='
mutation($threadId: ID!) {
  resolveReviewThread(input: {threadId: $threadId}) {
    thread { id isResolved }
  }
}' -F threadId="<thread node id>"
```

Step 2 で取得した `thread.id` (GraphQL node ID) を使う。`databaseId` ではない点に注意。

### Step 9: Copilot レビュー再依頼

Copilot を reviewer に追加し直すことで再レビューが走る:

```bash
gh pr edit "$PR_NUM" --add-reviewer "Copilot"
```

`--add-reviewer "Copilot"` が GitHub 側で `copilot-pull-request-reviewer[bot]` を解決できないリポジトリでは、
GraphQL `requestReviews` でユーザー ID 指定にフォールバック:

```bash
# bot ID を取得
BOT_ID=$(gh api graphql -f query='{ user(login: "copilot-pull-request-reviewer") { id } }' -q .data.user.id 2>/dev/null)
PR_ID=$(gh api graphql -f query="{ repository(owner: \"$(echo $OWNER_REPO | cut -d/ -f1)\", name: \"$(echo $OWNER_REPO | cut -d/ -f2)\") { pullRequest(number: $PR_NUM) { id } } }" -q .data.repository.pullRequest.id)

gh api graphql -f query='
mutation($prId: ID!, $userIds: [ID!]!) {
  requestReviews(input: {pullRequestId: $prId, userIds: $userIds, union: true}) {
    pullRequest { id }
  }
}' -F prId="$PR_ID" -f userIds[]="$BOT_ID"
```

うまく解決できない場合は **ユーザーに「Copilot reviewer を手動で追加してください」と報告して停止**。
勝手に別の reviewer (人間) を追加しない。

### Step 10: 最終レポート

完了報告を以下の形式で出力する:

```
PR #<番号> レビュー対応完了

対応コミット:
- <sha> <message>

対応スレッド: N 件 (resolved)
対応なし resolve: M 件
Copilot 再レビュー依頼: ✅ / ⚠️ (手動対応必要)

PR URL: <url>
```

## 注意 (このコマンド固有のガードレール)

- **個別の commit を amend しない**。新規 commit を積む (CLAUDE.md 一般則)。
- **`git push --force` 禁止**。
- スレッド分類で「対応しない」と決めたものを **勝手に対応してはいけない**。逆も同じ。判断結果は Step 3 で表示してから進める。
- bot レビュー (Copilot 等) であっても false positive は遠慮なく「対応しない」側に分類してよい。理由を必ず書く。
- AGENTS.md の指摘パターンは **対応する前** に該当節を読む。読まずに直すと過去の轍を踏みやすい。
- `.claude/context.md` を更新する変更を行ったら、AGENTS.md A-1 / A-3 の原則 (動く値を書かない / コメントも追従させる) に従う。
- ユーザーが「対応せず PR をマージしたい」「特定スレッドだけ対応してほしい」等の指示を出した場合は、その範囲を尊重する。
