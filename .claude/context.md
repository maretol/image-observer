# image-observer プロジェクトコンテキスト

新規セッションでこのプロジェクトを開いた Claude が、まず読んで全体像を把握するためのファイル。詳細は本文中で参照しているドキュメントを参照する。

最終更新: 2026-05-15 (#11 複数ビューア対応)。**state schema v6** (v5→v6 ロスレス昇格マイグレーション実装済) / settings schema v1 (additive 拡張)。`internal/settings` 既存、`internal/logging` (Phase 5 補足) 既存、Phase 4 v1.4 までの分類 / Phase 5 ビューアフレックスレイアウト / Phase H1+H2+H4 (設定基盤 + 設定 UI シェル + キーバインド) はすべて実装済み。**Phase I 確定済**: (1) **バージョン規約**: pre-1.0 semver (`0.x.y`) + `v` プレフィクス git tag。注入は GHA で tag→`-ldflags "-X main.Version=v..."`、`wails.json.info.productVersion` は CI 内 `sed` で一時上書き。`main.go` に `var Version = "dev"` フォールバック有り。(2) **ビルド OS**: `windows-latest` 1 ジョブで `wails build -platform windows/amd64` のみ公式。WSL/Linux の Linux ELF 出力は動作確認用、クロスコンパイル非サポート。(3) **コードサイニング**: v1 は未署名 (SmartScreen 警告受容)、複数ターゲット対応時に再検討。(4) **配布形態**: portable EXE + NSIS インストーラ両方を `wails build -platform windows/amd64 -nsis` で同時出力。(5) **CI**: 2 yaml 構成。`.github/workflows/ci.yml` は push/PR 時に ubuntu-latest で `go test ./...` + `npm ci` + `npm run test` + `tsc --noEmit`、`.github/workflows/release.yml` は `tags: ['v*']` 押下時に windows-latest で `wails build -nsis` → portable EXE と NSIS インストーラを GitHub Releases に `softprops/action-gh-release@v2` で添付。secrets 不要 (GITHUB_TOKEN 自動)。フロント vitest / Go テスト全通過、`tsc --noEmit` クリア、`wails build` 通過 (件数は追加のたびに動くので最新は `npm run test` / `go test ./...` の出力を参照)。残作業は GitHub Issues に移行済み (旧フェーズ呼び名と open/closed 状況は変動するため、現状は `gh issue list --state open` を一次ソースとする)。todo.md §H〜J も追従済 (J-1 ログと J-2 テストは実装済として `[x]` に更新)。

---

## 1. プロジェクトの一行説明

Wails v2 (Go バックエンド + React/TS フロント) で実装する **Windows 向け画像ビューア**。VSCode 風の 2 ペイン UI に「フォルダツリー上での画像サムネイル表示」を加えたものを作る (VSCode に欠けている機能の補完が動機)。

## 2. 現在のフェーズ

**Phase 0 / 1 / 2 すべて実装完了。Phase 3 は 3a/3b/3c の 3 段階に分割、Phase 3a spec 確定済み。**

- Phase 0: 2 ペインの空シェル UI、スプリッターでペイン幅可変。
- Phase 1: フォルダ選択 + 遅延ツリー描画 (アイコン / ホバー / エラー / ローディング表示込み)。
- Phase 2: ホバーポップアップでサムネ表示。Go 側に `GetThumbnail` API + worker pool + シャーディングキャッシュ (`os.UserCacheDir()/image-observer/cache/thumbnails/<mode>/<size>/<2>/<30>.<ext>`)。WebP は PNG フォールバック (cgo 依存回避のため)。Go テスト 11 ケース全パス、`wails build` パス済み。
- **Phase 3a (実装完了)**: 単一パネル + タブ + 画像表示 + ズーム/パン + 背景 (チェッカ柄)。EXIF Orientation は v1 非対応 (todo.md E9 改定)。原寸表示は再エンコードせずディスクバイトをそのまま返す方針。spec は [docs/spec-tab-imageview-3a.md](../docs/spec-tab-imageview-3a.md)。
- **Phase 3b (実装完了)**: ビューア領域を最大 2 行 × 3 列 = 6 パネルのグリッドに分割 + アクティブパネル (青枠ハイライト) + パネル間タブ移動 (右クリックメニュー)。`useViewerGrid` hook で全状態を一元管理、`MAX_ROWS / MAX_COLS` 定数で将来 UI 化の境界を分離。Go 側変更なし。spec は [docs/spec-tab-imageview-3b.md](../docs/spec-tab-imageview-3b.md)。
- **Phase 3c (実装完了)**: セッション復元。`os.UserConfigDir()/image-observer/state.json` にアトミック書き込み、debounce 500ms。Go 側 `GetState` / `SaveState` + `main.go` 起動時 loadState + OnStartup で `WindowSetPosition`。フロントは `useSessionLoad` (2 段階 mount) + `useSessionSave` (`JSON.stringify` で stable diff) + `useTree` / `useViewerGrid` の `initialRootPath` / `initialGrid` 注入 + ImageView の post-restore `clampPan`。spec は [docs/spec-tab-imageview-3c.md](../docs/spec-tab-imageview-3c.md)。todo.md F は本フェーズで部分確定済み (設定値の永続化は Phase H で別ファイル `settings.json`)。
- **Phase 4 (実装完了)**: 左ペイン (フォルダツリー) を完全廃止し、トップレベルタブ「一覧 / ビューア」に再編。「一覧」タブに分類ビュー (タグチップ + 信頼度 + 検索 + サムネグリッド + 編集ポップオーバー + ライトボックス) を新設。サイドカー `_classification.json` (正本) + `_classification.csv` (初回 import 専用) ベース。AI / 手動編集を想定して `mtime` ベースの **競合検出** + 「再読み込み」ボタンを実装。配色は **既知タグマップ + FNV-1a ハッシュフォールバック** で汎用化 (`shugo`/`fumei` などのドメイン特別扱い撤廃)。Go: `internal/tree` 削除、`IsImage` を `internal/imgfile` に移設、`internal/classification/{types,repository,scanner,service}` 新設、`internal/state` を v2 化 (`TopTab` / `List` 追加、v1 はマイグレーションせず default fallback)。フロント: `features/folder-tree/` 削除、`features/classification/` 新設、`useSessionSave` を v2 化。spec は [docs/spec-classification.md](../docs/spec-classification.md)、元仕様は [docs/new_thumbnail.md](../docs/new_thumbnail.md)。
- **Phase 4 仕上げ (実装完了)**: `frontend/` に **vitest** を導入し `features/classification/{filters,colors}.test.ts` を追加 (26 ケース: extractTags / applyFilter / tagSummary / tagColor 決定性 / readableTextColor / folderClass)。`npm run test` で実行。Go テスト全通過、vitest 全通過、`tsc --noEmit` クリア、`wails build` 通過。
- **Phase 4 v1.1 改定 (実装完了)**: (1) **mtime API バグ修正**: `internal/classification/repository.go` で `UnixNano()` → `UnixMilli()` に変更 (`int64` UnixNano が JS `Number.MAX_SAFE_INTEGER` を超え、Wails IPC 越しで丸め誤差が出てアプリ内編集でも常に CONFLICT 判定されていた)。(2) **ライトボックス廃止**: `Lightbox.tsx` を削除、`useClassification` から `lightbox` 状態 / `openLightbox` / `closeLightbox` / `nextLightbox` / `prevLightbox` を削除、`App.css` の `.lightbox-*` を削除。サムネクリックで `useViewerGrid.openInActive(folderPath + "/" + filename)` + `setTopTab("viewer")` を呼ぶ動線に変更 (`App.tsx` でオーケストレーション、`ClassificationView` の `onOpenInViewer` プロップ経由)。連続レビュー (`←/→`) は Phase H 以降に再検討する形で v1 では完全廃止。spec の改訂履歴は [docs/spec-classification.md](../docs/spec-classification.md) 冒頭に記載。
- **Phase 4 v1.2 改定 (実装完了)**: 親フォルダ配下にサブディレクトリを含むケースのサポート。(1) **再帰スキャナ**: `internal/classification/scanner.go` を `filepath.WalkDir` で再帰化、`filename` は親からの POSIX 相対パス (`child1/hoge.png` 等)、隠しディレクトリスキップ、シンボリックリンクは追跡しない。(2) **子→親マージ**: `internal/classification/merge.go` を新設し `Service.PreviewChildSidecars` / `MergeChildSidecars` を実装。親に sidecar 無 + 子に non-trivial sidecar (JSON or CSV) がある場合に初回オープンで `MergePromptDialog` を表示、「マージ / 無視 / キャンセル」の 3 択。マージ時は filename にサブフォルダ名プレフィックス、子 sidecar は残置。Wails バインディング `PreviewChildSidecars` / `MergeChildSidecars` 追加。(3) **アコーディオン UI**: `features/classification/groups.ts` (純関数) + `useDirectoryGroups` フック + `DirectoryGroup` コンポーネントを新設。`ClassificationView` がディレクトリ別グループでレンダリング。フィルタは折りたたみと独立。(4) **state schema v2 → v3**: `ListTabState.CollapsedGroups []string` 追加、default fallback。(5) `ClassificationGrid.tsx` 削除 (DirectoryGroup が代替)。Go テスト全通過 (47 ケース: scanner 6 + merge 6 + 既存 + state 14)、vitest 35 ケース (groups 9 追加)、`tsc --noEmit` / `wails build` 通過。
- **Phase 5 (実装完了)**: ビューアグリッドを **BSP (二分空間分割) ツリー + DnD** で書き直し。spec は [docs/spec-viewer-flexlayout.md](../docs/spec-viewer-flexlayout.md) (Phase 3b は §12.1 の通り上書き対象)。(1) **データモデル変更**: `Grid { size: { rows, cols }, panels[] }` を `Layout { root: SplitNode | LeafNode, activeId }` に置換。`features/viewer-grid/layout/` (新規、純関数 + 型。#68 で機能別モジュールに分割、`./layout` import 表面は維持)。(2) **ツールバー廃止**: `GridToolbar.tsx` 削除、`addRow / addCol / removeRow / removeCol` 廃止。(3) **DnD レイアウト編集**: pointer events 自前 (HTML5 DnD は不採用)。タブを (a) パネル中央へ → 移動、(b) パネル 4 辺の 20% 帯へ → 分割発生、(c) タブバー上の隙間 → 並び替え / 挿入。`useDnD.ts` (グローバル pointermove + `elementFromPoint`)、`DropOverlay.tsx` (各パネルにドロップゾーン UI)、`TabDragGhost.tsx` (カーソル追従ゴースト) 新設。(4) **TabContextMenu 縮小**: 「閉じる / 右に分割 / 下に分割」のみ、`別パネルへ移動` 廃止。(5) **state schema v3 → v4**: `Grid` を `Layout` に置換、再帰タグ付きユニオン `LayoutNodeState` 採用。v3 以前は default fallback。(6) **Splitter 制約**: `MIN_PX = 100` と `MIN_RATIO = 0.05` の両方で clamp。`MAX_PANELS = 16` (DFS leaf 数で判定、超過時は edge drop を no-op + トースト)。(7) **キーボード操作 (Esc キャンセル含む) は Phase H 持ち越し**。残作業は `wails dev` での目視テスト + 旧 spec (3b/3c) 冒頭の redirect 追記 + Phase G/H/I/J。
- **Phase 5 補足 (実装完了)**: (1) **Go 側ロギング**: `internal/logging` パッケージ新設 (Init/Close/Debug/Info/Warn/Error/Log/SetLevel/CurrentLevel/LogPath/ParseLevel)。`os.UserCacheDir()/image-observer/logs/app.log` に書き出し、2MB × 3 ファイルで自動ローテ。レベル解決: env `IMAGE_OBSERVER_LOG_LEVEL` > `<UserConfigDir>/image-observer/log_level.txt` > 既定 INFO。`SetLevel` で runtime 切替可能 (Phase H 設定 UI 連携)。`main.go` で起動時 Init + panic recover、`app.go` に `LogEvent(level, category, message, data)` / `GetLogPath()` の Wails バインディング追加。`go test ./internal/logging` 11 ケース。(2) **フロント側ロギング**: `frontend/src/shared/utils/logger.ts` 新設。INFO/WARN/ERROR は即時 `LogEvent` IPC、DEBUG は 200 件のリングバッファに蓄積 (高頻度向け)。`flushAll(reason)` でリング全件を Go に送る。`installGlobalErrorHandlers()` で `window.onerror` / `unhandledrejection` を捕捉し自動 flush。vitest 7 ケース (合計 100)。各 feature に呼び出しを仕込み済 (DnD start/commit/cancel/refused、image open failed/oversized、classification save/conflict/merge、state save failed)。(3) **DnD 体感修正**: ゴーストを `transform: translate3d` に変更 (WebKitGTK のサブピクセル丸めズレ回避)、ドラッグ中は `body.style.userSelect = "none"` + cursor `grabbing`、`.viewer-grid img` に `-webkit-user-drag: none` を付与してテキスト/画像選択ハイライトを抑制。(4) **README**: ログファイル場所 / レベル切替 / 内容と非内容のセクションを追記。
- **Phase 4 v1.4 改定 (実装完了)**: 一覧タブの **複数選択 + バルクオープン**。spec は [docs/spec-classification.md](../docs/spec-classification.md) §1.4。(1) **選択 UI (案 A 常時 checkbox)**: Card 左上に常時表示の checkbox。`useClassification` に `selectedFilenames` / `isSelected` / `toggleSelected` / `clearSelected` を追加 (Set<filename> で保持、フォルダ変更時自動クリア、セッション保存なし)。(2) **バルクツールバー**: 選択が 1 件以上で表示。「N 件選択中 / [タブで開く] / [パネル分割で開く (≤8 枚)] / [選択解除]」。(3) **viewer 結線**: `useViewerGrid.openManyInActive` (各画像を active panel に新規タブ追加) と `openManyAsSplit` (アクティブを N 回右分割、空 active なら 1 枚目を流し込み) を追加。(4) **layout/operations.ts** (#68 で分割後): `splitWithNewLeaf(layout, dstLeafId, edge, tab)` 純関数を追加 (新規タブ用 split helper)。(5) **将来オプション (案 B 修飾キー: Ctrl+クリック / Shift+クリック)** は `docs/todo.md H` に「複数選択 UI のオプション化」として記載、Phase H で settings.json と一緒に実装する。
- **Phase H1 + H2 (実装完了)**: ユーザ設定の基盤と最小 UI シェル。
   - **`internal/settings` パッケージ**: `<UserConfigDir>/image-observer/settings.json` (Windows: `%APPDATA%`)。Schema v1: `LogLevel` (`debug|info|warn|error`) + `MultiSelectMode` (`checkbox|modifier|both`)。`Load` / `Save` (アトミック書き込み + バージョンスタンプ + per-field fallback) / `Validate`。Go テスト追加。
   - **Wails バインド**: `GetSettings()` / `UpdateSettings(s)` / `ResetSettings()`。`UpdateSettings` は保存後に `logging.SetLevel(...)` を即時適用。
   - **main.go 連携**: 起動時 `settings.Load()` でログレベルを env-var resolve よりも後に上書き。
   - **フロント `useSettings` hook**: 起動時 `GetSettings` → React state、`update(patch)` / `reset()` で round-trip + logger 仕込み。
   - **設定モーダル** ([SettingsDialog.tsx](../frontend/src/features/settings/SettingsDialog.tsx)): 上部タブバー右端の歯車アイコンで開く。セクション (ロギング: level + ログパス表示 / 一覧タブ: multiSelectMode segment / キーバインド表) + フッタ (既定値に戻す / 閉じる)。Esc / バックドロップクリックで閉じる。
- **Phase H UX 修正 (実装完了)**: 一覧の選択 UX とビューアの自動再配置を改善。(1) **選択モード時のクリック挙動**: 選択 ≥1 で Card のサムネクリックも選択トグルに変わる (Finder 風)。`Card` に `selectionMode` prop を追加、`ClassificationView` で `selectedFilenames.length > 0` を派生して伝搬。(2) **ビューアパネル再配置 (ResizeObserver)**: パネル / ウィンドウの寸法変化を ImageView の container で観察し、軸独立で再配置: 「収まる軸 → 中央」「はみ出す軸 → 旧 vp 中心の画像ピクセルを新 vp 中心に維持 → clampPan」。zoom は変更しない。effect 内ローカル closure で前回サイズ保持、`tab.initialized` 後に動作。(3) **複数選択モードのオプション化** (案 B 実装): 設定 `multiSelectMode = "checkbox" | "modifier" | "both"` で動作切替。`useClassification` に `selectAnchor` (state) + `extendSelectionTo(filename, displayedOrder)` を追加。Card は `showCheckbox` / `modifierEnabled` の 2 prop で表示と修飾キー反応を分岐。displayedOrder は `ClassificationView` で `groupByDirectory` の結果を flatMap して算出 (collapsed group も含む)。
- **#14 ハードコード値 → settings.json (実装完了)**: 4 種のハードコード値を settings に逃がして UI から変更可能に。schema bump なし (v1 に additive、per-field fallback 経路を流用)。
   - **`SettingsData` 拡張**: `MaxImagePixelsMP` (default 200) / `ThumbnailSize` (default 256) / `ThumbnailMode` (default letterbox) / `ThumbnailWorkerCount` (default 0 = NumCPU/2 auto) / `TagColors` (default は同パッケージ非公開の `defaultTagColors` シードを clone) を追加。`Validate` / `applyFieldDefaults` に各フィールドの境界 (`isValidHexColor` 含む) を追加し、不正値は per-field 単位で黙ってデフォルトに戻す (タグ色マップは個別エントリ単位で drop)。Go テスト追加 (`TestLoad_NewFieldsMissing_GetDefaults` で旧 v1 payload からの upgrade 経路を担保)。
   - **`internal/thumb`**: `InitWorkerPool(n int)` / `CurrentWorkerCount()` を追加。`main.go` 起動時に `userSettings.ThumbnailWorkerCount` を渡して 1 度だけプール初期化 (worker 数変更は再起動必須、設定 UI に明示)。サムネサイズ / モードは引き続き呼び出し側 (フロント) が GetThumbnail に渡す。
   - **フロント**: `useViewerGrid` に `maxImagePixels` opt を追加し、内部で ref 経由で参照することで設定変更が次回 open から効く。`useGridThumbnail` は module-level の `thumbSize` / `thumbMode` を `setThumbnailParams(size, mode)` で書き換え (App.tsx が settings load/update で呼ぶ)。`colors.ts` は `KNOWN_TAG_COLORS` 定数を `activeTagColors` 可変マップ + `setKnownTagColors(map)` セッター + `getKnownTagColors()` リーダーに置換。`tagColor()` は `activeTagColors` を読む。`defaultPalette.ts` は初期値専用に降格。
   - **設定ダイアログ**: 「ビューア」セクションに「開ける画像サイズの上限 (MP)」(number)、新規「サムネイル」セクション (表示サイズ select / アスペクト処理 segment / 生成ワーカー数 number, 0=auto, 再起動必須注記)、新規「タグ色」セクション (read-only swatch list、編集は settings.json 直で。フルエディタは follow-up issue) を追加。CSS: `.settings-number` と `.settings-tag-colors-*` を新設。
   - **テスト追加**: vitest (`setKnownTagColors` / `getKnownTagColors`)、Go テスト (`isValidHexColor` 含む)。`tsc --noEmit` クリア、`wails build` 通過。
- **#29 + #27 + #31 リファクタ束ね (実装完了)**: フロント整理 + useClassification 構造改善 + 軽微 UX 改善を 1 PR に集約。
   - **共通 util 抽出**: `shared/utils/path.ts` (basename) と `shared/utils/error.ts` (errorMessage) を新設し、`viewer-grid/{TabBar,TabDragGhost,useViewerGrid,ImageView}` / `classification/useClassification` / `settings/useSettings` の 4 重複を解消。
   - **Wails テンプレ残骸**: `style.css` の `#app` セレクタを `#root` に修正、`SettingsDialog` の不要な `e.stopPropagation()` を削除、`useSessionLoad`/`useSessionSave` の `console.warn` を `logger.warn` に統一。
   - **state schema v5**: Phase 1 leftover の `RootPath` / `LeftPaneWidth` を `internal/state/state.go` から削除し、フロント (`useSessionSave` の `buildStateData`) からも除去。`SaveState(data as any)` は `state.StateData.createFrom(...)` 経由で型安全化。テストは v4 fallback (`TestLoadState_V4FallsBackToDefault`) を追加し、旧フィールドアサーションを除去。
   - **#27**: `useClassification` の `selectAnchorRef` 宣言を `extendSelectionTo` の上に移動 (TDZ-shaped 罠の解消)。`ClassificationHeader` の API を `totalCount`/`filteredCount` から `allEntries`/`filteredEntries` に変更し、件数集計責務を Header 側に閉じ込め。
   - **#31**: `App.tsx` の window pos/size ポーリングに `logger.debug` (起動ログ + 変化ログ) を追加。`ClassificationView` に「すべて折りたたむ」ボタンを追加 (`useDirectoryGroups.collapseAll(keys)` を新設、全グループキーを渡す形)。`useClassification` auto-load effect に `autoLoadStartedRef` ガードを追加し StrictMode 二重実行を抑止。`TabBar.tsx` の `display: contents` ラッパを `Fragment` に置換。
- **Phase H4 キーバインド (実装完了)**: ビューア向けキーバインドと DnD Esc キャンセルを実装。
   - **Esc (DnD active 時)**: `useDnD` 内 keydown ハンドラでドロップせずキャンセル + body styles 復元 + `dnd.cancel reason=escape` ログ。
   - **App.tsx グローバル keydown** (viewer タブ + 非エディタブル要素時のみ):
     - `Ctrl+W` → `viewer.closeTab(activeLeaf, activeIndex)`
     - `Ctrl+Tab` / `Ctrl+Shift+Tab` → `viewer.setActiveTab` で巡回 (modulo)
     - `Ctrl+0` → `zoomCommandBus.emit("fit")` → ImageView が `computeInitialFit` で再フィット
     - `Ctrl+1` → `emit("actualSize")` → 100% (vp 中心基準でズーム)
     - `Ctrl++` / `Ctrl+=` → `emit("in")` (1.2 倍、中心基準)
     - `Ctrl+-` → `emit("out")` (1/1.2 倍)
   - **`shared/utils/keybindings.ts`**: `zoomCommandBus` (single-listener pubsub。アクティブパネルの ImageView だけが購読し、活性化変更で takeover) + `isEditableTarget` / `isPrimaryModifier` ヘルパ。vitest 7 ケース。
   - **ImageView 改修**: `isActivePanel` prop を Panel から渡し、active 時のみ zoomCommandBus に listener を登録。`tabRef` / `updateRef` で listener が render 毎に再生成されないよう refs 経由で参照。
   - **設定ダイアログ**: キーバインド一覧を read-only テーブル (`<kbd>` タグ) で表示。Phase H で再バインド機構を追加するときの土台に。
- **#13 + #7 + #10/#12 (実装完了)**: settings 周りの再編 + トップタブ切替ショートカット + UI スケール。
   - **#13 設定ダイアログ 2 階層化**: ヘッダに「設定 / ショートカット」のカテゴリタブ (`Category = "settings" | "shortcuts"`) を追加。`shortcuts` カテゴリは side nav の DOM を出さない分岐になっていて、コンテンツペインは既存 `.settings-content` の `flex: 1` で自然にフル幅になる (専用クラスは設けない)。`SECTIONS` から `keybindings` を除外し、代わりに新規 `appearance` を追加。category-bar は `aria-pressed` ベースの toggle button (WAI-ARIA tabs パターンは未実装なので tablist role を主張しない)。
   - **#7 トップタブ切替ショートカット**: `App.tsx` のグローバル keydown に `Ctrl+Shift+1` → 一覧 / `Ctrl+Shift+2` → ビューアを追加。`viewer-only` ガードより前に判定するため topTab に関係なく動作。マッチは `e.code === "Digit1/2"` のみ (`e.key` は Shift で shifted character になるため不可)。`KEYBINDINGS` テーブルに同 SC を追加 (scope "全体")。
   - **#10/#12 UI スケール**: `internal/settings.SettingsData` に `UIScalePercent` を additive 追加 (schema v1 のまま、per-field fallback で旧 settings.json も無痛 upgrade。具体的なレンジ / デフォルトは `internal/settings/settings.go` の定数を参照)。フロントは `App.tsx` の useLayoutEffect で `--ui-scale` CSS 変数を `<html>` にセットし (paint 前同期を保証して設定変更時のフリッカーを回避)、`App.css` の chrome コンテナ群 (`.top-tabs` / `.cls-view` / `.cls-empty-state` / `.tab-bar` / `.settings-dialog`) に `zoom: var(--ui-scale, 1)` を適用 (#39)。`.tab-context-menu` / `.tab-drag-ghost` は意図的に対象外 — それぞれ `window.innerWidth/Height` クランプ / `pointermove clientX/Y` で raw window 座標から位置決めしており、zoom がかかると transform 移動量や bounding-box が座標と非同期になりメニューの画面外はみ出し / ゴーストの追従ズレを起こすため (chrome 一貫性より位置精度を優先)。app-root と viewer canvas は zoom 1 のまま → レイアウトは常にウィンドウフィット、画像はネイティブピクセルでレンダ (ビューア zoom % が実寸に対応)。`zoom` は非標準だが WebView2 / WebKitGTK 双方サポート。ConfirmDialog は `document.body` への portal で overlay (`position:fixed; inset:0`) を等倍に保ち、内側 `.confirm-dialog` だけに inline `zoom` を当てて backdrop の full-viewport カバレッジを維持する (SettingsDialog の `.settings-backdrop` / `.settings-dialog` と同じパターン)。Toast の `.toast-host` は bottom/right anchored で content-sized なので host 自体に inline `zoom` を当てて OK (overlay と非対称な構造ゆえ)。設定 UI は新規「外観」セクションに segment タイル (具体的なタイル値は `SettingsDialog.tsx` の `UI_SCALES` を参照)、settings.json で範囲内の任意 percent を直書きすれば segment は un-highlighted で hint に現在値を表示。
   - **設定ダイアログ CSS**: `.settings-category-bar` / `.settings-category-tab` / `.settings-category-tab-active` を追加。`.settings-header` に gap を入れてタイトル / カテゴリタブ / 閉じるの 3 要素を整列。
   - **Go テスト**: settings_test の各経路 (round-trip / reject / per-field fallback / new field missing) に `UIScalePercent` 検証を追加。
- **#30 a11y/consistency まとめ (実装完了)**: 監査メモ §12 / §13 / §14 / §16 / §20 の整合性問題を 1 束で解消。Go 側変更なし、フロントのみ。
   - **§13 body styles token stack**: `shared/utils/bodyStyles.ts` を新設 (`pushBodyStyle({cursor, userSelect})` がスタックエントリを積み、release で外す)。`useDnD` / `GridSplitter` / `ImageView` の 3 箇所が直接 `document.body.style.{cursor,userSelect} = ...` していた箇所を全置換。複数クレーマント (drag 中に splitter…等の同時シナリオ) が `""` でユーザの元設定を潰さない。
   - **§12 Pointer/Mouse 統一**: `GridSplitter` / `ImageView` のドラッグを `MouseEvent` から `PointerEvent` + `setPointerCapture` に置換。`window.addEventListener("pointermove" / "pointerup" / "pointercancel")` でリスナを統一し、`pointerId` でドラッガを照合。タッチ / ペンも同じ経路で動く副次効果あり (主目的は viewer-grid 内のイベント系統一)。
   - **§14 a11y / ARIA**: (1) `Card.tsx` の `cls-card-thumb` を `role="button"` + `tabIndex={0}` + `onKeyDown` (Enter/Space) に。`:focus-visible` で枠色アウトラインを `App.css` に追加。`aria-label` は selectionMode の有無で「開く / 選択を切替」を出し分け。(2) `TabBar.tsx` を `role="tablist"` + 各タブ `role="tab"` `aria-selected` + roving tabindex (`active ? 0 : -1`) に。`ArrowLeft/Right/Home/End` でフォーカス移動 (follow-focus パターン: 移動先タブを onSelect でアクティブ化)。タブ内の閉じるボタンは `tabIndex={-1}` で Tab 順から外し、roving の主役をタブ本体に保つ。(3) `TabContextMenu.tsx` を `role="menu"` + 各項目 `role="menuitem"` に。マウント時に先頭 menuitem へ focus 移動、`ArrowUp/Down/Home/End` でラップアラウンド移動。
   - **§16 wheel mode 設定文言**: 「マウスホイールの動作」field の hint に「ホイールでズーム / パンするのは画像領域だけ。タブバー上は常にタブ列の横スクロール」を明記し、`KEYBINDINGS` の「Shift+ホイール / Ctrl+ホイール」行の action 文言にも「画像領域のみ」を追記。実装は変えず文言で例外を可視化する方針。
   - **§20 ModalShell 抽出**: `shared/components/ModalShell.tsx` 新設 (portal to body + overlay + Esc + Tab focus trap + initial focus + previous focus restore + 内側 dialog のみ `zoom: var(--ui-scale)`)。`closeOnBackdrop` / `closeOnEscape` / `initialFocusRef` / `overlayClassName` / `dialogClassName` / `ariaLabel/LabelledBy/DescribedBy` を prop で受ける。`ConfirmDialog` / `ConflictDialog` / `MergePromptDialog` の 3 つを ModalShell に乗せ替え、Esc / focus trap / focus restore の挙動を統一。各ダイアログの既存 CSS クラス (`confirm-dialog-overlay` / `confirm-dialog` / `cls-merge-dialog` 等) は `overlayClassName` / `dialogClassName` で注入することで CSS 改修不要 (`MergePromptDialog` は Phase 4 v1.2 から未定義の `.confirm-overlay` を引きずっていたが、本 PR の機会に `.confirm-dialog-overlay` へ統一)。`SettingsDialog` は対象外 (独自 backdrop / 構造で動作中、必要時に別途検討)。
- **#11 複数ビューア対応 (実装完了)**: ビューアタブを「ユーザーが追加 / 削除 / リネームできる N 個のビューア」に拡張。spec は [docs/spec-multi-viewer.md](../docs/spec-multi-viewer.md)。
   - **state schema v6**: `StateData.Layout` (単数) を `Viewers []ViewerState` + `ActiveViewerID` に置換。各 `ViewerState { ID, Name, Layout LayoutState }` が独立の BSP レイアウトを持つ。**v5→v6 はロスレス昇格マイグレーション**を実装 (`internal/state/migration_v5.go`)、v4 以前は従来通り DefaultData fallback。`internal/state/state.go` の `validateState` で viewer 数 (1..maxViewers=8) / 名前 sanitize (rune 32 文字 + 制御文字除去) / activeViewerId 解決 / 重複 ID 拒否を実施。
   - **`features/viewer-grid/viewers.ts`** (純関数 + 型): `Viewer` / `ViewerSet` 型 + `addViewer` / `closeViewer` (last-1 protection) / `renameViewer` (sanitize + 重複許容) / `setActiveViewer` / `suggestViewerName` (gap-fill auto-numbering "ビューア N") / `moveTabAcrossViewers` (cross-viewer tab move、src 側 collapseEmptyLeaf + dst 側 dedupe + activeViewerId 不変 + zoom/pan 保持)。vitest 39 ケース。
   - **`useViewerSet` フック**: 旧 `useViewerGrid` を削除し置換。active viewer の layout に対する panel-level mutation 群 (open / split / move / setActiveTab / closeTab / 等) と viewer-level mutation 群 (add / close / rename / setActive) を 1 つの hook が公開。`openInViewer` / `openManyInViewer` / `openManyAsSplitInViewer` / `moveTabToViewer` の thin wrapper も生やし、SampleModal のビューア選択 / バルクの viewer dropdown / TabContextMenu のサブメニューから直接呼べる。
   - **トップタブ UI**: 「一覧 + ビューア × N + `+` ボタン + 設定」構成。ビューアタブはダブルクリックで inline rename (`<input maxLength={32}>`、Enter 確定 / Esc 破棄 / blur 確定)、hover で `×` 表示 (タブが残っていれば `useConfirm` で確認、最後の 1 個は disabled)。viewer タブ群は `.top-tabs-viewers` の `overflow-x: auto` でスクロール、`+` と設定アイコンは右端固定。
   - **キーバインド**: `Ctrl+Shift+1` = 一覧。`Ctrl+Shift+2..9` = N 番目 (1〜8) のビューア (旧 `Ctrl+Shift+2`「ビューアに切替」と互換、e.code === "Digit2..9" 判定)。設定ダイアログの KEYBINDINGS テーブルも更新。
   - **一覧 → ビューア結線の刷新**: Card サムネ通常クリックの「即ビューア開」を廃止し、**SampleModal を開く** に統一。SampleModal フッターは viewers.length >= 2 のときビューア横並びボタン群 (active がハイライト + autoFocus)。バルク UI は「`<select>` 開く先 + タブで開く / パネル分割で開く」に再構成、デフォルトは active viewer。Card の独立 `PreviewIcon` ボタンは削除 (動線冗長解消)。
   - **TabContextMenu の「ビューアへ移動」項目**: 当初はサブメニュー (`MoveToViewerSubmenu`) で実装したが、ビューア数が少数 / 固定的なので **#57 でフラット化** し、現在のビューアを除く各ビューアを「`{name}` へ移動」トップレベル menuitem として並べる構成に変更。`viewers.length === 1` のときは項目ごと (および手前の divider) を非表示。`tab-context-menu-root` 共通 wrapper で click-outside 判定をスコープ。`setActiveViewer` は呼ばず src 側で作業継続 (VS Code "Move Editor to Other Group" と同等)。
   - **アクティブビューア切替時の listener cleanup**: `App.tsx` で `<ViewerGrid key={activeViewerId}>` を渡し、ビューア切替で完全 unmount/remount → 旧 panel の `ImageView` 効果クリーンアップが走り `zoomCommandBus` listener が確実に剥がれる。新 active panel が listener を再登録する流れに乗る。
   - **テスト**: Go state v6 ケース 8 種 (v5 ロスレス昇格 / v5 invalid layout fallback / v6 round-trip / 空配列 / activeViewerId mismatch / 重複 ID / 名前 sanitize / 上限 8 切詰め)、vitest viewers 39 ケース、`go test ./...` / `npm run test` 全通過、`tsc --noEmit` クリア、`wails build` 通過。

- **#47 画像削除 Phase 1 (実装完了)**: 一覧タブの Card 右クリックメニューから単一画像をゴミ箱に送れるようにする。spec は [docs/spec-image-delete.md](../docs/spec-image-delete.md)。バルク削除 / Delete キー / ConfirmDialog の danger variant は **Phase 2 へ後ろ倒し**。
   - **Go: `internal/imgfile.Trash`**: Windows は `SHFileOperationW` (FO_DELETE | FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT) を `shell32.dll` 経由で直接叩く。Linux/Mac dev ビルドは `os.Remove` フォールバック + warn log。go.mod に依存追加なし (`syscall.NewLazyDLL` のみ)。
   - **Go: `app.go::DeleteImage(folderPath, filename) error`**: 入力検証 (folderPath は abs、filename に `..` は不可) → `filepath.Join` で abs path 構築 → `imgfile.Trash` 呼び出し → 成否を logging で記録。sidecar 更新は **しない** (フロント側で既存 `SaveClassification` を呼ぶ二段階方式、§6.2)。
   - **`internal/imgfile/trash_other_test.go`**: Linux fallback の単体テスト 3 ケース (成功 / 不在ファイル / 読み取り専用 parent dir、root 実行時は permission ケース skip)。Windows SHFileOperationW は CI で実行不可のため Windows 実機での手動確認に依存。
   - **フロント: `useClassification.deleteOne(filename): Promise<boolean>`**: confirm → `DeleteImage` IPC → entries から filename を除去 → `SaveClassification` (既存 mtime 競合検出経路を流用)。conflict 時は reload + retry once、それでも失敗したら warn toast + entries はメモリ上だけ反映 (= 再 reload で正される)。戻り値 true = ファイルがディスクから消えた (呼び出し元はタブ close 可)。
   - **フロント: `layout.closeTabsForPathInLayout(layout, absPath)`** + **`useViewerSet.closeTabsForPath(absPath)`**: 全 viewer × 全 leaf を走査し、`tab.path === absPath` のタブを高 index 順に閉じる (同一 leaf 内の index ずれ回避)。leaf が空になれば既存 `closeTabInLeaf` の collapse 経路がそのまま発火。
   - **フロント: 右クリック UI**: `Card` に `onRequestContextMenu(x, y)` プロップ追加 (Card 全体 = `.cls-card` に `onContextMenu` を張って `preventDefault` + 親通知)。`ClassificationView` が `cardCtxMenu` state を持ち、新規 `CardContextMenu.tsx` (単一項目「削除」) を `(x, y)` に portal-less でレンダリング。chrome は `.tab-context-menu` を再利用、root wrapper `.cls-card-context-menu-root` で outside-click をスコープ、`.cls-card-context-item-danger` で 削除 hover/focus を赤系に。Esc / outside-click でクローズ。
   - **フロント: 結線**: `ClassificationView` に `onAfterDelete(absPath)` プロップ追加、`App.tsx` で `viewer.closeTabsForPath` を渡す。menu の 削除 → `setCardCtxMenu(null)` で先に閉じてから `deleteOne` を await (Modal 重なり / outside-click レース回避)。
   - **テスト**: Go 側に Linux fallback の trash テスト (成功 / 不在 / 権限) を追加、vitest に `closeTabsForPathInLayout` テスト (no-match / 単一 leaf 1 件 / 複数 leaf 跨ぎ / 同一 leaf 重複 / 空 leaf collapse の各ケース) を追加。`go test ./...` / `npm run test` 全通過、`tsc --noEmit` クリア。件数は最新の `npm run test` / `go test ./...` を参照 (AGENTS.md A-1)。
   - **未対応 (Phase 2)**: バルク削除、Delete キー、ConfirmDialog の danger variant、`image.deleteMode`/`image.deleteConfirm` 設定、Trash 非対応ドライブの fallback、ビューア側からの削除。

## 3. 重要ドキュメント (このディレクトリの兄弟ファイル)

| ファイル | 役割 |
|----------|------|
| [init.md](../init.md) | 元の要求 / 要件 / 仕様書。R1〜R7 の要求と F1〜F10 / N1〜N5 の要件、スコープ外項目、技術スタック決定の根拠が全て載っている。**変更しない**。 |
| [docs/todo.md](../docs/todo.md) | 実装着手前に決めるべき方針の決定ログ。A〜J の 10 カテゴリ。各項目に結論欄あり。**決定が増えたら追記**。 |
| [docs/spec-folder-tree.md](../docs/spec-folder-tree.md) | Phase 1 実装仕様書。**実装完了** (DoD §8 全項目 `[x]`)。 |
| [docs/spec-thumbnail.md](../docs/spec-thumbnail.md) | Phase 2 実装仕様書。**実装完了** (DoD §9 全項目 `[x]`)。 |
| [docs/spec-tab-imageview-3a.md](../docs/spec-tab-imageview-3a.md) | Phase 3a 実装仕様書 (単一パネル分)。**実装完了** (DoD §9 全項目 `[x]`)。 |
| [docs/spec-tab-imageview-3b.md](../docs/spec-tab-imageview-3b.md) | Phase 3b 実装仕様書 (グリッド分割 + タブ移動)。**実装完了** (DoD §9 全項目 `[x]`)。 |
| [docs/spec-tab-imageview-3c.md](../docs/spec-tab-imageview-3c.md) | Phase 3c 実装仕様書 (セッション復元 + F 部分確定)。**実装完了** (DoD §9 全項目 `[x]`)。 |
| [docs/spec-classification.md](../docs/spec-classification.md) | Phase 4 実装仕様書 (トップレベルタブ化 + 分類タブ + 競合検出 + 配色汎用化)。**実装完了**。受け入れ基準§12 の実機確認は要 `wails dev`。 |
| [docs/spec-viewer-flexlayout.md](../docs/spec-viewer-flexlayout.md) | Phase 5 実装仕様書 (BSP ツリー + DnD 自由分割)。**実装完了**。受け入れ基準§13 の実機確認は要 `wails dev`。Phase 3b の `spec-tab-imageview-3b.md` は本仕様で全面改定済み。 |
| [docs/spec-image-delete.md](../docs/spec-image-delete.md) | #47 画像削除 実装仕様書 (Phase 1: Card 右クリック単一削除のみ)。**Phase 1 実装完了**。バルク削除 / Delete キー / settings は Phase 2 へ後ろ倒し。 |
| [docs/spec-error-handling.md](../docs/spec-error-handling.md) | エラー境界条件の補足仕様 (壊れた画像 / 巨大画像 / アクセス権 / フォルダ消失)。 |
| [docs/new_thumbnail.md](../docs/new_thumbnail.md) | Phase 4 の元仕様 (汎用 v1.0)。`spec-classification.md` の§0 にすべての差分を集約済み。 |
| [README.md](../README.md) | ユーザー向けの使い方 (環境要件、`wails dev` / `wails build` 手順、現状スコープ)。 |

## 4. 確定済みの方針 (todo.md A〜C より要点抜粋)

詳細は [todo.md](../todo.md) を参照。ここでは実装で頻繁に参照する要点だけ。

### A. データ / API 設計 (確定)
- **画像配信**: Go バインディング経由で `[]byte` を返す (Wails が自動 base64 化)。サムネ・原寸とも同方式。AssetServer は使わない。キャッシュ判断は Go 側。
- **ツリー列挙**: 遅延展開 (lazy load)。`ListDirectory(path) ([]Node, error)` は一階層のみ。
- **型定義**: Wails 自動生成 (`wailsjs/go/...`) をそのまま使う。手書き TS 型は作らない。
- **パス**: 全レイヤで絶対パス統一。

### B. フォルダツリー (確定)
- 並び順: 名前昇順 (case-insensitive、dir/image 混在の単純名前順)。
- 隠しファイル非表示、シンボリックリンク追跡 (祖先一致で循環打ち切り)、空ディレクトリも表示。
- アイコンはフォルダ用 / 画像用 2 種、名前左に表示。インライン SVG (外部依存なし)。

### C. サムネイル (確定)
- 表示方式は **ホバーポップアップ** (250ms 遅延、ノード右側に 256px 角)。インラインは v1 で作らない。
- 形式は元画像維持 (JPG→JPG、PNG→PNG、GIF/WebP は 1 コマ目)、リサイズは BiLinear、生成失敗はエラーアイコン。
- 表示サイズ既定 256px、生成は 2× (HiDPI)、選択肢 128/192/256/384/512。
- アスペクト処理は枠固定で **既定レターボックス**。クロップは設定で切替可。
- 並行 worker 数既定 `runtime.NumCPU() / 2` (最低 1)。

### D. キャッシュ (確定)
- キー: `sha256(path + mtime + size)` の先頭 32 hex、`<2文字>/<30文字>.<元拡張子>` でシャーディング。
- パス階層: `os.UserCacheDir()/image-observer/cache/thumbnails/<mode>/<size>/<2>/<30>.<ext>`。
- 無効化: mtime/size 不一致で別キーになる (旧キャッシュは孤児として残る、v1 は掃除しない)。
- 上限: v1 は無制限。LRU は Phase H で再検討。
- クリア手段: v1 は UI なし。手動でフォルダ削除 (README に手順記載)。

### E 〜 J
未決。実装着手フェーズに合わせて随時 todo.md で詰める。

## 5. 技術スタック (固定)

| レイヤ | 採用 | バージョン |
|--------|------|-----------|
| デスクトップフレームワーク | Wails v2 | v2.12.0 |
| バックエンド | Go | **1.26.2** (goenv global、変更しない) |
| フロントエンド | React 18 + TypeScript + Vite | テンプレート初期値 |
| パッケージマネージャ (FE) | npm | 10.x |
| 画像デコード追加 | `golang.org/x/image/webp` | Phase 2 で導入済み |
| サムネリサイズ | `golang.org/x/image/draw` | Phase 2 で導入済み |
| WebP エンコード | **使わない** (PNG フォールバック方針確定) | cgo 依存回避のため |
| FE 状態管理 | React `useState` / `useReducer` のみ | 外部ライブラリ未導入 |
| アイコン | インライン SVG | 外部ライブラリ不要 |

## 6. 開発環境の特殊事情

- **開発機は WSL2 (Ubuntu 22.04) 上**。エンドユーザーターゲットは Windows 10/11 だが、開発時は Linux ネイティブビルドで動作確認している (ユーザー判断: dev は Linux ビルドで十分)。
- `wails build` は Linux ELF (`build/bin/image-observer`) を生成する。Windows EXE は別途 Windows ホストでのビルドかクロスコンパイルが必要 (現フェーズでは未着手)。
- **Go バージョンは goenv global (`~/.goenv/version`) に従う**。プロジェクトに `.go-version` は置かない方針。Go install 系 CLI (wails 本体) は global Go バージョンの GOPATH/bin に紐づく点に注意。
- `main.go` で `MinWidth: 400` / `MinHeight: 300` を設定済み。これがないと Linux/GTK で初期 Width が事実上の最小幅になり、横方向リサイズができない。

## 7. 開発コマンド

```bash
# 開発 (ホットリロード、ネイティブウィンドウが開く)
wails dev

# リリースビルド
wails build

# Go テスト (Phase 1 以降)
go test ./...

# Wails 環境チェック
wails doctor
```

## 8. ファイル構成 (現時点)

```
image-observer/
├── .claude/
│   └── context.md           # このファイル
├── .git/
├── .gitignore               # Wails / Node / Go / IDE 4セクション
├── CLAUDE.md                # プロジェクトルール (一次ソース優先順位 / クイックリファレンス)
├── README.md                # ユーザー向け使い方
├── init.md                  # 元の要求/要件/仕様 (R1〜R7 / F1〜F10)
├── docs/                    # 全ドキュメント (todo.md と各 spec-*.md はここ)
│   ├── todo.md                  # 決定ログ (A〜F 確定、G〜J 未決)
│   ├── spec-folder-tree.md      # Phase 1 実装仕様 (完了)
│   ├── spec-thumbnail.md        # Phase 2 実装仕様 (完了)
│   ├── spec-tab-imageview-3a.md # Phase 3a 実装仕様 (完了)
│   ├── spec-tab-imageview-3b.md # Phase 3b 実装仕様 (完了)
│   ├── spec-tab-imageview-3c.md # Phase 3c 実装仕様 (完了)
│   ├── spec-classification.md   # Phase 4 実装仕様 (完了)
│   ├── spec-error-handling.md   # G エラー境界条件の補足仕様
│   ├── new_thumbnail.md         # Phase 4 元仕様 (汎用 v1.0)
│   └── new_thumbnail/           # 参考 HTML / CSV サンプル
├── app.go                   # 薄いバインディング層 (Thumb/ImgRead/State/Classification への委譲 + CONFLICT: プレフィクス付け)
├── main.go                  # エントリポイント、Wails オプション、起動時 state.Load、OnStartup で WindowSetPosition
├── internal/
│   ├── imgfile/             # package imgfile (依存なし、IsImage の単独パッケージ)
│   │   ├── imgfile.go       # IsImage (5 拡張子: jpg/jpeg/png/gif/webp)
│   │   └── imgfile_test.go  # 1 ケース
│   ├── thumb/               # package thumb (imgfile.IsImage に依存)
│   │   ├── thumb.go         # Result, Config 型 + Get (exported) + 内部オーケストレーション
│   │   ├── defaults.go      # ハードコード設定 (将来 settings に置換)
│   │   ├── cache.go         # cacheKey / cacheFilePath / outputExtFor / mimeFor
│   │   ├── decode.go        # JPEG/PNG/GIF/WebP デコード (アニメは1コマ目)
│   │   ├── resize.go        # BiLinear letterbox/crop
│   │   ├── encode.go        # JPEG/PNG/GIF エンコード (WebP→PNG フォールバック)
│   │   ├── pool.go          # sem + inflight dedup の worker pool
│   │   └── thumb_test.go    # 11 ケース
│   ├── imgread/             # package imgread (imgfile.IsImage に依存)
│   │   ├── imgread.go       # Result / Info 型 + Read / ReadInfo (exported) + 寸法ヘルパ
│   │   └── imgread_test.go  # 7 ケース
│   ├── classification/      # package classification (imgfile.IsImage に依存)
│   │   ├── types.go         # Entry / Confidence / Classification / LoadResult / SaveOutput / ErrConflict / MergePreview / ChildSidecarSummary (v1.2)
│   │   ├── repository.go    # SidecarRepository: JSON/CSV 読み込み + atomic write + .bak ローテ + mtime 競合検出 (UnixMilli)
│   │   ├── repository_test.go
│   │   ├── scanner.go       # FileScanner: filepath.WalkDir 再帰スキャン + 隠しディレクトリスキップ + POSIX 相対パス (v1.2)
│   │   ├── scanner_test.go  # 再帰 / 隠し / sidecar 除外 / 不在
│   │   ├── service.go       # Service: Load (マージ) / Save / UpdateEntry / CreateEmpty
│   │   ├── service_test.go
│   │   ├── merge.go         # Service.PreviewChildSidecars / MergeChildSidecars (v1.2 子→親マージ)
│   │   ├── merge_test.go
│   │   └── testhelpers_test.go  # 共有テストヘルパ (equalSlice)
│   └── state/               # package state (依存なし)
│       ├── state.go         # StateData (v6: Viewers []ViewerState + ActiveViewerID) / ViewerState / LayoutState / LayoutNodeState (タグ付きユニオン) / TabState / WindowState / ListTabState + Load + Save + DefaultData
│       ├── migration_v5.go  # v5 → v6 ロスレス昇格 (旧 Layout 単数を 1 ビューアに包む)
│       └── state_test.go    # 17 ケース (v4 round-trip + ratio clamp + activeId fallback + duplicate-id reject 含む)
├── go.mod / go.sum
├── wails.json               # Wails 設定
├── build/                   # アイコン、Windows manifest、ビルド成果物
│   └── bin/image-observer   # 直近の Linux ビルド
└── frontend/
    ├── package.json         # vitest 導入済み (scripts.test = "vitest run")
    ├── tsconfig.json        # moduleResolution: Bundler
    ├── vite.config.ts
    ├── index.html
    ├── wailsjs/             # Wails 自動生成 (App.d.ts, models.ts 等)
    └── src/
        ├── main.tsx
        ├── App.tsx          # 2 段階 mount: useSessionLoad → AppInner で TopTabs + ClassificationView/ViewerGrid 切替 + 各 hook に initial state 注入 + onOpenInViewer (一覧 → ビューア結線、setTopTab + viewer.openInActive) + WindowGetSize/Position ポーリング + useSessionSave
        ├── App.css          # ダーク配色 + トップタブ + 分類 (cls-*) + タブ/ビューア/グリッド/コンテキストメニュー CSS (左ペイン/ツリー/ライトボックス系は削除済み)
        ├── style.css        # テンプレ既定
        ├── vite-env.d.ts
        ├── features/               # 機能境界 (Go internal/ と対応)
        │   ├── classification/    # ↔ internal/classification (Phase 4 新設、左ペイン廃止と入れ替え)
        │   │   ├── ClassificationView.tsx    # 一覧タブ統括 (Header + TagChips + ConfidenceSegment + SearchBox + DirectoryGroup × N + EditPopover + ConflictDialog + MergePromptDialog)
        │   │   ├── ClassificationHeader.tsx  # フォルダパス + 件数 (絞り込み後/全件) + 開く/再読み込み
        │   │   ├── TagChips.tsx              # タグチップ列 (件数併記、OR 選択、すべて解除)
        │   │   ├── ConfidenceSegment.tsx     # 信頼度セグメントコントロール (all/high/mid/low)
        │   │   ├── SearchBox.tsx             # 検索ボックス (filename + note 部分一致、150ms debounce は親で)
        │   │   ├── DirectoryGroup.tsx        # アコーディオン 1 セクション (ヘッダ + 折りたたみ + Card 群) (v1.2)
        │   │   ├── Card.tsx                  # 1 枚の分類カード (サムネ + filename ellipsis + folder/conf バッジ + note + 編集アイコン)
        │   │   ├── EditPopover.tsx           # 編集ポップオーバー (folder/confidence/note + 既存タグサジェスト + Esc/Ctrl+Enter)
        │   │   ├── colors.ts                 # FNV-1a ハッシュ + KNOWN_TAG_COLORS + tagColor / readableTextColor / folderClass
        │   │   ├── colors.test.ts            # vitest: 11 ケース
        │   │   ├── defaultPalette.ts         # 初期既知タグ→色マップ (Phase H で settings.json に逃がす予定)
        │   │   ├── filters.ts                # extractTags (主+sub 抽出) / tagSummary / applyFilter (タグ AND 信頼度 AND 検索)
        │   │   ├── filters.test.ts           # vitest: 15 ケース
        │   │   ├── groups.ts                 # groupByDirectory / groupKeyOf 純関数 (v1.2)
        │   │   ├── groups.test.ts            # vitest: 9 ケース
        │   │   ├── useClassification.ts      # 一覧タブの状態管理 (load/filter/edit/conflict/merge prompt/groups collapsed)
        │   │   ├── useDirectoryGroups.ts     # アコーディオン折りたたみ状態 (collapsedList を Set で公開) (v1.2)
        │   │   └── useGridThumbnail.ts       # IntersectionObserver 遅延ロード + module-scoped Map キャッシュ + inflight dedup
        │   ├── viewer-grid/        # ↔ internal/imgread (Phase 5 で BSP ツリー + DnD 化)
        │   │   ├── ViewerGrid.tsx      # ビューアタブ全体: panel-tree (Layout 再帰描画) + TabContextMenu + TabDragGhost
        │   │   ├── Panel.tsx           # 1 パネル: TabBar + ImageView + DropOverlay + active 枠 + 画像領域右クリックでタブメニュー
        │   │   ├── GridSplitter.tsx    # 任意 SplitNode の境界スプリッター (MIN_PX=100 + MIN_RATIO=0.05)
        │   │   ├── TabContextMenu.tsx  # タブ右クリック: 閉じる / 右に分割 / 下に分割 (Phase 5 で 3 項目に縮小)
        │   │   ├── TabBar.tsx          # タブ一覧 + DnD 開始 (onPointerDown) + 並び替え insert indicator + ホイール横スクロール
        │   │   ├── ImageView.tsx       # 1 枚の画像表示 + zoom/pan + post-restore clampPan
        │   │   ├── DropOverlay.tsx     # ドロップ中 zone インジケータ (4 辺 / center) (Phase 5)
        │   │   ├── TabDragGhost.tsx    # ドラッグ中のカーソル追従ゴースト (Phase 5)
        │   │   ├── layout/            # BSP レイアウト純関数 (Phase 5、#68 で機能別モジュール化。`./layout` 表面は維持)
        │   │   │   ├── index.ts          # 旧 layout.ts と同じ public surface の re-export バレル
        │   │   │   ├── types.ts          # SplitNode / LeafNode / LayoutNode / Layout 型 + 定数 (MIN_RATIO / MAX_PANELS) + newNodeId
        │   │   │   ├── tree.ts           # 構築子 + 走査 (findNode / findLeaf / findParent / enumerateLeaves / countLeaves) + 純更新 (replaceNode / updateLeaf / updateSplit / collapseEmptyLeaf)
        │   │   │   ├── validation.ts     # validateLayout / clampRatio
        │   │   │   ├── serialization.ts  # serialize / deserialize + layoutFromPersisted (Wails state 型の narrowing)
        │   │   │   ├── active.ts         # pickNewActiveId / recomputeActiveAfterClose
        │   │   │   └── operations.ts     # 高水準操作 (move / reorder / split / close / setActive / updateTab / setSplitRatio / appendOrFocus) + SplitResult 型
        │   │   ├── layout.test.ts      # vitest (Phase 5)
        │   │   ├── useDnD.ts           # pointer events 自前 + elementFromPoint で hit test (Phase 5)
        │   │   ├── useTabs.ts          # Tab 型と newTab ファクトリのみ
        │   │   ├── viewers.ts         # ViewerSet 純関数 (#11): add/close/rename/setActive/suggestViewerName/moveTabAcrossViewers
        │   │   ├── viewers.test.ts    # vitest (#11)
        │   │   ├── useViewerSet.ts    # ViewerSet 全体管理 + active viewer の panel-level mutation を delegate (旧 useViewerGrid を置換)
        │   │   └── useViewerSet.helpers.ts # ステートレス補助関数 (#65): leafTabsCount / openPathAsSplitOrAppend
        │   └── session/            # ↔ internal/state (永続化グルー)
        │       ├── useSessionLoad.ts   # 起動時 GetState (2 段階 mount)
        │       └── useSessionSave.ts   # 500ms debounce で SaveState (v4 schema: layout + topTab + list)
        ├── shared/                 # 機能横断ユーティリティ (どの feature からも import 可)
        │   ├── components/         # 機能横断 UI 部品
        │   │   ├── ModalShell.tsx      # ダイアログ共通シェル (portal + overlay + Esc + focus trap + UI scale) (#30)
        │   │   ├── ConfirmDialog.tsx   # 確認ダイアログ + useConfirm() (ModalShell 上に薄く)
        │   │   ├── ConflictDialog.tsx  # 競合解決 3 ボタン (再読み込み / 強制上書き / キャンセル)
        │   │   ├── MergePromptDialog.tsx # 子→親マージ確認 3 ボタン (v1.2)
        │   │   └── Toast.tsx           # トースト + ToastProvider + useToastFn()
        │   ├── icons/                  # インライン SVG アイコン (外部依存なし)
        │   │   ├── ChevronIcon.tsx
        │   │   ├── CloseIcon.tsx
        │   │   ├── EditIcon.tsx
        │   │   ├── FolderIcon.tsx       # className を受け取る (no-perm 等の状態色用)
        │   │   ├── ImageIcon.tsx
        │   │   ├── MinusIcon.tsx
        │   │   ├── PlusIcon.tsx
        │   │   ├── ReloadIcon.tsx
        │   │   ├── SearchIcon.tsx
        │   │   ├── SpinnerIcon.tsx
        │   │   └── ThumbErrorIcon.tsx
        │   └── utils/
        │       ├── base64.ts           # Wails []byte の number[] / string 両対応 base64 変換
        │       ├── bodyStyles.ts       # body の cursor / userSelect を競合なく差し替えるトークンスタック (#30)
        │       ├── debounce.ts         # useDebounce ヘルパ
        │       ├── error.ts            # errorMessage (Error/string/その他から表示用文字列を取り出す)
        │       └── path.ts             # basename (path セパレータを正規化して末尾要素を返す)
        └── assets/
```

Phase 3 / 4 完了。残るは Phase G (エラー UX 改善) / H (キーボードショートカット + 設定 UI + テーマ + 既知タグ配色 settings.json 化) / I (配布) / J (CI / テスト拡充) を docs/todo.md で詰めて段階的に進める。

## 9. スコープ外 (v1 で作らない、提案前に必ず確認)

[init.md §2.3](../init.md) ベース。**ただし docs/todo.md で修正された項目があるため必ず docs/todo.md も合わせて確認すること**。

- 画像の編集、回転保存、メタデータ編集
- 複数フォルダ同時オープン
- Mac / Linux **本番** 対応 (開発時の動作確認は OK)
- アニメーション WebP のコマ送り制御
- RAW、HEIC、TIFF、SVG など対象外フォーマット
- ペインのドッキング、フローティング (フローティングウィンドウは作らない)

**init.md / 過去決定への仕様変更履歴** (docs/todo.md 確定済み):

- init.md §2.3 ~~ペインの 3 分割以上~~ → **取り下げ**: ビューア領域は **BSP ツリー + DnD で自由分割** (上限 16 パネル) を v1 でサポート (Phase 5)。Phase 3b 時点では「最大 2 行 × 3 列 = 6 パネルの固定グリッド」だったが、Phase 5 で BSP に置換された (todo.md E3)。
- init.md F5 ~~「同一画像は既存タブにフォーカス」~~ → **修正**: アクティブパネル内のみ既存タブフォーカス、他パネルでは新規タブを開く (todo.md E2)。
- todo.md E9 ~~「EXIF Orientation を尊重する」~~ → **改定: v1 非対応**。原寸表示を再エンコードしない方針 (画質劣化回避) と整合性が取れない、かつ実装ボリュームが見合わないため。スマホ写真の縦横崩れは許容。
- init.md R1 ~~「左にフォルダ、右に画像ビューアの2ペイン構成」~~ → **改定: トップレベルタブ化**。Phase 4 で左ペイン (フォルダツリー) を廃止し「一覧 / ビューア」のトップタブに再編 (docs/spec-classification.md)。

## 10. 進め方の原則

- **要件は init.md、決定は docs/todo.md、フェーズの実装は docs/spec-*.md を一次ソースとする**。これらと矛盾する変更は事前にユーザー合意を取る。
- 仕様変更が要件レベル (init.md) に及ぶ場合 (例: Phase 1 着手前に出た「サムネをホバーポップアップに」案) は、必ず docs/todo.md に新規項目として記録し未決を可視化してから進める。
- フェーズ完了時は docs/todo.md の対象項目をチェック更新し、次フェーズの docs/spec-*.md を起こしてから実装に入る。
- ユーザーは 1 人開発、開発機は WSL2、リリース対象は Windows。テスト・配布の手間が増える施策は事前に意思確認する。

## 11. Go パッケージ境界 (2026-05-10 Phase 5 反映)

- **`main`**: `main.go` (Wails オプション + 起動) と `app.go` (Wails バインディング層、各 internal パッケージへの薄い委譲 + `CONFLICT:` プレフィクスのエラー整形) のみ。新しいビジネスロジックを `main` に書かない。
- **`internal/imgfile`**: 画像拡張子判定 + 画像ファイル削除 (#47)。エクスポート: `IsImage(name)`、`Trash(absPath)`。`Trash` は Windows ビルドで `shell32!SHFileOperationW` をゴミ箱送り (`FO_DELETE | FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT`) として呼び出し、非 Windows ビルド (Linux dev) では `os.Remove` フォールバック + `internal/logging.Warn` ログ。`syscall.NewLazyDLL` のみで `golang.org/x/sys/windows` は不要。Phase 4 で `internal/tree` から切り出し (`tree` 廃止)、#47 で Trash を追加。
- **`internal/thumb`**: サムネイル生成 + ディスクキャッシュ。エクスポート: `Result`、`Config`、`Get(path, size, mode)`。`imgfile.IsImage` に依存。
- **`internal/imgread`**: 原寸画像読み出し + 寸法取得。エクスポート: `Result`、`Info`、`Read(path)`、`ReadInfo(path)`。`imgfile.IsImage` に依存。
- **`internal/classification`**: サイドカー (`_classification.json` 正本 + `.csv` 初回 import) ベースの分類メタデータ。エクスポート: `Service`、`Entry`、`Confidence`、`LoadResult`、`SaveOutput`、`ErrConflict`、`NewService` / `NewFileRepository` / `NewFileScanner`。`imgfile.IsImage` に依存。`mtime` ベースの楽観的ロック (`expectedMtime` 不一致で `ErrConflict`)。
- **`internal/state`**: セッション状態の永続化 (**v6** スキーマ: 複数ビューア対応で `Layout LayoutState` 単数を `Viewers []ViewerState` + `ActiveViewerID` に置換)。エクスポート: `StateData` / `ViewerState` ほか各 JSON 型 (`LayoutState` / `LayoutNodeState` / `TabState` / `ListTabState` / `WindowState`)、`Load()`、`Save(s)`、`DefaultData()`、`StateSchemaVersion`。依存: `crypto/rand` (viewer ID 生成)。`LayoutNodeState` は `kind: "split" | "leaf"` 判別のタグ付きユニオン (Go では全フィールドを 1 構造体に持たせる方式)。`Load()` は version=6 を strict-parse、version=5 は `migration_v5.go` でロスレス昇格 (1 ビューアに packing)、それ以外は DefaultData fallback。`validateState` は viewer 数 (1..maxViewers=8) / 名前 sanitize (rune 32 文字 + 制御文字除去) / activeViewerId 解決 / 重複 ID 拒否を実施。
- **`internal/logging`** (Phase 5 補足): ファイルベースの追記ロガー。エクスポート: `Init()`/`Close()`/`Debug`/`Info`/`Warn`/`Error`/`Log`/`SetLevel`/`CurrentLevel`/`LogPath`/`ParseLevel`。`<UserCacheDir>/image-observer/logs/app.log` に 2MB × 3 ファイルでローテーション。env > log_level.txt > 既定 INFO の優先順で resolve、`SetLevel` で runtime 切替。Go 標準 `log` を redirect するロックド writer も内蔵。依存なし。
- **`internal/settings`** (Phase H1 + #14 拡張 + #10/#12): ユーザー設定の永続化 (state とは別ファイル)。エクスポート: 型 `SettingsData` (`LogLevel` / `MultiSelectMode` / `WheelMode` / `MaxImagePixelsMP` / `ThumbnailSize` / `ThumbnailMode` / `ThumbnailWorkerCount` / `TagColors` / `UIScalePercent`)、関数 `Load()` / `Save(s)` / `Validate()` / `DefaultSettings()`、定数 `SettingsSchemaVersion` / `MultiSelectCheckbox` / `MultiSelectModifier` / `MultiSelectBoth` / `WheelModeZoom` / `WheelModeShiftZoom` / `ThumbnailModeLetterbox` / `ThumbnailModeCrop`。`defaultTagColors` シードマップは同パッケージ非公開 (export すると map の参照型を通じて外部から書き換えられるため)。`<UserConfigDir>/image-observer/settings.json` に書き出し、per-field fallback で壊れた値だけリセット (タグ色マップは個別 drop)。依存なし。schema は v1 のまま (additive 拡張)。
- パッケージ間依存は単方向 (`state` → 依存なし、`imgfile` は非 Windows ビルド時のみ `logging` に依存 (#47 Trash fallback の warn log)、`thumb` / `imgread` / `classification` → `imgfile`)。循環参照を避ける。
- 新機能を追加する際は適切な internal パッケージを選び、`app.go` には Wails バインディング用の薄いラッパだけを置く。Wails の TS バインディングは Go パッケージ単位で namespace を生成する (`thumb.Result`、`classification.Entry` など) ので、フロント側の型 import もそれに合わせる。

## 12. フロント feature 境界 (2026-05-10 Phase 5 反映)

- `frontend/src/features/classification/`: 一覧 (分類) タブの UI 一式 + フィルタ / 配色純関数。`internal/classification` に対応。`useGridThumbnail` で IntersectionObserver + module-scoped Map キャッシュを実装。`filters.ts` / `colors.ts` / `groups.ts` は vitest でユニットテスト済み。
- `frontend/src/features/viewer-grid/`: ビューアタブ (BSP ツリー / DnD / 画像表示)。`internal/imgread` に対応。`layout/` (純関数モジュール群; types/tree/validation/serialization/active/operations、#68 で分割) は vitest でユニットテスト済み、`useDnD.ts` は pointer events 自前 + `elementFromPoint` でドロップ先を解決。
- `frontend/src/features/session/`: セッションの保存/復元グルー。`internal/state` に対応。`useSessionSave` のみ `viewer-grid/layout` の `Layout` 型と `serializeLayout` を import するクロス feature 依存を持つ (永続化が各 feature の状態を集約するため許容)。
- `frontend/src/shared/components/` `shared/icons/` `shared/utils/`: 機能横断 UI 部品 / アイコン / ユーティリティ。どの feature からも import 可。逆に shared 側から features を import しない。
- `App.tsx` のみ複数 feature を組み合わせるオーケストレーション層 (TopTabs + ToastProvider + useConfirm + useSessionLoad/Save)。新規コンポーネント/フックは原則どれかの feature 配下に置く。横断的に再利用するユーティリティが出てきた場合のみ shared/ に昇格させる。
- フロントテスト: `frontend/` で `npm run test` (vitest)。純関数のユニットテスト中心 (DOM テストは未導入、必要になれば happy-dom / jsdom + @testing-library/react を別途検討)。
