# 分類タブ + トップレベルタブ化 実装仕様書 (Phase 4)

Phase 3 シリーズで完成した「左ペイン (フォルダツリー) + 右ペイン (ビューアグリッド)」の 2 ペイン UI を、**トップレベル 2 タブ「一覧 / ビューア」**に再編し、新タブとして「分類ビュー」を追加する。

本書の **元仕様** は [docs/new_thumbnail.md](new_thumbnail.md)。本書はそれを当アプリに統合するための差分仕様であり、原則として元仕様を踏襲する。元仕様と本書が矛盾する箇所は本書を優先する (元仕様§0 の方針に従う)。

参考実装: [docs/new_thumbnail/sample.html](new_thumbnail/sample.html) / [docs/new_thumbnail/sample.csv](new_thumbnail/sample.csv)。

---

## 改訂履歴

- **v1.0 (2026-05-10)**: Phase 4 初版。トップタブ化 + 分類タブ + ライトボックス + 競合検出 + 配色汎用化を含む。
- **v1.1 (2026-05-10)**: ライトボックスを廃止し、サムネクリック時に **ビューアタブのアクティブパネルで開く + トップタブを自動でビューアに切り替える** 動線へ変更。`useClassification` から lightbox 状態 / 前後移動アクション / `nextLightbox` / `prevLightbox` を削除、`Lightbox.tsx` を削除、`App.tsx` で `viewer.openInActive` + `setTopTab("viewer")` を結線。連続レビュー (`←/→` でフィルタ後順序を辿る) は v1 では完全廃止 (再導入は Phase H 以降)。本書中で「ライトボックス」と書かれている箇所はすべて **v1.1 で撤去済み** と読み替えること (§5.8 / §4.3 / §4.5 / §4.6 / §11.1 / §13.1 / §14 の関連項目)。
- **v1.2 (2026-05-10)**: 親フォルダ直下にサブディレクトリを含むケースを正式サポート (例: `parent/child1/hoge.png`)。
   - **再帰スキャナ**: `internal/classification/scanner.go` を `filepath.WalkDir` ベースに書き換え。`filename` フィールドは親からの POSIX 相対パス (`child1/hoge.png` 等) で表現。隠しディレクトリ (`.` 始まり) はスキップ。シンボリックリンクは追跡しない (リンクを辿らないことで循環検出を不要にする簡素化)。
   - **子→親マージ**: 親に sidecar が無く、いずれかの子に non-trivial な sidecar (JSON / CSV) がある場合、初回フォルダオープン時に **マージ確認ダイアログ** (`MergePromptDialog`) を表示。「マージして親に取込」「無視して空サイドカー作成」「キャンセル」の 3 択。マージ時は filename に子フォルダ名をプレフィックス。子サイドカーは削除せず残す。Wails バインディング `PreviewChildSidecars` / `MergeChildSidecars` を追加。
   - **アコーディオン UI**: グリッドをディレクトリ単位 (深さ無視のフラット集約。`(直下)` / `child1` / `child1/sub` 等) でグループ化し、ヘッダクリックで折りたたみ可能。「すべて展開」ボタンをサブツールバーに追加。フィルタは折りたたみと独立に作用する (折りたたまれていてもエントリ件数には反映)。
   - **state schema v2 → v3**: `ListTabState.CollapsedGroups []string` を追加。マイグレーションせず default fallback。
   - **Card filename**: パスが長くなるので `text-overflow: ellipsis` で省略 + `title` 属性でフルパス表示。
   - 関連スコープ追加: `groups.ts` (純関数 `groupByDirectory` / `groupKeyOf`) + テスト、`useDirectoryGroups` フック、`DirectoryGroup` コンポーネント、`MergePromptDialog` (shared)。
- **v1.4 (2026-05-10)**: 一覧の **複数選択 + バルクオープン**。
   - **選択 UI (案 A: 常時 checkbox)**: Card 左上に小さな checkbox を表示。サムネクリックは従来通り単発オープン。`useClassification` に `selectedFilenames` / `isSelected` / `toggleSelected` / `clearSelected` を追加。選択は `Set<filename>` で保持し、フォルダを変えると自動でクリア (フィルタ・折りたたみは無関係)。セッション保存はしない (一時状態)。
   - **バルクツールバー**: 選択が 1 件以上で `cls-subtoolbar` の直下に表示。「N 件選択中 / [タブで開く] / [パネル分割で開く] / [選択解除]」。
   - **タブで開く**: アクティブパネルに各画像を新規タブとして連続追加 (`useViewerGrid.openManyInActive`)。重複パスはフォーカスのみ (既存 `openInActive` の dedup を継承)。サイズ制限超過は個別にスキップ + トースト。
   - **パネル分割で開く**: アクティブパネルを画像数だけ右に分割し、各画像を別パネルへ (`useViewerGrid.openManyAsSplit`)。アクティブパネルが空の場合は最初の 1 枚を空 leaf に流し込み (無駄な空 leaf を作らない)。`MAX_PANELS = 16` に達したら以降スキップ。視認性の都合で **8 枚を超える選択時はボタンを disable** (tooltip 案内)。
   - **`layout.ts` 追加**: `splitWithNewLeaf(layout, dstLeafId, edge, tab)` (新規タブ用の split helper)。vitest +3 ケース (合計 93)。
   - **将来オプション (案 B 実装時)**: `Ctrl+クリック` で選択トグル / `Shift+クリック` で範囲選択。`docs/todo.md H` に「複数選択 UI のオプション化」として記載。設定キー候補: `list.selection.mode = "checkbox" | "modifier" | "both"`。Phase H で settings.json と一緒に実装。

---

## 0. 元仕様との差分サマリ

