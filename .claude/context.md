# image-observer プロジェクトコンテキスト

新規セッションでこのプロジェクトを開いた Claude が、まず読んで全体像を把握するためのファイル。詳細は本文中で参照しているドキュメントを参照する。

最終更新: 2026-04-26 (Phase 0/1/2/3a/3b/3c すべて実装完了。Go コードを `internal/{tree,thumb,imgread,state}` に分割整理。次は仕上げフェーズ G/H/I/J)

---

## 1. プロジェクトの一行説明

Wails v2 (Go バックエンド + React/TS フロント) で実装する **Windows 向け画像ビューア**。VSCode 風の 2 ペイン UI に「フォルダツリー上での画像サムネイル表示」を加えたものを作る (VSCode に欠けている機能の補完が動機)。

## 2. 現在のフェーズ

**Phase 0 / 1 / 2 すべて実装完了。Phase 3 は 3a/3b/3c の 3 段階に分割、Phase 3a spec 確定済み。**

- Phase 0: 2 ペインの空シェル UI、スプリッターでペイン幅可変。
- Phase 1: フォルダ選択 + 遅延ツリー描画 (アイコン / ホバー / エラー / ローディング表示込み)。
- Phase 2: ホバーポップアップでサムネ表示。Go 側に `GetThumbnail` API + worker pool + シャーディングキャッシュ (`os.UserCacheDir()/image-observer/cache/thumbnails/<mode>/<size>/<2>/<30>.<ext>`)。WebP は PNG フォールバック (cgo 依存回避のため)。Go テスト 11 ケース全パス、`wails build` パス済み。
- **Phase 3a (実装完了)**: 単一パネル + タブ + 画像表示 + ズーム/パン + 背景 (チェッカ柄)。EXIF Orientation は v1 非対応 (todo.md E9 改定)。原寸表示は再エンコードせずディスクバイトをそのまま返す方針。spec は [spec-tab-imageview-3a.md](../spec-tab-imageview-3a.md)。
- **Phase 3b (実装完了)**: ビューア領域を最大 2 行 × 3 列 = 6 パネルのグリッドに分割 + アクティブパネル (青枠ハイライト) + パネル間タブ移動 (右クリックメニュー)。`useViewerGrid` hook で全状態を一元管理、`MAX_ROWS / MAX_COLS` 定数で将来 UI 化の境界を分離。Go 側変更なし。spec は [spec-tab-imageview-3b.md](../spec-tab-imageview-3b.md)。
- **Phase 3c (実装完了)**: セッション復元。`os.UserConfigDir()/image-observer/state.json` にアトミック書き込み、debounce 500ms。Go 側 `GetState` / `SaveState` + `main.go` 起動時 loadState + OnStartup で `WindowSetPosition`。フロントは `useSessionLoad` (2 段階 mount) + `useSessionSave` (`JSON.stringify` で stable diff) + `useTree` / `useViewerGrid` の `initialRootPath` / `initialGrid` 注入 + ImageView の post-restore `clampPan`。spec は [spec-tab-imageview-3c.md](../spec-tab-imageview-3c.md)。todo.md F は本フェーズで部分確定済み (設定値の永続化は Phase H で別ファイル `settings.json`)。

## 3. 重要ドキュメント (このディレクトリの兄弟ファイル)

