# image-observer プロジェクトコンテキスト

新規セッションで Claude が最初に読むファイル。[CLAUDE.md](../CLAUDE.md) (一次ルール) → このファイル → 必要に応じて [init.md](../init.md) / [docs/todo.md](../docs/todo.md) / [docs/spec-*.md](../docs/) の順に参照する。

---

## 1. 一行説明

Wails v2 (Go + React/TS) で実装する Windows 向け画像ビューア。フォルダ単位の分類グリッド (タグ / 信頼度 / 検索) と複数ビューア (BSP 分割) を組み合わせ、大量画像の振り分け / 比較に特化 (1 人開発、VSCode に欠けている機能を補う動機)。

## 2. 現在地

機能の現状 (詳細は §3 のドキュメント表を参照):

- **一覧 (分類) タブ**: サイドカー (`_classification.json` 正本 + `.csv` 初回 import) ベース。タグチップ (「未分類」チップで未付与のみ絞り込み, #116) / 信頼度 / 検索 / サブディレクトリ別アコーディオン / プレビュー + 編集を 1 画面化した SampleModal (#93) / 競合検出 / 子→親マージ / 複数選択 + バルクオープン / Card 右クリックメニュー / fsnotify による silent auto-merge / キーボード操作 (カードを矢印キーで 2D 移動 + プレビューで `t`/`c`/`n` で各編集欄にフォーカス, #115)
- **ビューア (複数対応)**: 複数ビューア (リネーム + クロス DnD) × BSP ツリー (任意分割、上限 16 パネル) × タブ (DnD 並び替え / 分割発生 / 閉じる) × 画像 (ズーム / パン / ResizeObserver 追従) × キーバインド (`Ctrl+W` / `Ctrl+Tab` / `Ctrl+0` / `Ctrl+1` / `Ctrl+±` / `Ctrl+Shift+1..9`)
- **設定 UI**: ログ / 一覧 (multi-select mode) / ビューア (画像上限 / wheel mode) / サムネイル (size / mode / worker) / タグ色 / 外観 (UI scale) / フォルダ自動監視 / ショートカット一覧
- **永続化**: `state.json` (schema v6, 複数ビューア対応、v5→v6 ロスレス昇格) + `settings.json` (schema v1, additive 拡張 + per-field fallback)
- **インフラ**: ファイルベースロガー (env / file / API で level 切替 + 2MB × 3 ローテ) + Wails IPC レイヤ + atomic write 全般
- **画像削除**: Card 右クリック → ゴミ箱送り (Windows `SHFileOperationW`, 非 Windows は `os.Remove` フォールバック)
- **CI**: ubuntu-latest 上で `go test` + vitest + `tsc --noEmit` を pull_request トリガで実行 (`wails build` は CI で呼ばない)。Windows ビルド + portable/NSIS 配布は `v*` tag 押下時の `release.yml`

残作業は **`gh issue list --state open` を一次ソースとする** (AGENTS.md A-1 拡張: 長寿命ドキュメントに残タスクを列挙すると陳腐化する)。

## 3. 重要ドキュメント

| ファイル | 役割 |
|----------|------|
| [init.md](../init.md) | 元の要求 / 要件 / スコープ (R1〜R7 / F1〜F10 / N1〜N5)。**変更しない** |
| [docs/todo.md](../docs/todo.md) | 実装着手前の方針決定ログ (A〜J カテゴリ) |
| [docs/spec-*.md](../docs/) | 各フェーズ / issue の実装仕様書 (改訂履歴 + DoD + 決定事項) |
| [AGENTS.md](../AGENTS.md) | レビューで繰り返し指摘されたパターン集約。PR 作成前に **H 章を必ず通読** |
| [CLAUDE.md](../CLAUDE.md) | 一次ソース優先順位 + クイックリファレンス |
| [README.md](../README.md) | ユーザー向けの環境要件 / `wails dev` / `wails build` 手順 |

## 4. 確定済みの方針 (要点抜粋)

詳細は [docs/todo.md](../docs/todo.md) を参照。実装で頻繁に参照する要点だけ。

### A. データ / API 設計
- **画像配信**: Go バインディング経由で `[]byte` を返す (Wails が自動 base64 化)。サムネ・原寸とも同方式。AssetServer は使わない
- **型定義**: Go binding は Wails 自動生成 (`wailsjs/go/...`) を一次ソース。EventsEmit payload など自動生成されない型のみ TS 側で hand-mirror (`watcherPolicy.ChangedPayload` 等、docstring で Go 側 struct と紐付け)
- **パス**: 全レイヤで絶対パス統一

### B〜D. フォルダツリー / サムネイル / キャッシュ
- 並び順: 名前昇順 (case-insensitive)、隠しファイル / 隠しディレクトリ非表示、**シンボリックリンクは追跡しない** (classification scanner / watcher 共通、Lstat ベース)
- サムネ既定: 256px / 2× (HiDPI) / レターボックス / `runtime.NumCPU()/2` ワーカー、選択肢 128/192/256/384/512
- キャッシュ: `os.UserCacheDir()/image-observer/cache/thumbnails/<mode>/<size>/<2>/<30>.<ext>`、`sha256(path+mtime+size)` ベース、mtime/size 不一致で別キー (旧キーは孤児として残置)

### E〜J
- 各フェーズ着手時に [docs/todo.md](../docs/todo.md) で詰める

## 5. 技術スタック (固定)

| レイヤ | 採用 | 備考 |
|--------|------|-----|
| デスクトップ | Wails v2 | v2.12.0 |
| Go | toolchain: `goenv global` (= CI `GO_VERSION`) / language min: `go.mod` | `.go-version` は置かない (バージョン値は `go.mod` / `.github/workflows/ci.yml` を一次ソースに) |
| フロント | React + TypeScript + Vite | バージョンは `frontend/package.json` を一次ソースに (drift 回避のため固定値を書かない) |
| FE 状態管理 | React 標準 hook のみ | 外部ライブラリ未導入 |
| アイコン | インライン SVG | 外部依存なし |
| 画像デコード | `golang.org/x/image/{webp,draw}` | Phase 2 で導入 |
| WebP エンコード | 不採用 (PNG フォールバック) | cgo 依存回避 |
| AVIF | Go ではデコードせず WebView に委譲 | Go に in-tree デコーダ無 / cgo 依存回避 (#118)。寸法はフロントが probe Image の `naturalWidth` で補完、サムネは元バイト列を passthrough |
| FE テスト | vitest (+ happy-dom / @testing-library/react) | 純関数中心。hook の race は renderHook で検証 (#110 B)。デフォルト env は node、DOM が要るファイルのみ `// @vitest-environment happy-dom` で opt-in |

## 6. 開発環境

- **開発機は WSL2 (Ubuntu 22.04)**。エンドユーザーターゲットは Windows 10/11 だが、開発時は Linux ネイティブビルドで動作確認 (ユーザー判断: dev は Linux で十分)
- `wails build` は Linux ELF を生成。Windows EXE は別途 Windows ホスト or `release.yml` の GHA で生成
- `main.go` の `MinWidth: 400` / `MinHeight: 300` がないと Linux/GTK で初期 Width が事実上の最小幅になる

## 7. 開発コマンド

```bash
wails dev                              # ホットリロード開発
wails build                            # リリースビルド (Linux ELF)

# Go テストは frontend/dist の placeholder が必要 (main の go:embed all:frontend/dist)
mkdir -p frontend/dist && touch frontend/dist/.ci-placeholder
go test ./... && go vet ./...

npm --prefix frontend run test         # vitest
(cd frontend && npx tsc --noEmit)      # type check (CI と同じ)
```

## 8. ファイル構成 (top-level)

```
image-observer/
├── CLAUDE.md / README.md / init.md          # 一次ルール / 使い方 / 元仕様
├── AGENTS.md                                # レビュー指摘パターン集約
├── .claude/context.md                       # このファイル
├── docs/                                    # todo.md + spec-*.md 各フェーズ仕様
├── main.go / app.go                         # Wails エントリ + 薄いバインディング層
├── internal/
│   ├── imgfile/                             # 画像拡張子判定 + Trash (Windows: SHFileOperationW)
│   ├── thumb/                               # サムネ生成 + ディスクキャッシュ + worker pool
│   ├── imgread/                             # 原寸読み出し + 寸法取得
│   ├── classification/                      # サイドカー JSON/CSV + 競合検出 + 子→親マージ
│   ├── state/                               # セッション状態永続化 (schema v6)
│   ├── settings/                            # ユーザー設定永続化 (schema v1)
│   ├── logging/                             # ファイルベース追記ロガー (ローテ付き)
│   └── watcher/                             # gofsnotify ベースのフォルダ単一監視
├── frontend/
│   ├── package.json / vite.config.ts        # vitest / tsc
│   ├── wailsjs/                             # Wails 自動生成型
│   └── src/
│       ├── App.tsx / App.css / main.tsx     # オーケストレーション層
│       ├── TopTabsBar.tsx                   # 上部タブ列 (一覧 + viewer × N + 追加 + 設定)
│       ├── useGlobalKeybindings.ts          # Ctrl+W / Ctrl+Tab / Ctrl+0/1/± / Ctrl+Shift+1..9
│       ├── topTab.ts                        # TopTab 型 ("list" | "viewer") 共有
│       ├── features/
│       │   ├── classification/              # 一覧タブ (UI + filters / colors / groups / cardCtxMenu / watcher 純関数)
│       │   ├── viewer-grid/                 # ビューア (BSP + DnD + layout/ 純関数群 + viewers ViewerSet + ViewerTab + useViewerRename + useListToViewerHandlers)
│       │   ├── session/                     # state save/load グルー + useWindowGeometryPolling
│       │   └── settings/                    # 設定 UI + useSettings + watchMode 定数
│       └── shared/
│           ├── components/                  # ModalShell / ConfirmDialog / ConflictDialog / MergePromptDialog / Toast
│           ├── icons/                       # インライン SVG
│           ├── messages/                    # UI 文字列カタログ (ja.ts) + t(key, params?) 純関数 (#83, i18n 前段)
│           └── utils/                       # base64 / bodyStyles / debounce / error / path / keybindings / logger
└── build/                                   # Wails アイコン / Windows manifest / ビルド成果物
```

詳細な per-file の役割は実コード (各パッケージの `doc.go` 相当 / 型定義) を直接参照する (ドキュメント側に列挙すると drift する)。

## 9. スコープ外 (v1 で作らない)

[init.md §2.3](../init.md) 基準。**[docs/todo.md](../docs/todo.md) で変更された項目があるので必ず両方確認**。

- 画像編集 / 回転保存 / メタデータ編集
- 複数フォルダ同時オープン
- Mac / Linux **本番**対応 (dev は OK)
- アニメーション WebP のコマ送り制御
- RAW / HEIC / TIFF / SVG 等の対象外フォーマット
- ペインのドッキング / フローティング

**init.md / 過去決定からの変更履歴** ([docs/todo.md](../docs/todo.md) 確定済み):

- init.md §2.3 ~~ペインの 3 分割以上~~ → **BSP ツリー + DnD で自由分割** (上限 16 パネル) を v1 でサポート (Phase 5)
- init.md F5 ~~「同一画像は既存タブにフォーカス」~~ → アクティブパネル内のみ、他パネルでは新規タブ (todo.md E2)
- todo.md E9 ~~「EXIF Orientation 尊重」~~ → v1 非対応 (再エンコードしない方針との整合 + 実装ボリューム見合わず)
- init.md R1 ~~「左フォルダ + 右ビューアの 2 ペイン」~~ → Phase 4 で左ペイン廃止 → トップタブ化 (一覧 / ビューア)

## 10. 進め方の原則

- **一次ソースは init.md (要件) → docs/todo.md (決定) → docs/spec-*.md (フェーズ実装)**。これらと矛盾する変更は事前にユーザー合意
- 要件レベル (init.md) の変更案は docs/todo.md に新規項目として可視化してから進める
- フェーズ完了時は docs/todo.md の対象項目を `[x]` 更新 → 次フェーズの spec を起こす → 実装
- ユーザーは 1 人開発、開発機は WSL2、リリース対象は Windows。テスト / 配布の手間が増える施策は事前に意思確認

## 11. Go パッケージ境界

依存方向は単方向。新機能は適切な internal パッケージに収め、`app.go` には Wails バインディング用ラッパだけ置く。Wails の TS バインディングは Go パッケージ単位で namespace を生成する (`thumb.Result` / `classification.Entry` 等)。

- **`main`**: `main.go` (Wails オプション + 起動) と `app.go` (バインディング層 = 各 internal への薄い委譲 + `CONFLICT:` プレフィクスのエラー整形) のみ。ビジネスロジックを置かない
- **`internal/imgfile`**: 画像拡張子判定 + 画像ファイル削除。export: `IsImage`, `Trash`。Windows ビルドで `shell32!SHFileOperationW` 経由のゴミ箱送り、非 Windows ビルドは `os.Remove` フォールバック + warn log
- **`internal/thumb`**: サムネ生成 + ディスクキャッシュ + worker pool。export: `Result`, `Config`, `Get`, `InitWorkerPool`, `CurrentWorkerCount`。`imgfile.IsImage` に依存
- **`internal/imgread`**: 原寸読み出し + 寸法取得。export: `Result`, `Info`, `Read`, `ReadInfo`。`imgfile.IsImage` に依存
- **`internal/classification`**: サイドカー (`_classification.json` 正本 + `.csv` 初回 import) ベースの分類メタデータ。export: `Service`, `Entry`, `Confidence`, `Classification`, `LoadResult`, `LoadOutput`, `SaveOutput`, `ErrConflict`, `ErrAlreadyExists`, `ErrDuplicate`, `ChildSidecarSummary`, `MergePreview`, `SidecarRepository`, `FileScanner`, `NewService`, `NewFileRepository`, `NewFileScanner`, `SchemaVersion`。`mtime` ベースの楽観的ロック (`expectedMtime` 不一致で `ErrConflict`)
- **`internal/state`**: セッション状態永続化 (schema **v6**)。export: `StateData`, `ViewerState`, `LayoutState`, `LayoutNodeState`, `TabState`, `ListTabState`, `ListFilterState`, `WindowState`, `Load`, `Save`, `DefaultData`, `StateSchemaVersion`。`Load()` は v6 strict / v5 ロスレス昇格 (`migration_v5.go`) / それ以外は default fallback。`validateState` は viewer 数 / 名前 sanitize / activeViewerId 解決 / 重複 ID 拒否を実施
- **`internal/settings`**: ユーザー設定永続化 (state とは別ファイル、`<UserConfigDir>/image-observer/settings.json`)。export: `SettingsData`, `Load`, `Save`, `Validate`, `DefaultSettings`, `SettingsSchemaVersion` + 列挙定数 (`MultiSelectCheckbox` / `MultiSelectModifier` / `MultiSelectBoth` / `WheelModeZoom` / `WheelModeShiftZoom` / `ThumbnailModeLetterbox` / `ThumbnailModeCrop` / `WatchModeAuto` / `WatchModeOff`)。`defaultTagColors` シードは非公開 (参照型 export 回避、AGENTS.md B-1)。per-field fallback で破損値だけリセット
- **`internal/logging`**: ファイルベース追記ロガー。export: `Level`, `Init`, `Close`, `Debug`/`Info`/`Warn`/`Error`/`Log`, `SetLevel`, `CurrentLevel`, `LogPath`, `ParseLevel`。`<UserCacheDir>/image-observer/logs/app.log` に 2MB × 3 ファイルでローテ。env > log_level.txt > 既定 INFO の優先順で resolve
- **`internal/watcher`** (#19): フォルダ単一監視 + debounce/coalesce。export: `Manager`, `NewManager`, `NewManagerWithDebounce`, `ChangedPayload`, `EmitFunc`, `DefaultDebounce` (200ms), `ClassificationChangedEvent` (`"classification:changed"`)。依存: `github.com/gofsnotify/fsnotify`, `internal/classification` (SidecarJSON 文字列定数のみ), `internal/imgfile`, `internal/logging`。Wails runtime は import せず `EmitFunc` 経由で `app.go` から `runtime.EventsEmit` を注入 (テスト容易性 + 依存方向のシンプル保持)

パッケージ間依存: `state` 依存なし、`imgfile` → `logging` (非 Windows ビルドのみ、Trash fallback の warn log)、`thumb` / `imgread` / `classification` → `imgfile`、`watcher` → `classification` + `imgfile` + `logging`。循環参照を作らない。

## 12. フロント feature 境界

- **`features/classification/`** ↔ `internal/classification`: 一覧 (分類) タブの UI 一式 + フィルタ / 配色 / グルーピング / コンテキストメニュー / watcher の純関数。`useGridThumbnail` で IntersectionObserver + module-scoped Map キャッシュ。`filters.ts` / `colors.ts` / `groups.ts` / `cardContextMenuLogic.ts` / `watcherPolicy.ts` / `thumbnailCache.ts` / `gridNav.ts` (矢印キーのグリッド移動先計算, #115) / `modalEditShortcuts.ts` (プレビュー編集の t/c/n フォーカス写像, #115) は vitest 対象
- **`features/viewer-grid/`** ↔ `internal/imgread`: ビューア (BSP ツリー / DnD / 画像表示)。`layout/` (`types` / `tree` / `validation` / `serialization` / `active` / `operations` の機能別モジュール群、表面 import は `./layout` バレル経由) は vitest 対象。`useDnD.ts` は pointer events 自前 + `elementFromPoint`。`viewers.ts` は複数ビューア対応の純関数群 (`hydrateInitialViewerSet` / `countLeafTabs` 含む)、`useViewerSet.ts` が hook 統合。`ViewerTab.tsx` (top-tab UI per viewer) / `useViewerRename.ts` (inline rename state) / `useListToViewerHandlers.ts` (list→viewer wiring)
- **`features/session/`** ↔ `internal/state`: 保存 / 復元グルー (`useSessionLoad` / `useSessionSave`) + `useWindowGeometryPolling` (window geometry / maximized polling, #86)。`useSessionSave` のみ `viewer-grid/layout` の型を import するクロス feature 依存を持つ (永続化は各 feature 状態を集約するため許容)
- **`features/settings/`** ↔ `internal/settings`: `useSettings` フック + `SettingsDialog` + セクション群 + `watchMode.ts` 定数 (Go 側との D-1 同値テストで pin)
- **`shared/components/` / `icons/` / `utils/` / `messages/`**: 機能横断 UI 部品 / アイコン / ユーティリティ / UI 文字列カタログ。どの feature からも import 可。逆に shared から features を import しない。`messages/` は `ja.ts` (フラットなドット区切りキーの `as const` カタログ) + `t(key, params?)` 純関数 (`MessageKey = keyof typeof ja` で型保証、`{placeholder}` 補間)。ja 固定 = i18n 前段 (#83、locale 切替は #16)。Phase 1 で shared dialogs + 設定ダイアログを移行、KeybindingsTable / 各 feature view は Phase 2 (#83) で追従。`<code>`/`<strong>` を文中に挟む文は flat catalog で表現できないため据え置き
- **`App.tsx`**: 唯一の複数 feature オーケストレーション層。永続状態の hydration + 子フック (`useWindowGeometryPolling` / `useGlobalKeybindings` / `useViewerRename` / `useListToViewerHandlers` / `useViewerTabReorder` / `useSessionSave`) 組み立て + 子コンポーネント (`TopTabsBar` / `ClassificationView` / `ViewerGrid` / `SettingsDialog`) への配線 + ToastProvider / useConfirm 境界。`TopTabsBar.tsx` (上部タブ列) と `useGlobalKeybindings.ts` (Ctrl+Shift+1 が list、Ctrl+Shift+2..9 が viewer のため feature を跨ぐ) は App-level として `src/` 直下に同居。`TopTab` 型 (`"list" | "viewer"`) は `src/topTab.ts` に独立
- **フロントテスト**: `frontend/` で `npm run test` (vitest)。純関数ユニットテスト中心。auto-save キューの race は `useAutoSaveQueue` を renderHook で、baseline reset 判定は `sampleEditBaselineSync` を純関数テストで検証 (#110 B)。`saveEdit` の folder gate (`SaveContext` で cross-folder save を skip) は `useClassificationEdit` を renderHook + IPC mock で検証 (#110 C)。デフォルト env は node、renderHook など DOM が要るファイルのみ `// @vitest-environment happy-dom`