| 項目 | 元仕様 (new_thumbnail.md) | 本書での扱い |
|---|---|---|
| 分類ビューの位置付け | 既存タブ UI 内に「分類タブ」を 1 枚追加 (§5.1) | **トップレベルで「一覧」「ビューア」の 2 タブに再編** し、「一覧」タブ内に分類ビューを実装 |
| 既存の左ペイン (フォルダツリー) | 言及なし (前提として残す想定) | **完全削除** ([features/folder-tree/](../frontend/src/features/folder-tree/) と `app.go::ListDirectory` / `internal/tree::List` を撤去) |
| フォルダ選択 UI | サイドカーが置かれたフォルダを開いた時点で有効化 | 「一覧」タブのヘッダ内に「フォルダを開く」ボタンを置く |
| ライトボックスの folder 表示 (§5.8) | 「ファイル名 ─ folder (confidence) ─ note」を文字列で表示 | **v1.1 で廃止** (元は色付きバッジ + 抽出タグの強化案を採用していたが、ライトボックスごと削除) |
| 分類サムネのアスペクト | aspect-ratio 1:1 / object-fit: contain (§5.3) | 同左 (本書独自の差分なし) |
| サムネ生成 | 元仕様は実装方針未指定 (§6.3.5 で 2 案提示) | 既存の `internal/thumb` を流用 (256px / `letterbox`) |
| クリックで開く先 | ライトボックス (§5.8) | **v1.1 改定**: ビューアタブのアクティブパネルで開き、トップタブをビューアに自動切替 (`useViewerGrid.openInActive` 経由)。同一画像が既に開かれている場合はそのタブにフォーカス (todo.md E2)。連続レビュー機能 (`←/→`) は廃止 |
| セッション復元 | 言及なし | `state.json` を v2 にバージョンアップし、トップレベルアクティブタブ + フォルダパス + フィルタ状態を保存 |
| メタデータ正本 | JSON 優先 / CSV は互換用 (§4.1) | **正本は JSON のみ**。CSV は **初回 import 専用** と位置付け、JSON が無いフォルダで一度だけ読み、保存以降は JSON のみ参照。AI / 手動編集も JSON を直接編集する想定 |
| 外部編集との整合 | 言及なし | **JSON ファイルの mtime を保持し、保存時に競合検出**。AI / 外部エディタによる書き換えと同時編集を検知して警告ダイアログ。**手動「再読み込み」ボタン** を一覧タブヘッダに置く |
| タグ命名と配色 | キャラ名固定マップ (iroha / kaguya / shugo / fumei …) と "shugo は集合 / fumei は不明" の特別扱い | **アプリは汎用画像分類ツールとしてレベル 1 汎用化**: スキーマと抽出ロジックは汎用、ロジック上の `shugo` / `fumei` 特別扱いは撤廃 (`fumei` はただの単一タグ扱い、複合分類は `主 (sub + sub)` 構文として一般化)。配色は既知タグマップ + 未知タグの**決定的ハッシュ自動割当**を v1 から実装 (元仕様§7.2 で言及されていた将来案を v1 に前倒し)。サンプルキャラ色は `defaultPalette.ts` に分離 |

---

## 1. ゴール (DoD)

- 起動するとトップレベルに「一覧」「ビューア」の 2 タブが見え、初期は「一覧」がアクティブ。
- 「一覧」タブで「フォルダを開く」を押し、サイドカーがあるフォルダを選ぶ → 分類グリッドが表示される。
- サイドカーがないフォルダを選んだ場合 → 「サイドカーがありません。新規作成しますか?」のダイアログが出て、はいで `_classification.json` が生成され、画像を空エントリで列挙したグリッドが表示される。
- タグチップ・信頼度・検索の 3 種フィルタが AND で機能する (元仕様§5.4 / §5.5 / §5.6)。
- カードの編集アイコンからポップオーバーが開き、folder / confidence / note を編集 → 保存でカード表示が更新される。再起動後も保持されている (元仕様§5.7)。
- サムネクリックでビューアタブのアクティブパネルに該当画像が開かれ、トップタブが自動でビューアに切り替わる (v1.1)。同一画像が既に開かれていれば既存タブにフォーカス (`useViewerGrid.openInActive` 経由)。
- 「ビューア」タブは Phase 3c までの既存挙動 (グリッド + パネル + タブ + zoom/pan) をそのまま保持する。**機能変更なし**。
- セッション復元: 終了 → 再起動の往復で「アクティブなトップレベルタブ」「一覧タブのフォルダパス」「一覧タブのフィルタ状態」「ビューアタブのグリッド/タブ状態 (Phase 3c 既存)」が復元される。
- 既存 folder-tree feature が完全に取り除かれている (使われないコードが残らない)。
- 一覧タブヘッダに **「再読み込み」ボタン** があり、外部 (AI / テキストエディタ) で `_classification.json` を編集した直後にワンクリックで反映できる。
- アプリ内編集中に外部から JSON が書き換えられていた場合、**保存時に競合検出ダイアログが出て破棄/上書きを選べる** (mtime ベース)。
- サンプル外のタグ文字列 (例: `cat (kuro + shiro)` / `landscape` / 未知のキャラ名) でも色付きバッジが付き、フィルタも問題なく機能する (既知タグマップ未登録の場合は決定的ハッシュで自動色割当)。
- `wails build` 通過、`go test ./...` 全通過、`tsc --noEmit` クリア。

---

## 2. アーキテクチャ概観

```
┌──────────────────────────────────────────────────────────────┐
│ [一覧] [ビューア]                                             │  TopTabBar
├──────────────────────────────────────────────────────────────┤
│ <一覧タブのとき>                                              │
│  ┌─ Header: [フォルダを開く] (path) [件数: 123/155] [↻] ─┐   │
│  ├─ TagChips: [すべて] [tagA 35] [tagB 11] ...        ─┤   │
│  ├─ SubToolbar: 信頼度 [all][high][mid][low] | 検索 [_] ┤   │
│  └─ Grid: Card[] (サムネ + ファイル名 + 分類バッジ + 編集)─┘    │
│                                                              │
│ <ビューアタブのとき>                                          │
│  既存 ViewerGrid (rows × cols × Panel × Tab)                 │
└──────────────────────────────────────────────────────────────┘
```

```
+-------------------------+        Wails Bind        +---------------------------+
|  Frontend (React/TS)    |  <===================>   |  Backend (Go)             |
|  - TopTabs              |                          |  - internal/classification|
|  - features/list/       |                          |    (new package)          |
|  - features/viewer-grid/|                          |  - internal/thumb (流用)  |
|  - features/session/    |                          |  - internal/imgread (流用)|
+-------------------------+                          +---------------------------+
```