| ファイル | 役割 |
|----------|------|
| [init.md](../init.md) | 元の要求 / 要件 / 仕様書。R1〜R7 の要求と F1〜F10 / N1〜N5 の要件、スコープ外項目、技術スタック決定の根拠が全て載っている。**変更しない**。 |
| [todo.md](../todo.md) | 実装着手前に決めるべき方針の決定ログ。A〜J の 10 カテゴリ。各項目に結論欄あり。**決定が増えたら追記**。 |
| [spec-folder-tree.md](../spec-folder-tree.md) | Phase 1 実装仕様書。**実装完了** (DoD §8 全項目 `[x]`)。 |
| [spec-thumbnail.md](../spec-thumbnail.md) | Phase 2 実装仕様書。**実装完了** (DoD §9 全項目 `[x]`)。 |
| [spec-tab-imageview-3a.md](../spec-tab-imageview-3a.md) | Phase 3a 実装仕様書 (単一パネル分)。**実装完了** (DoD §9 全項目 `[x]`)。 |
| [spec-tab-imageview-3b.md](../spec-tab-imageview-3b.md) | Phase 3b 実装仕様書 (グリッド分割 + タブ移動)。**実装完了** (DoD §9 全項目 `[x]`)。 |
| [spec-tab-imageview-3c.md](../spec-tab-imageview-3c.md) | Phase 3c 実装仕様書 (セッション復元 + F 部分確定)。**実装完了** (DoD §9 全項目 `[x]`)。 |
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
├── README.md                # ユーザー向け使い方
├── init.md                  # 元の要求/要件/仕様
├── todo.md                  # 決定ログ (A〜F 確定、G〜J 未決)
├── spec-folder-tree.md      # Phase 1 実装仕様 (完了)
├── spec-thumbnail.md        # Phase 2 実装仕様 (完了)
├── spec-tab-imageview-3a.md # Phase 3a 実装仕様 (完了)
├── spec-tab-imageview-3b.md # Phase 3b 実装仕様 (完了)
├── spec-tab-imageview-3c.md # Phase 3c 実装仕様 (完了)
├── app.go                   # 薄いバインディング層 (各 internal パッケージへの委譲)
├── main.go                  # エントリポイント、Wails オプション、起動時 state.Load、OnStartup で WindowSetPosition
├── internal/
│   ├── tree/                # package tree
│   │   ├── tree.go          # Node 型 + List + IsImage (exported)
│   │   ├── tree_unix.go     # //go:build !windows: isHidden
│   │   ├── tree_windows.go  # //go:build windows: isHidden
│   │   └── tree_test.go     # 7 ケース
│   ├── thumb/               # package thumb (tree.IsImage に依存)
│   │   ├── thumb.go         # Result, Config 型 + Get (exported) + 内部オーケストレーション
│   │   ├── defaults.go      # ハードコード設定 (将来 settings に置換)
│   │   ├── cache.go         # cacheKey / cacheFilePath / outputExtFor / mimeFor
│   │   ├── decode.go        # JPEG/PNG/GIF/WebP デコード (アニメは1コマ目)
│   │   ├── resize.go        # BiLinear letterbox/crop
│   │   ├── encode.go        # JPEG/PNG/GIF エンコード (WebP→PNG フォールバック)
│   │   ├── pool.go          # sem + inflight dedup の worker pool
│   │   └── thumb_test.go    # 11 ケース
│   ├── imgread/             # package imgread (tree.IsImage に依存)
│   │   ├── imgread.go       # Result 型 + Read (exported) + 寸法ヘルパ
│   │   └── imgread_test.go  # 7 ケース
│   └── state/               # package state
│       ├── state.go         # StateData / GridState / PanelState / TabState / WindowState / PanelCoordSt 型 + Load + Save + DefaultData
│       └── state_test.go    # 9 ケース
├── go.mod / go.sum
├── wails.json               # Wails 設定
├── build/                   # アイコン、Windows manifest、ビルド成果物
│   └── bin/image-observer   # 直近の Linux ビルド
└── frontend/
    ├── package.json
    ├── tsconfig.json        # moduleResolution: Bundler
    ├── vite.config.ts
    ├── index.html
    ├── wailsjs/             # Wails 自動生成 (App.d.ts, models.ts 等)
    └── src/
        ├── main.tsx
        ├── App.tsx          # 2 段階 mount: useSessionLoad → AppInner で各 hook に initial state 注入 + WindowGetSize/Position ポーリング + useSessionSave
        ├── App.css          # ダーク配色 + ツリー/ボタン/スピナー/サムネポップアップ/タブ/ビューア/グリッド/コンテキストメニュー CSS
        ├── style.css        # テンプレ既定
        ├── vite-env.d.ts
        ├── components/
        │   ├── FolderPanel.tsx     # ピッカー + ツリー + ThumbnailPopup を統括
        │   ├── TreeNode.tsx        # 画像ノードに onMouseEnter/Leave で thumb 連携、クリックで onImageOpen
        │   ├── ThumbnailPopup.tsx  # ホバー時の浮きポップアップ
        │   ├── ViewerGrid.tsx      # 右ペイン全体: GridToolbar + Panel × N + GridSplitter + TabContextMenu
        │   ├── GridToolbar.tsx     # [+行] [+列] [-行] [-列] ボタン
        │   ├── Panel.tsx           # 1 パネル: TabBar + ImageView + active 枠 + 画像領域右クリックでタブメニュー
        │   ├── GridSplitter.tsx    # 行/列スプリッター (100px 最小クランプ)
        │   ├── TabContextMenu.tsx  # タブ/画像右クリック: 閉じる + 別パネルへ移動
        │   ├── TabBar.tsx          # タブ一覧 + クローズ + 中クリッククローズ + ホイール横スクロール + onContextMenu
        │   └── ImageView.tsx       # 1 枚の画像表示 + zoom/pan + post-restore clampPan
        ├── icons/
        │   ├── ChevronIcon.tsx
        │   ├── FolderIcon.tsx
        │   ├── ImageIcon.tsx
        │   ├── SpinnerIcon.tsx
        │   ├── ThumbErrorIcon.tsx
        │   ├── CloseIcon.tsx
        │   ├── PlusIcon.tsx
        │   └── MinusIcon.tsx
        ├── hooks/
        │   ├── useTree.ts          # ツリー状態。initialRootPath で復元 + 自動 loadChildren
        │   ├── useThumbnail.ts     # ホバー遅延 + キャッシュ Map + GetThumbnail 呼び出し
        │   ├── useTabs.ts          # Tab 型と newTab ファクトリのみ
        │   ├── useViewerGrid.ts    # グリッド全体の状態管理 (MAX_ROWS/MAX_COLS 定数 + initialGrid 注入)
        │   ├── useSessionLoad.ts   # 起動時 GetState (2 段階 mount)
        │   └── useSessionSave.ts   # 500ms debounce で SaveState
        ├── utils/
        │   ├── base64.ts           # Wails []byte の number[] / string 両対応 base64 変換
        │   └── debounce.ts         # useDebounce ヘルパ
        └── assets/