---

## 3. Go 側設計

### 3.1 パッケージ構成 (新規 + 削除)

```
internal/
├── tree/        # 削除 (List + tree_unix/windows + test ごと)
│                # ※ IsImage は廃止予定だが他パッケージから参照されているため
│                #   §3.2 で internal/imgfile への移設を行う
├── thumb/       # 既存 (流用、変更なし)
├── imgread/     # 既存 (流用、変更なし)
├── state/       # 既存 (Phase 4 で v2 へバージョンアップ、§3.6)
├── imgfile/     # 新規: tree.IsImage を移設 (拡張子判定のみ)
│   └── imgfile.go
└── classification/   # 新規
    ├── types.go         # Confidence / Entry / Classification / LoadResult
    ├── repository.go    # SidecarRepository interface + jsonRepo / csvRepo の合成
    ├── scanner.go       # FileScanner interface + 実装
    ├── service.go       # Service struct (Load / Save / UpdateEntry / CreateEmpty)
    └── *_test.go
```

### 3.2 `internal/imgfile/imgfile.go` (新設)

`internal/tree::IsImage` を `internal/imgfile::IsImage` に移設する。`thumb` / `imgread` / `classification/scanner` の 3 箇所から呼ばれる。大小文字を無視して `.jpg/.jpeg/.png/.gif/.webp/.bmp/.tif/.tiff` を判定する。

see `internal/imgfile/imgfile.go`

### 3.3 `internal/classification/types.go`

主要型: `Confidence` ("high"/"mid"/"low"/"")、`Entry` {Filename, Folder, Confidence, Note}、
`Classification` {Version, UpdatedAt, Entries}、`LoadResult` {FolderPath, Entries, Orphans, HasSidecar, Source, Mtime}。

see `internal/classification/types.go`

JSON フィールド名はプロジェクト方針に従い camelCase (`folderPath`, `hasSidecar`, `updatedAt`, `mtime`)。`Mtime` は UnixNano (`int64`)。

#### 3.3.1 タグの汎用化方針 (本書差分)

本書では Entry の `Folder` 文字列を **「主タグ + 任意の補助タグ」** として汎用解釈する:

- 構文 `主 (sub1 + sub2 + ...)` は元仕様§4.4 のまま維持 (パース規則は変更しない)。
- ただし **「`shugo` は集合専用 / `fumei` は不明専用」** といったドメイン語の特別扱いは Go 側にも TS 側にも一切持たない。`fumei` はただの単一タグ、`shugo (...)` はただの「主 `shugo` + 補助タグ群」として扱われる。
- 未分類は `Folder == ""` (空文字) で表現。仕様書§4.5 のルールを踏襲。
- v2 で `Tags []string` のような完全自由形式に再設計する余地は残すが、本フェーズでは行わない (互換性維持のため)。

### 3.4 `internal/classification/repository.go`

#### 3.4.1 メタデータ保存方針 (重要)

本書では以下を厳格に守る:

- **正本は `_classification.json` のみ**。アプリの保存・編集は常に JSON に対して行う。
- **`_classification.csv` は「初回 import 専用」**。JSON が無いフォルダで CSV があれば、Load 時に内部 JSON 形式へ変換して返すが、保存時に CSV を更新することはしない。一度ユーザーが何かを保存して `_classification.json` が生成されたら、以降 CSV は無視され続ける (古いまま残置 OK、削除はアプリからは行わない)。
- AI / 外部エディタが直接 JSON を編集する想定 → **JSON ファイルは人間にも読みやすい整形** (`MarshalIndent("", "  ")`) を保つ。

#### 3.4.2 インターフェース

`SidecarRepository` インターフェース:
- `Load(folderPath string) (LoadOutput, error)`: JSON 優先、次 CSV、なければ `Source="none"` で no-error
- `SaveJSON(folderPath, c, expectedMtime) (int64, error)`: `expectedMtime > 0` のとき mtime 比較 → 不一致で `ErrConflict`。成功で新 mtime 返却。書き込み手順は `.bak` コピー → `.tmp` 書き → `os.Rename`。

定数: `sidecarJSON="_classification.json"` / `sidecarCSV="_classification.csv"` / `backupJSON=...bak` / `tempJSON=...tmp`

エラー値: `ErrConflict` / `ErrAlreadyExists`

see `internal/classification/repository.go`

#### 3.4.3 実装上の注意

- CSV は `encoding/csv` を使い、BOM (`﻿`) を読み飛ばす。
- ヘッダ行は `filename, proposed_folder, confidence, note` を期待。順序が異なる場合はヘッダ名でカラムを解釈する。CSV の `proposed_folder` は内部モデルの `Folder` にマップ。
- JSON 出力は `json.MarshalIndent(c, "", "  ")` (BOM なし、UTF-8、末尾改行 1 つ)。
- 読み込み時に `Entries` 内に重複 `filename` があれば `error` を返す (元仕様§4.5 の整合性ルール)。CSV → JSON 変換でも同じ。
- `SaveJSON` は `os.Rename` 失敗時に通常上書きへフォールバックしない。`.bak` が直前に残っているため、ユーザー手動復旧が可能。フォールバックの正当性が低い (§15 のリスク表で「ネットワークドライブ」のリスクは記載するが、対策は v1 では `.bak` 復旧手段提供のみ)。
- 競合検出の mtime 取得は `os.Stat(...).ModTime().UnixNano()` を使う。ファイルシステムによって精度が秒単位の場合があるが、人間や AI による編集間隔と比較すれば十分検知できる。

### 3.5 `internal/classification/scanner.go`

`FileScanner.ListImageFiles(folderPath string) ([]string, error)`: フォルダ直下を `os.ReadDir + imgfile.IsImage` でフィルタし basename のみ返す。サブフォルダは走査しない。

see `internal/classification/scanner.go`

### 3.6 `internal/classification/service.go`

`Service` API: `Load(folderPath) (*LoadResult, error)` / `Save(folderPath, entries, expectedMtime) (int64, error)` / `UpdateEntry(folderPath, entry, expectedMtime) (int64, error)` / `CreateEmpty(folderPath) (int64, error)`。競合検出は全メソッドで `expectedMtime > 0` 時に実施。成功時は新しい mtime を返す。

see `internal/classification/service.go`

`Load` のマージ規則 (元仕様§6.2.5 の再掲):

1. リポジトリから既存サイドカーを読む (なければ `nil`)。
2. スキャナでフォルダ内の全画像を取る。
3. 画像にあるが `Entries` にない → folder/conf/note 空の Entry を末尾に追加。
4. `Entries` にあるが画像にない → `Orphans` に分離。
5. `Entries` の順序は「サイドカー記載順 + 末尾に新規追加」を保つ。

`UpdateEntry` の競合検出フロー:

```
フロント:                      Go Service:                         JSON ファイル:
  保存ボタン押下                   ─────────►
                                Load (現在の mtime を取得 m_now) ─►  読む
                                                                    mtime = m_now
                                m_now != expectedMtime ?
                                  Yes → ErrConflict 返却 ◄────
                                  No → entries を patch
                                       Save (expectedMtime=m_now) ► 書く
                                                                    mtime = m_new
                                m_new を返却 ◄─────────────────
  LoadResult.Mtime を更新
```

これにより、AI / 外部エディタが JSON を書き換えてからアプリが保存しようとすると、**書き換えを検知してダイアログを出せる**。逆に外部編集が無いケースでは通常通り保存される。

### 3.7 `app.go` 追加バインディング

IPC: `LoadClassification(folderPath)`, `SaveClassification(folderPath, entries, expectedMtime)`, `UpdateClassificationEntry(folderPath, entry, expectedMtime)`, `CreateEmptyClassification(folderPath)`。競合時は `"CONFLICT:"` プレフィックス付きエラーを返し、フロントは `e.message.startsWith("CONFLICT:")` で判定する。`ListDirectory` / `internal/tree` は左ペイン廃止に伴い削除。

see `app.go`

### 3.8 `internal/state` の v2 化

`StateSchemaVersion = 2`。`StateData` に `TopTab string` ("list"|"viewer") と `ListTabState{FolderPath, Filter{Tags, Confidence, Query}}` を追加。`RootPath` / `LeftPaneWidth` は後方互換のため残置。v1 state.json は Version 不一致でデフォルト fallback (マイグレーションなし)。

see `internal/state/state.go`

---

## 4. フロント側設計

### 4.1 ファイル構成

```
frontend/src/
├── App.tsx                      # 全面書き換え (左ペイン削除 + TopTabs 導入)
├── App.css                      # 左ペイン関連 CSS 削除 + TopTabs / ClassificationView CSS 追加
├── features/
│   ├── folder-tree/             # 削除
│   ├── viewer-grid/             # 既存 (変更なし)
│   ├── session/                 # 既存 + ListTabState 対応で軽微更新
│   └── classification/          # 新規 (元仕様 §6.3.1 を簡略化)
│       ├── ClassificationView.tsx  # 一覧タブのトップ (header + chips + grid + lightbox + edit popover を統括)
│       ├── ClassificationHeader.tsx # フォルダ選択 + 件数表示
│       ├── TagChips.tsx
│       ├── ConfidenceSegment.tsx
│       ├── SearchBox.tsx
│       ├── ClassificationGrid.tsx
│       ├── Card.tsx
│       ├── EditPopover.tsx
│       ├── Lightbox.tsx
│       ├── filters.ts            # extractTags / tagSummary / applyFilter (純関数)
│       ├── filters.test.ts       # § 11 のテスト対象
│       ├── colors.ts             # tagColor (汎用配色 + ハッシュフォールバック)
│       ├── colors.test.ts        # 既知タグ / 未知タグ / 空文字 のテスト
│       ├── defaultPalette.ts     # サンプル提供のキャラ名→色マップ (差し替え可能)
│       └── useClassification.ts  # 状態管理 (loadResult / filter / editing 等)
                                  # ※ Phase 4 後の #66 (PR #81) で責務別に
                                  # 8 つの子フックに分割済み (useClassification{Filter,
                                  # Selection,Load,Watcher,Replay,Edit,Merge,
                                  # Delete}.ts)。公開 API は変更なし。詳細は
                                  # docs/spec-classification-hook-refactor.md
└── shared/
    ├── components/
    │   └── ConflictDialog.tsx    # 新規: 3 択 (再読み込み/強制上書き/キャンセル)
    └── icons/
        ├── EditIcon.tsx          # 新規: 編集ペンアイコン (SVG 直書き)
        ├── ReloadIcon.tsx        # 新規: 再読み込みアイコン
        └── SearchIcon.tsx        # 新規: 検索アイコン (任意)
```

### 4.2 トップレベルタブ (`App.tsx`)

`topTab: "list" | "viewer"` で条件レンダリング。`useClassification` / `useViewerGrid` を App スコープで持つ。`useSessionSave` に `topTab` と `list: classification.persistableState` を渡す。

see `frontend/src/App.tsx`

レンダリング戦略は **`display: none` 切替ではなく、条件レンダリング (アンマウント)** とする。理由:

- ビューアタブ側の `Tab` は Phase 3c で `initialized` フラグを持ち、再 mount 時に必要なら ReadImage を再呼び出す設計。アンマウント → リマウントしても表示状態は維持される (zoom / pan は state 経由で復元される)。
- 一覧タブ側のアンマウント時に `loadResult` が消えるとフォルダ切替時に都度 `LoadClassification` が走る。**`useClassification` は App スコープで `useState` を維持する** ことでアンマウントされても state が保持される (hook を `App.tsx` で持つ)。
- パフォーマンス: 1 万件サムネを抱えたまま隠すよりはアンマウントする方がメモリ的に安全。サムネ画像は `IntersectionObserver` で画面外にあれば未ロード、再 mount 時に観測再開すれば良い。

### 4.3 ライトボックス内の folder 視覚化 (v1.1 で廃止)

> v1.1 でライトボックスごと廃止 (§5.11 ビューアタブ連携に置換)。詳細設計は `git log` 参照。

### 4.4 `useClassification` (状態管理)