```

Phase 3 シリーズ完結。残るは Phase G (エラー UX 改善) / H (キーボードショートカット + 設定 UI + テーマ等) / I (配布) / J (CI/テスト) を todo.md で詰めて段階的に進める。

## 9. スコープ外 (v1 で作らない、提案前に必ず確認)

[init.md §2.3](../init.md) ベース。**ただし todo.md で修正された項目があるため必ず todo.md も合わせて確認すること**。

- 画像の編集、回転保存、メタデータ編集
- 複数フォルダ同時オープン
- Mac / Linux **本番** 対応 (開発時の動作確認は OK)
- アニメーション WebP のコマ送り制御
- RAW、HEIC、TIFF、SVG など対象外フォーマット
- ペインのドッキング、フローティング (フローティングウィンドウは作らない)

**init.md / 過去決定への仕様変更履歴** (todo.md 確定済み):

- init.md §2.3 ~~ペインの 3 分割以上~~ → **取り下げ**: ビューア領域は最大 2 行 × 3 列 = 6 パネルのグリッド分割を v1 でサポート (todo.md E3)。
- init.md F5 ~~「同一画像は既存タブにフォーカス」~~ → **修正**: アクティブパネル内のみ既存タブフォーカス、他パネルでは新規タブを開く (todo.md E2)。
- todo.md E9 ~~「EXIF Orientation を尊重する」~~ → **改定: v1 非対応**。原寸表示を再エンコードしない方針 (画質劣化回避) と整合性が取れない、かつ実装ボリュームが見合わないため。スマホ写真の縦横崩れは許容。

## 10. 進め方の原則

- **要件は init.md、決定は todo.md、フェーズの実装は spec-*.md を一次ソースとする**。これらと矛盾する変更は事前にユーザー合意を取る。
- 仕様変更が要件レベル (init.md) に及ぶ場合 (例: Phase 1 着手前に出た「サムネをホバーポップアップに」案) は、必ず todo.md に新規項目として記録し未決を可視化してから進める。
- フェーズ完了時は todo.md の対象項目をチェック更新し、次フェーズの spec-*.md を起こしてから実装に入る。
- ユーザーは 1 人開発、開発機は WSL2、リリース対象は Windows。テスト・配布の手間が増える施策は事前に意思確認する。

## 11. Go パッケージ境界 (2026-04-26 整理)

- **`main`**: `main.go` (Wails オプション + 起動) と `app.go` (Wails バインディング層、各 internal パッケージへの薄い委譲) のみ。新しいビジネスロジックを `main` に書かない。
- **`internal/tree`**: フォルダツリー列挙。エクスポート: `Node`、`List(path)`、`IsImage(name)`。
- **`internal/thumb`**: サムネイル生成 + ディスクキャッシュ。エクスポート: `Result`、`Config`、`Get(path, size, mode)`。`tree.IsImage` に依存。
- **`internal/imgread`**: 原寸画像読み出し + 寸法取得。エクスポート: `Result`、`Read(path)`。`tree.IsImage` に依存。
- **`internal/state`**: セッション状態の永続化。エクスポート: `StateData` ほか各 JSON 型、`Load()`、`Save(s)`、`DefaultData()`、`StateSchemaVersion`。
- パッケージ間依存は単方向 (`tree` → 依存なし、`thumb`/`imgread` → `tree`、`state` → 依存なし)。循環参照を避ける。
- 新機能を追加する際は適切な internal パッケージを選び、`app.go` には Wails バインディング用の薄いラッパだけを置く。Wails の TS バインディングは Go パッケージ単位で namespace を生成する (`tree.Node`、`thumb.Result` など) ので、フロント側の型 import もそれに合わせる。