状態: `folderPath`, `loadResult` (mtime 含む), `filter` {tags/confidence/query}, `loading`, `error`, `lightbox`, `editing`。公開 API: `openFolder / reload / setFilter / openLightbox+closeLightbox+nextLightbox+prevLightbox / openEdit+closeEdit+saveEdit / createEmptySidecar`。`saveEdit` は `UpdateClassificationEntry(folderPath, entry, loadResult.mtime)` を呼び、成功で mtime 更新・`CONFLICT:` プレフィックスで競合ダイアログを起動する。`reload` は同 `folderPath` で LoadClassification を再呼出しし、フィルタ状態は維持する。

see `frontend/src/features/classification/useClassification.ts`

### 4.5 サムネ取得方針 (元仕様§6.3.5 への回答)

**既存 `App.GetThumbnail(path, size, mode)` を流用する**。以下の理由:

- 既存 Phase 2 でサムネ生成 + ディスクキャッシュ + worker pool が完成しており、フロントから `[]byte` (Wails が base64 化) を受け取って Blob URL 化する実装が `useThumbnail.ts` (folder-tree 内) にある。folder-tree は削除するが、ロジックは新 hook `useGridThumbnail.ts` (classification 内) に移植する。
- サイズは **256px** / モードは **`letterbox`** で固定 (元仕様§5.3 「aspect 1:1 / object-fit: contain」と整合)。Phase H の設定 UI が出来たら設定値に置き換える。
- IntersectionObserver で **viewport 内に入ったときだけ** `GetThumbnail` を呼ぶ。一度ロードしたものは hook 内 Map にキャッシュ (path → blob URL)。アンマウント時に `URL.revokeObjectURL` でクリーンアップ。
- カード内の `<img>` は `loading="lazy"` も併用 (二重で OK、ブラウザネイティブと IntersectionObserver の冗長は問題ない)。

### 4.6 元画像参照 (v1.1 で廃止)

> v1.1 でライトボックスごと廃止。原寸表示はビューアタブの `ImageView.tsx` に一本化された。

### 4.7 セッション永続化への組み込み

`useSessionSave` の input に `topTab` と `list: { folderPath, filter }` を追加。`buildStateData` が対応 `StateData` フィールドに詰める。`useSessionLoad` 側変更不要。

see `frontend/src/features/classification/useClassification.ts` / `useSessionSave.ts`

### 4.8 配色 (`colors.ts` + `defaultPalette.ts`) — 汎用化

#### 4.8.1 設計

サンプル ([docs/new_thumbnail/sample.html:396](new_thumbnail/sample.html#L396)) の `folderClass` のような **ドメイン特有の特別扱い** (`startsWith("shugo")` / `=== "fumei"`) は **完全に廃止する**。

代わりに以下の純粋なロジックで色を決める:

- `tagColor(tag)`: 空文字 → `var(--unclassified)`、既知タグ → `KNOWN_TAG_COLORS` マップ、未知 → FNV-1a 32bit ハッシュで 16 色 `HASH_PALETTE` からインデックス
- `readableTextColor(bgHex)`: WCAG 準拠の輝度計算で `"#fff"` か `"#222"` を返す
- `DEFAULT_PALETTE`: サンプルキャラ名 → 色マップ。Phase H でユーザー設定に置換可能

see `frontend/src/features/classification/colors.ts` / `defaultPalette.ts`

#### 4.8.2 信頼度バッジの色

信頼度 (`high` / `mid` / `low`) は **配色マップから独立** で、CSS 変数 `--conf-high` / `--conf-mid` / `--conf-low` (元仕様§7.2 の値) を使う。これは「サンプル依存ではなく汎用的な意味色」なので固定で問題ない。

#### 4.8.3 既知タグマップの上書きについて (将来)

Phase H で `settings.json` に `tagColors` セクションを追加し、起動時に `KNOWN_TAG_COLORS` を上書きする想定。本フェーズでは API は用意せず、ハードコードされた `defaultPalette.ts` の値を使う。

### 4.9 再読み込み機能 (`ClassificationHeader.tsx`)

「一覧」タブのヘッダ右側に **「再読み込み」ボタン** を配置する。クリックで `useClassification.reload()` を呼ぶ。

UI:

```
[フォルダを開く]  C:\path\to\folder        [件数: 123 / 155]  [↻ 再読み込み]
```

- アイコンは SVG 直書き (`shared/icons/ReloadIcon.tsx`)。
- フォルダ未選択時は disabled。
- `reload` 中はスピナー表示 (ボタンは disabled)。
- 成功でトースト不要。失敗は通常のエラートースト。

### 4.10 競合検出ダイアログ

`saveEdit` / `Save` で `CONFLICT:` プレフィックスのエラーが返ったとき、`shared/components/ConfirmDialog.tsx` ベースの **3 択ダイアログ** を出す:

```
┌──────────────────────────────────────────────────────┐
│ ⚠ 外部編集を検出しました                               │
│                                                      │
│ このファイルを開いてからの間に、別のプロセス (AI ツール  │
│ やテキストエディタ) が _classification.json を編集    │
│ しました。                                            │
│                                                      │
│ どうしますか?                                          │
│                                                      │
│   [再読み込み (推奨)]  [強制上書き]  [キャンセル]       │
└──────────────────────────────────────────────────────┘
```

選択肢の挙動:
- **再読み込み (推奨)**: `reload()` を呼んで最新 JSON を読み込む。アプリ内の編集中の変更は破棄される (ユーザー意図的に選んだので警告のみ)。
- **強制上書き**: `expectedMtime=0` で `App.UpdateClassificationEntry` を再呼出 (mtime チェックを skip)。外部編集分は失われる。
- **キャンセル**: 何もしない。ポップオーバーは開いたまま。ユーザーが手動でコピーするなど対処できる。

実装メモ: 既存の `ConfirmDialog` は 2 択 (はい/いいえ) なので、本フェーズで 3 択対応の `useConflictDialog` を追加するか、`ConfirmDialog` を多択化する。本書では `shared/components/ConflictDialog.tsx` を新設する方針 (既存の 2 択 dialog はそのまま)。

### 4.11 削除する箇所

| ファイル / 箇所 | 削除理由 |
|---|---|
| [frontend/src/features/folder-tree/](../frontend/src/features/folder-tree/) (フォルダ全体) | 左ペイン廃止 |
| [App.tsx](../frontend/src/App.tsx) の左ペイン / Splitter / `leftWidth` 関連 | 同上 |
| [App.css](../frontend/src/App.css) の `.app` (2 ペイン Flexbox), `.pane.left`, `.splitter` 関連 | 同上 |
| `internal/tree/` のうち `List`, `tree_unix.go`, `tree_windows.go`, それらのテスト | 左ペイン廃止 + ディレクトリ列挙 API 不要 |
| `app.go` の `ListDirectory` メソッド | 上に同じ |
| 自動生成 `wailsjs/go/main/App.d.ts` の `ListDirectory` | 再生成で消える |

`tree.IsImage` だけは新パッケージ `internal/imgfile/IsImage` に **移設** する (削除ではない)。

---

## 5. 機能要件 (元仕様の再掲 + 本書独自)

元仕様§5 をそのまま採用する。差分のみ列挙:

### 5.1 タブ統合 → トップレベルタブ化 (本書差分)

- アプリ全体に「一覧」「ビューア」のトップレベルタブを設ける。
- 起動直後はセッション復元値に従う。初回起動 (state.json なし) では「一覧」がアクティブ。
- 「一覧」タブ内には元仕様§5.1 の機能 (フォルダ選択 / サイドカー有無判定 / 新規作成ダイアログ) を持つが、**「タブ自体のグレーアウト」は廃止する** (タブが常時 2 枚しかなく、一覧タブが無効化されるとアプリの入口がなくなるため)。代わりに「一覧」タブの中身として「フォルダを開く」ボタンが常に表示され、フォルダ未選択時は空ステート画面を出す。

### 5.2 メタデータ読み込み (元仕様§5.2 のまま)

- `LoadClassification` で取得。エラーはトーストで表示し、空ステート画面に戻す (§9 のエラー方針に従う)。

### 5.3 グリッド表示 (元仕様§5.3 のまま)

仮想スクロールは v1 では未実装。1 万件で初回描画 1.5 秒以内 (元仕様§10) は IntersectionObserver による画像遅延ロードで達成見込み (DOM 自体の生成はカードあたり軽量に保つ)。

### 5.7 編集 (元仕様§5.7 + 本書差分: 競合検出)

元仕様§5.7 の挙動を踏襲。**追加**:

- 保存時に外部編集との競合を検出する (本書§4.10 / §3.6)。
- 競合時はモーダル「外部編集を検出しました」を出し、「再読み込み」「強制上書き」「キャンセル」から選ばせる。
- 楽観的 UI 更新は元仕様通り行わない。

### 5.11 ビューアタブ連携 (v1.1 新設、§5.8 ライトボックスを置換)

- カードのサムネクリックで、`useViewerGrid.openInActive(folderPath + "/" + filename)` を呼び、ビューアタブのアクティブパネルに該当画像をタブとして開く。
- 同時にトップタブを `viewer` に自動切替する (`setTopTab("viewer")`)。
- 既に同パスのタブがアクティブパネル内にあれば、そのタブにフォーカスするのみ (新規タブを作らない、todo.md E2 と同じ)。
- 大画像 (200MP 超) / 読み込み失敗時のエラー処理は `openInActive` 内のトーストロジックを流用。
- 一覧側に画像表示用の独自コンポーネントは持たない (`Lightbox.tsx` は削除)。
- 連続レビュー (`←/→` で filteredEntries を辿る) は v1 では持たない。Phase H 以降でビューア側にショートカットを足す形で再検討する。

### 5.10 再読み込み (本書独自)

- ヘッダの「再読み込み」ボタンクリックで `LoadClassification` を再実行する。
- AI / 外部エディタが JSON を編集した直後にユーザーが手動で反映できる。
- 自動ファイル監視 (`fsnotify`) は v1 では実装しない (§13 スコープ外)。
- 編集中に再読み込みすると編集中のローカル変更は失われる。これはユーザー操作なので警告のみ (将来的に「未保存があります」確認を追加してもよいが本フェーズでは不要)。

---

## 6. UI 仕様

元仕様§7 のレイアウトを「一覧」タブの中身として配置する。配色 (元仕様§7.2) は CSS 変数で `App.css` または `features/classification/style.css` に定義。

### 6.1 トップタブバーのスタイル

- 高さ 36px、背景はダーク系 (App.css の既存配色に合わせる)
- アクティブタブは下線 + テキスト白、非アクティブはグレー
- タブクリックでフォーカスリング (キーボード操作のため)
- キーボードショートカット: `Ctrl+1` で一覧、`Ctrl+2` でビューア (任意、Phase H で広いショートカット体系を入れる予定なので **v1 では未実装**)

### 6.2 「一覧」タブ未選択時 (フォルダ未指定) の空ステート

```
┌─────────────────────────────────────────────────┐
│                                                 │
│                                                 │
│             📁 (大きな folder アイコン)           │
│                                                 │
│        分類対象のフォルダを選択してください       │
│                                                 │
│           [ フォルダを開く ]                     │
│                                                 │
└─────────────────────────────────────────────────┘
```

---

## 7. 永続化スキーマ (state.json v2)

### 7.1 ファイル

`os.UserConfigDir()/image-observer/state.json` (Phase 3c から場所変更なし)。

### 7.2 v2 スキーマ全体 (Go)

`StateData` に `TopTab` / `ListTabState` を追加した v2 スキーマ。§3.8 を参照。Phase 5 以降は state v6 まで更新済み (現行スキーマは `internal/state/state.go`)。

### 7.3 マイグレーション

v1 → v2 のマイグレーションは **行わない**。`Version != 2` で `DefaultData()` フォールバック (Phase 3c 既存挙動と同じ)。これにより、既存の v1 state.json を持つユーザーは「ウィンドウ位置 / グリッド / タブ」が一度初期化される。Phase 3c 完了直後の本フェーズなので影響範囲は小さい (開発者のみ)。

---

## 8. ファイル仕様 (元仕様§8 を踏襲 + 本書差分)

### 8.1 正本 / 互換

- **正本**: `_classification.json`。アプリの読み書き・AI / 手動編集の対象はこれ一本。
- **互換 (初回 import 専用)**: `_classification.csv`。JSON が無いフォルダで Load されたとき、内部形式に変換して使う。**保存時に CSV を更新することはしない**。一度ユーザーが何か保存して JSON が生成されると、以降 CSV は無視される。古い CSV はアプリからは削除しない (ユーザーが手動で削除する想定)。

### 8.2 JSON フォーマット

- `MarshalIndent("", "  ")` (BOM なし、UTF-8、2 スペースインデント、末尾改行 1 つ)。
- 人間 / AI が読み書きしやすい形式を保つ (フィールド順序は struct 定義順)。

### 8.3 バックアップ + 競合検出

- 保存フロー: 既存 `.json` を `.bak` にコピー → `.tmp` に書き → `os.Rename(.tmp, .json)`。
- 既存 `.bak` は上書き OK (1 世代のみ保持)。
- 保存直前に `expectedMtime` と現在のディスク mtime を比較。不一致なら競合エラーで中止 (`.bak` も `.tmp` も生成しない)。

---

## 9. エラーハンドリング (元仕様§9 を踏襲 + 本書差分)

| ケース | 振る舞い |
|---|---|
| サイドカー不在 | フォルダ選択直後にダイアログ「サイドカーがありません。新規作成しますか?」。「はい」で `CreateEmptyClassification` → 再 `LoadClassification`。「いいえ」で空ステートに戻る (元仕様§5.9 を踏襲、ただし「タブグレーアウト」は廃止) |
| JSON パース失敗 | トーストでエラーメッセージ表示、空ステートに戻す。本書ではモーダル禁止 (Phase 3c のエラー UX とトーストで統一) |
| CSV ヘッダ不正 | 同上 |
| 同一 filename 重複 | 同上 |
| フォルダ走査失敗 | 同上 |
| 保存失敗 (一般) | トースト「保存に失敗しました: <reason>」。編集ポップオーバーは開いたままにし、再試行可能な状態に戻す。表示の楽観更新はしないので UI ロールバック処理は不要 |
| **保存時の競合検出** | 本書§4.10 のダイアログを表示 (再読み込み / 強制上書き / キャンセル)。`error.message` が `"CONFLICT:"` で始まることで判別 |
| 大量読み込み中 | フォルダ選択直後に「読み込み中…」スピナーを表示。完了で消す |
| **再読み込み中** | ヘッダの ↻ ボタンを disabled + スピナー化。完了で復帰 |

---

## 10. 非機能要件

- 元仕様§10 を踏襲 (1 万件 / メモリ 500MB / UTF-8 / 日本語ファイル名対応)。
- 仮想スクロールは v1 未実装 (元仕様§10 既定)。
- 画像遅延ロードは IntersectionObserver 必須 (元仕様§10 既定)。

---

## 11. テスト

### 11.1 Go 側

- `internal/classification/repository_test.go`:
  - JSON 読み書きラウンドトリップ + Mtime が更新されること
  - CSV 読み込み (BOM あり/なし、ヘッダ順入替)
  - 重複 filename 検出
  - `os.Rename` フォールバック挙動
  - **競合検出**: `expectedMtime` 不一致で `ErrConflict` が返り、`.bak` も `.tmp` も作られないこと
  - **競合検出 (`expectedMtime=0`)**: 既存ファイルがあっても上書きされること (強制上書きのため)
- `internal/classification/scanner_test.go`: `t.TempDir()` で実ファイルを置き、画像拡張子のみが返ることを確認。
- `internal/classification/service_test.go`:
  - マージ規則 (未分類追加 / Orphan 分離 / 順序保持) のテスト
  - `UpdateEntry` が既存を置換し新規を末尾追加することのテスト
  - **競合検出**: `UpdateEntry` の `expectedMtime` が古ければ `ErrConflict` を返すこと
- `internal/imgfile/imgfile_test.go`: `tree_test.go` から `IsImage` 関連を移植。
- `internal/state/state_test.go`: v2 への version up に伴い v1 state.json 読み込みでデフォルトに落ちることを確認するケースを追加。

### 11.2 フロント側

- `features/classification/filters.test.ts`: 元仕様§4.4 の例 (`iroha` / `shugo (iroha + kaguya)` / `shugo (iroha + kaguya + yachiyo)` / `fumei`) に加えて、**サンプル外** (`cat (kuro + shiro)` / `landscape` / 空文字) で `extractTags` が期待値を返すこと。`applyFilter` が tags OR / confidence / query で正しく絞り込めること。
- `features/classification/colors.test.ts`:
  - 既知タグ (`iroha` 等) → `DEFAULT_PALETTE` の値を返す
  - 未知タグ (`cat` / `landscape` / `任意の文字列`) → `HASH_PALETTE` のいずれかを返し、**同じ入力に対して常に同じ色を返す** (決定性のテスト)
  - 空文字 → `var(--unclassified)` を返す
  - 別の異なる入力を 50 件ほど投げ、衝突分布が極端に偏らないこと (簡易ヒストグラム検証)
- それ以外のフロント単体テストは本フェーズではスコープ外 (Phase J で全面導入の方針)。`wails dev` で目視確認する。

---

## 12. 受け入れ基準 (実装完了)

Phase 4 実装済み (`go test ./...` + `wails build` + `tsc --noEmit` + vitest 全通過、
PR #76 での実機確認含む)。詳細な DoD チェックリストは PR 説明 / git log を参照。


## 13. スコープ外 (Phase 4 では作らない)

### 13.1 タブ間連携 / UI

- **(v1.1 で実装済み)** サムネクリックでビューアタブを自動アクティブ化 → スコープ内に移動。逆方向 (ビューアで開いたタブを一覧側で強調表示等) は依然スコープ外、Phase 5+ で追加検討。
- ビューア側からの **連続レビュー** (`←/→` で一覧の filteredEntries を辿る) — Phase H 以降。
- 仮想スクロール (`react-window` 等) — 元仕様§10 既定通り未実装。1 万件超えで体感悪化したら導入。
- 一括編集 / 複数選択 (元仕様§2.2 既定通り)。
- ソート機能 (元仕様§2.2 既定通り)。
- AI 自動分類 (元仕様§2.2 既定通り)。
- キーボードショートカット (`Ctrl+1` / `Ctrl+2` 等) — Phase H。
- 設定 UI (サムネサイズ / mode 等の変更) — Phase H。

### 13.2 外部編集サポートの拡張

- **ファイル監視 (`fsnotify`) による自動リロード**。本フェーズでは「手動リロードボタン」のみ。プラットフォーム差異 / デバウンス / 複数イベント発火の取り回しが重く、Phase 5+ で検討。
- **JSON エクスポート** (フィルタ後の Entries だけを別 JSON に出力。AI 入力データ作成用)。Phase 5+。
- **JSON インポート / マージ** (外部生成された JSON を現在のサイドカーとマージ。LLM が大量に分類した結果を取り込む等)。Phase 5+。手動の場合はファイル自体を差し替えて再読み込みすれば足りる。
- **CSV エクスポート** (元仕様§4.1 で v1 スコープ外)。Phase 5+ で検討。

### 13.3 汎用化のさらなる発展 (レベル 2 以上)

- **データ型の自由形式化**: 現状は `Folder` 文字列ベースだが、`Tags []string` のような完全配列形式へのマイグレーション。Phase 5+ で検討するが破壊的変更になるため慎重に。
- **配色のユーザーカスタマイズ UI**: `defaultPalette.ts` の値を Phase H の `settings.json` で上書き可能に。本フェーズでは API のみ用意せず、ハードコードのみ。
- **マルチドメインのテンプレート**: フォルダごとに「タグセット定義 + 配色」を JSON で同梱できる仕組み。Phase 5+。
- **タグ正規化 / 曖昧マッチ** (元仕様§12 既定通り。例: 大文字小文字の同一視、表記ゆれの統合)。Phase 5+。

---


## 15. リスクと留意点

| リスク | 対策 |
|---|---|
| state.json v1 → v2 の互換性 | マイグレーションせずデフォルトに落とす方針で割り切る (Phase 3c 完了直後の影響範囲は開発機のみ) |
| `internal/tree` 削除に伴う他パッケージへの影響 | `IsImage` を `imgfile` に移設してから tree を削る。各テストで先に通過確認 |
| トップレベルタブ切替時の状態消失 | `useClassification` を `App.tsx` で持ちアンマウントしないようにする (本書§4.2 の戦略) |
| 1 万件のサムネで OOM | IntersectionObserver で viewport 外は未ロード、Map キャッシュは `URL.revokeObjectURL` でアンマウント時に解放。さらに上限が必要なら Phase H で LRU 化 |
| ファイルシステムの mtime 精度差 (秒単位など) で競合検出が誤検知 / 見落とし | 人間 / AI の編集間隔 (数秒〜分単位) と比較すれば実害なし。秒単位精度でも保存と保存の間に外部編集があれば mtime は確実にズレる。ナノ秒精度のシステムで「同一秒内の連打保存」が起きる場合のみ取りこぼす可能性があるが、その時はフロント側で連打防止 (debounce) で吸収済み |
| ネットワークドライブで mtime が嘘をつく (キャッシュ) | リスクは認識するが対策は Phase 5+。現状ローカルディスク前提 |
| 強制上書き選択時の外部編集の損失 | ユーザーが明示的に選んでいるため警告のみ。`.bak` には書き換え直前の内容が残るので最後の手段で復旧可 |
| 配色のハッシュ衝突で異なるタグが同色になる | 16 色プールなので確率的には 1/16 で衝突。同一ビュー内に並ぶ複合分類で見分けがつかなくなった場合、ユーザーは Phase H の `defaultPalette.ts` 上書きで対処できる |

---

## 16. 参考

- 元仕様: [docs/new_thumbnail.md](new_thumbnail.md)
- 参考 HTML: [docs/new_thumbnail/sample.html](new_thumbnail/sample.html)
- 参考 CSV: [docs/new_thumbnail/sample.csv](new_thumbnail/sample.csv)
- Phase 3c 仕様 (state.json v1): [docs/spec-tab-imageview-3c.md](spec-tab-imageview-3c.md)
- Phase 2 サムネ仕様: [docs/spec-thumbnail.md](spec-thumbnail.md)

---

## 17. 用語集 (本書での再定義)

元仕様§13 の「集合 (shugo)」「不明 (fumei)」のようなドメイン語の用語集は **本書では採用しない**。汎用化のため以下を採用する:

| 用語 | 定義 |
|---|---|
| サイドカー | 画像本体に紐付けて同じフォルダに置かれるメタデータファイル (`_classification.json` または `_classification.csv`)。本書の正本は前者 |
| エントリ | 1 画像に対応する 1 分類レコード (`Entry`) |
| 主タグ | `Folder` 文字列の `(` 以前の部分。`Folder = "iroha"` なら `iroha`、`Folder = "shugo (a + b)"` なら `shugo` |
| 補助タグ | `Folder` 文字列の `(...)` 内を `+` で split したもの。元仕様§4.4 のアルゴリズムで抽出 |
| 抽出タグ (タグ) | 主タグ + 補助タグ (重複除去後)。フィルタ・配色の単位 |
| 複合分類 | `主 (sub + sub)` 形式の Folder 文字列。元仕様で「集合 (shugo)」と呼ばれていたものを汎用化したもの。`shugo` は単に「複合分類でよく使われるサンプル上の主タグ名」にすぎない |
| 単一タグ | 補助タグなしの Folder 文字列。`fumei` も単一タグの一例。本書ではドメイン特有の意味を持たせない |
| 未分類 | `Folder == ""` (空文字) のエントリ。サイドカーに記載がない実ファイルや、ユーザーが意図的に空文字にしたエントリ |
| 孤立エントリ | サイドカーには記載があるが画像フォルダに実体がないエントリ (`Orphans`) |
| 既知タグ | `defaultPalette.ts` に色定義があるタグ |
| 未知タグ | 既知タグ以外。色は決定的ハッシュで自動割当 (§4.8) |
| 競合 | `expectedMtime` と現在のディスク上の `_classification.json` の mtime が一致しないこと。外部 (AI / エディタ) による書き換えを示す |
