# image-observer 決定事項 TODO

実装に入る前に詰めるべき方針を列挙する。各項目は決定後にチェックを入れ、結論を末尾に追記する。優先度: 🔴 実装着手の前提 / 🟡 該当フェーズ着手時 / 🟢 v0.1 タグ前まででOK。

---

## A. データ / API 設計 🔴

- [x] **画像配信方式**: Go バインディング経由で `[]byte` / base64 を返す。キャッシュ判断 (有無・再生成) も Go 側で行い、フロントは受け取った内容を表示するのみ。サムネと原寸で同じ方針。
- [x] **ツリー列挙の粒度**: 遅延展開 (lazy load) を前提とする。
- [x] **Go ⇄ TS の型定義**: Wails のバインディング自動生成 (`wailsjs/go/...`) に乗せる。手書きの型を別途用意しない。
- [x] **パス**: 絶対パスで統一。

## B. フォルダツリー仕様 🟡

- [x] **並び順**: 名前順。
- [x] **フィルタ**: 隠しファイル非表示 / シンボリックリンクを辿る / 空ディレクトリは表示。
- [x] **画像ゼロのフォルダ**: 表示する (フォルダノードのみ、子要素は無し)。
- [x] **アイコン**: フォルダアイコン / 画像アイコンを名前の左に表示する。

## C. サムネイル仕様 🟡

- [x] **表示方式 (init.md F3 の解釈変更)**: マウスオーバーで浮かぶポップアップ表示を採用。
- [x] **サイズ**: ユーザー設定で可変。既定はホバーポップアップ用に 256 px。
- [x] **形式**: 元画像の形式を維持してキャッシュする。
- [x] **アスペクト比処理**: 枠サイズは固定。アスペクト比は維持し、クロップ / レターボックスはユーザー選択制。既定はレターボックス。
- [x] **リサイズ品質**: 速度重視。
- [x] **並行生成数**: ユーザー設定で指定。既定は `runtime.NumCPU() / 2` (最低 1)。
- [x] **生成失敗時**: エラーアイコン表示 (プレースホルダ画像はなし)。
- [ ] **avif 対応 (#118)**: Go に in-tree avif デコーダが無く cgo 回避方針 (context.md L63) とも衝突するため、デコーダ依存追加 (Option B) ではなく **Go 側 decode を回避し WebView に委ねる案 (Option A)** を spec ドラフトで推奨。寸法はフロント `naturalWidth` 補完 (A1)、サムネは元バイト列を返す (WebP→PNG と同種の「仕様上の正常動作」)。デコーダ依存の可否 (D1) はレビュー合意待ち。 → [spec-avif-support.md](spec-avif-support.md)

## D. キャッシュ 🟡

- [x] **キー形式**: `sha256(path + mtime + size)` の先頭 32 hex を取り、`<先頭2文字>/<残り30文字>.<元拡張子>` でシャーディング保存。
- [x] **保存場所**: `os.UserCacheDir()` 配下を基準にする。
- [x] **無効化**: mtime / size 不一致で再生成。fsnotify は v1 では入れない。
- [x] **上限**: v1 は無制限。次フェーズ以降で LRU 検討。
- [x] **クリア手段**: v1 では UI なし。手動でキャッシュフォルダ削除する手順を README に記載。

## E. タブ / ビューア 🟡

- [x] **複数ビューア対応 (#11)**: ビューアタブを「ユーザーが追加 / 削除 / リネームできる N 個 (上限 8) のビューア」に拡張する。各ビューアは独立した BSP `Layout` を持つ。
- [ ] **ビューアタブ並び替え (#50)**: トップタブ列のビューアタブを DnD (pointer events 自前 / 5px threshold / Esc + pointercancel cancel) で並び替え可能にする。state schema 変更なし、`viewer.viewers` 配列の順序を `useSessionSave` 経由で自動永続化。キーボード並び替え / ghost / 右クリックメニュー並び替えは Phase 2。 → issue #50 / docs/spec-viewer-tab-reorder.md で詳細化
- [x] **タブ最大数**: 制限なし。
- [x] **同一画像の複数タブ**: 同一パネル内では許可せず、異なるパネル間でのみ許可する。
- [x] **タブの順序操作 / パネル分割**: タブ並び替え + ビューア領域の **BSP ツリーによる自由分割 (上限 16 パネル)** + **タブの DnD でレイアウト編集** を v1 で実装する。
- [x] **タブのセッション復元**: 必須。v1 で実装する。
- [x] **画像の初期表示**: 100% で収まれば 100%、収まらないならフィット (long edge fit)。
- [x] **ズーム範囲とステップ**: 10%〜800%、ホイール 1 段階で 1.2 倍。
- [x] **パン境界**: 画像 < ビューア → センタリング固定。画像 > ビューア → 端で止める。
- [x] **EXIF Orientation**: v1 では読まない (尊重しない)。
- [x] **背景**: 単色 (ビューア領域の地色) + 透過部分はチェッカ柄。
- [x] **低解像度プレビュー先行表示 (#97)**: ビューアでオリジナルロード中に SampleModal と同じ `getPreview()` (= `GetThumbnail(path, 1024, "letterbox")` の TS ラッパ) を流用してプレビューを一時表示する。Phase 1 は単一 `<img>` の src 差し替え + `GetImageInfo` 先行発火 + preview/original/dimensions の 3 並行 IPC + 共通定数/ラッパを `shared/utils/thumbnailDefaults.ts` に集約。skip threshold / fade transition / 横断メモリキャッシュは Phase 2 で別途検討。 → PR #103 (実装完了、手動検証は PR test plan で実施) / [spec-low-res-preview.md](spec-low-res-preview.md) → #104 で preview 描画方針を改訂 (`max(W,H)` 正方形 + offset でアスペクト比歪みを解消)。
- [ ] **ビューアタブ間プレビューキャッシュ (#106)**: タブ切替時に過去取得済みの preview Blob URL を即時表示し「読み込み中…」blank を解消。viewer 横断のモジュールスコープ Map (固定上限 16 / JS Map insertion order ベース LRU) を `features/viewer-grid/previewCache.ts` に新設。タブ閉じても cache 残置 (LRU 任せ)、cache hit 時は `getPreview` IPC スキップ、`GetImageInfo` / `ReadImage` は併走。Blob revoke 責任は cache 側に一元化 (ImageView 側の revoke を撤去)、setCachedPreview 戻り値 `adopted` で重複 Blob を呼び出し側に廃棄させる。mtime invalidation / DeleteImage 連携 / watcher 連携は Phase 2。 → [spec-viewer-tab-cache.md](spec-viewer-tab-cache.md) (#97 spec §11 Out of scope に挙げていた「viewer 横断のプレビューメモリキャッシュ」が本仕様の Phase 1)。

## F. 状態の永続化 🟡

Phase 3c で部分確定。**ユーザー作業状態 (タブ / グリッド / フォルダ等) のみ対象**。設定値 (サムネサイズ等) は Phase H で別ファイル `settings.json` として扱う。

- [x] **保存対象**: 以下を保存する。
- [x] **保存先**: `os.UserConfigDir()/image-observer/state.json`
- [x] **保存タイミング**: 状態変化時に **debounce 500ms**。
- [x] **ウィンドウ位置復元 (#129)**: 実機 Windows で位置が常にメインディスプレイで開く不具合 (サイズ/最大化は機能)。triage 合意 = **Win32 `GetWindowPlacement`/`SetWindowPlacement` で #86 を置き換え** (Windows のみ) / 非 Windows は #86 経路をフォールバック維持 / 保存は終了時 (`OnBeforeClose`) に一発取得。`internal/winplacement` を windows/other build-tag で新設 (HWND は `EnumWindows`+PID マッチで自力取得、Wails 非公開のため)。WindowState schema は v6 据え置き (マイグレーション不要)。Windows では `useWindowGeometryPolling` を gate off し Window 所有権を Go に一本化。実装完了 (CI テスト緑)、Windows 実機での復元確認は PR の test plan に残る。 → [spec-window-placement.md](spec-window-placement.md)

## G. エラー・境界条件 ✅ (完了)

- [x] **壊れた画像**: タブ内にエラー表示 / タブを開かない / トースト通知。
- [x] **巨大画像**: サイズ上限 (例 200MP) を超えたら開かない / 縮小プレビューのみ。
- [x] **アクセス権なしフォルダ**: スキップしてログ / ユーザに通知。
- [x] **フォルダ消失中の挙動**: 再描画 / エラー表示。

## H. UX / ショートカット 🟡 (進行中)

- [x] **設定基盤** (Phase H1): `internal/settings` パッケージ + `<UserConfigDir>/image-observer/settings.json` (v1 schema: `LogLevel` / `MultiSelectMode`) + Wails バインド `GetSettings` / `UpdateSettings` / `ResetSettings`。main.go で起動時に読み込んで `logging.SetLevel` を反映。
- [x] **設定 UI シェル** (Phase H2): 上部タブバー右端に歯車アイコン → モーダルダイアログ。ロギング (level / log path 表示) + 一覧タブ (multiSelectMode segment) + キーバインド表 (read-only) のセクション。Esc で閉じる + バックドロップクリック対応。
- [x] **キーバインド** (Phase H4): 結論: 以下を採用 (Phase 5 で持ち越した Esc キャンセルを含む)。
- [x] **複数選択 UI のオプション化**: 設定 `multiSelectMode = "checkbox" | "modifier" | "both"` で挙動切替。
- [ ] **テーマ**: ダーク固定 / ライトも用意。 → issue #15 で詳細化済み
  - 結論: 着手時に詰める。
- [ ] **言語**: 日本語固定 / 英日切替。 → issue #16 で詳細化済み
  - 結論: 着手時に詰める。
- [ ] **UI 文字列の外部データ化 (#83)**: #16 (英日切替) の前段。フロント UI 文字列をハードコードから単一カタログ (`shared/messages/ja.ts`) + `t(key, params?)` 純関数に集約し、UI 変更を一箇所で行えるようにする。新ライブラリなし・ja 固定 (locale 切替は #16 / Out of scope)・キーは `keyof typeof ja` の union で型保証・`{placeholder}` 補間。Go 側文字列は対象外。Phase 分割 (D-6) と一括/段階移行はレビュー合意待ち。 → [spec-ui-string-catalog.md](spec-ui-string-catalog.md) (ドラフト)
- [ ] **ハードコード値の settings 化** (元 H3): max_pixels / 既知タグ配色 / サムネ既定値 / worker 数。 → issue #14 で詳細化済み
  - 結論: 着手時に詰める。
- [ ] **画像削除 (一覧タブから)**: Trash 送り (Phase 1: Card 右クリック単一削除のみ) + ビューアタブ自動 close。バルク削除 / Delete キーは Phase 2。 → issue #47 / docs/spec-image-delete.md で詳細化
- [x] **フォルダー監視 Phase 1 (auto reload)**: 一覧タブの現在フォルダを `gofsnotify/fsnotify` で監視し、外部からの画像追加/削除/サイドカー編集を silent auto-merge で反映。200ms debounce + バースト coalesce + 編集中の deferred 反映 + `settings.WatchMode = "auto" | "off"`。 → PR #75 (issue #19 / docs/spec-folder-watch.md)
- [ ] **フォルダー監視 Phase 2**: ビューアタブ自動 close (#47 と束ねる可能性) / バナー UI / 監視対象の細かい設定 / 削除ファイルに対するビューアの追従。 → issue #19 を Phase 2 用に再オープン or 新規 issue 起票で詳細化
- [x] **Card 右クリックメニュー拡張 (Phase 1)**: 一覧 Card 右クリックを単一 / バルク 2 モードに拡張 (「ビューア×N で開く」「選択モードに切り替え」「削除」/ selection ≥1 + 該当 card 選択中で「N 件をタブで開く / パネル分割で開く / 選択解除」)。固定メニュー、設定 UI なし。 → PR #74 (issue #58 / docs/spec-card-context-menu.md)
- [ ] **Card 右クリックメニュー Phase 2**: 設定 UI (項目順 / 表示制御) / バルク削除のメニュー組み込み (#47 Phase 2 と束ねる可能性) / フォルダ移動 / Finder 風 selection 置換 UX / TabContextMenu との共通基底化。
- [x] **画像サンプルモーダルと編集ペインの統合 (#93)**: SampleModal と EditPopover を 1 モーダルに統合し、プレビューを見ながら tags/confidence/note を編集できるようにする。Phase 1 は横並び 2 ペイン + 明示保存維持 + 未保存中 prev/next 抑止。 → [spec-sample-modal-edit.md](spec-sample-modal-edit.md)
  - 結論: Phase 1 を spec §10 ユーザー合意 (A 案) で確定し PR #102 で実装。横並び 2 ペイン + 明示保存 + 未保存中 prev/next disable + tooltip。EditPopover は削除し SampleEditPane に置換、`useClassification.openEdit/closeEdit` は内部ヘルパに縮退。Phase 2 (ペイン折り畳み / inline confirm / autosave / モーダル幅設定) は別 issue で扱う。
- [ ] **編集ペインの blur 自動保存 (#105)**: 統合モーダル (#93) の SampleEditPane で、タグ入力 / note textarea の blur と confidence radio change で自動保存。`settings.editAutoSave: bool` (デフォルト true) で auto / manual を切り替え、auto モードでは保存 / キャンセルボタンを非表示。in-flight 直列化で連続 blur の mtime conflict を回避。Phase 2 (debounce / Esc 確認 / マイクロインジケータ) は別 issue。 → [spec-edit-autosave.md](spec-edit-autosave.md)
- [x] **タグ未付与フィルタ (未分類だけ表示, #116)**: 一覧タブのタグチップ行に「未分類」チップを追加し、`extractTags(folder)` が空のエントリだけに絞る。triage 合意 = 独立 boolean `untaggedOnly` + 通常タグとの排他モード。表現方法を sentinel ではなく独立フィールドにしたのは永続化される `tags[]` の意味を濁さないため。**schema バンプ要否 (D1) は検証の結果「無バンプ additive で前方/後方互換」が判明し推奨 = 据え置き** (v6→v7 にすると migration 必須・既存 state 消失リスク)。 → PR #120 ([spec-untagged-filter.md](spec-untagged-filter.md))
- [ ] **保存画像のダブり警告 (#136)**: 一覧タブの現在フォルダ内で知覚的ハッシュ (dHash / pHash **両実装**、設定 `duplicateHashAlgo` で切替、既定 dHash) の距離 ≤ しきい値 (設定可、既定 5) のペアを検出し Card に ⚠ バッジ + 確認モーダル。誤検出はペア単位 dismiss をフォルダ直下 `_duplicates.json` (ハッシュ値ペアキー = rename 耐性、両 algo 同時記録 = 切替で復活しない) に永続化。ハッシュは algo 別のフォルダ単位 JSON index (`cache/duphash/<algo>/`, mtime+size 無効化) にキャッシュ。AVIF は skip (#118 整合)。H-8 同期モデル表を spec §8 に着手前記載。**Phase 1 (本 PR) = dHash のみ / Phase 2 (別ブランチ) = pHash + 切替設定** で 2026-07-05 ユーザー合意。Phase 1 は実装済み (feat/136-duplicate-detection)、Phase 2 が残るためチェックは Phase 2 完了時。 → [spec-duplicate-detection.md](spec-duplicate-detection.md)
- [ ] **画像の並び替え (#144)**: 一覧タブの表示順を 2 層で制御 — 手動順の正本 = `_classification.json` の entries 配列順 (現状の実体を公式化、順序専用の永続データは導入しない) + 表示派生ソート (`manual` 既定 / name / mtime × 昇降の 5 モード、`ListTabState.Sort` に v6 無バンプ additive 永続化、#116 と同じ整理)。mtime は `LoadResult.FileTimes` (scanner の walk 中に収集) で供給し sidecar には書かない。**Phase 1 = ソートモード / Phase 2 = 明示的な並べ替えモード + 手動 DnD** (2026-07-18 レビューで「常時 DnD でなくモード制」に確定 — モード中はプレビュー / 選択 / ビューアタブ移動等を禁止し並べ替え専念。入口は manual + フィルタ非適用、同一グループ内のみ、既存 `SaveClassification` + mtime 楽観ロックで保存)。H-8 同期モデル表を spec §8 に着手前記載。Phase 1 実装済み (feat/144-image-sort / PR #145)、Phase 2 実装済み (feat/144-image-sort-phase2)。チェックは両 PR マージ後。 → [spec-image-sort.md](spec-image-sort.md)
- [ ] **ビューアタブ最大数の設定化 (#148)**: `settings.maxViewers` (既定 8 / 範囲 1..32、additive・version bump なし) でタブ追加上限を可変に。上限強制は**追加時 gate のみ** — state.json 復元の truncate は設定値でなくハードキャップ 32 (`state.maxViewersHard`) に緩和し、上限を下げても open 中 viewer / 復元 session を壊さない (2026-07-20 ユーザー合意)。Ctrl+Shift+2..9 は先頭 8 個据え置き。live 反映 (`maxImagePixelsMP` と同じ settings live 値 + 定数 fallback パターン)。実装済み (feat/148-viewer-max-count)、チェックは PR マージ後。 → [spec-viewer-max-count.md](spec-viewer-max-count.md)
- [x] **画像クリップボードコピー (#127)**: ビューア (`TabContextMenu`) / 一覧 (`CardContextMenu` 単一モード) の右クリックに「コピー」を追加し、原寸画像を OS クリップボードへ。triage 合意 = **方式 A (フロント `navigator.clipboard.write`)** で Go/IPC/ネイティブ追加なし。原寸を `ReadImage` で取得し PNG 化 (png はそのまま / それ以外は WebView デコード + canvas 再エンコード、avif 含め #118 の WebView 委譲方針と整合)。バルクコピー / ファイルコピーは Out of scope。実クリップボード動作は Windows 実機で要確認 (dev = WebKitGTK は未サポートの可能性)。 → [spec-clipboard-copy.md](spec-clipboard-copy.md)
- [ ] **タスクバーからのビューアタブ切り替え (#149)**: Windows タスクバーアイコンのサムネイルプレビューに `ITaskbarList3` サムネイルツールバーで「前/次のビューア」2 ボタンを置き、ウィンドウ非フォーカスのままビューアタブを巡回 (液タブのマウスオーバー操作向け、2026-07-20 ユーザー合意)。ジャンプリスト (タブ名直接選択) は単一インスタンス転送が要るため Phase 2 の別 issue に分離。Go 側は `internal/wintaskbar` (windows/other build-tag) + window subclass で WM_COMMAND を捕捉し EventsEmit、FE は keybindings と同じ gate で activeViewer を巡回。永続化変更なし。ci.yml に `GOOS=windows go build` のクロスコンパイル check も追加 (D8)。 → [spec-taskbar-viewer-switch.md](spec-taskbar-viewer-switch.md)

## I. ビルド / 配布 🟢

- [x] **配布形態**: ポータブル EXE + NSIS インストーラ の両方を提供。
- [x] **バージョン規約**: pre-1.0 semver (`0.x.y`) + `v` プレフィクス git tag。
- [x] **アプリ名**: プロジェクト名 `image-observer` (画像観察者) とは別に、ユーザー向け表示名を **Imago** に決定 (#88)。
  - 由来: 羅 *imago* = image / 昆虫学で「観察される成体 (最終形態)」→ 画像観察者と直結する造語的ブランド名。
  - 適用範囲は**表示名のみ**: `wails.json info.productName` / `main.go` Title / `frontend/index.html` `<title>`。
  - **据え置き** (内部識別子): `wails.json name` / `outputfilename` (= NSIS `INFO_PROJECTNAME`, EXE 名 `image-observer.exe`) と Go のデータ保存ディレクトリ名 `image-observer/...` (cache/state/settings/logs)。変えると既存データが孤児化するため。
- [ ] **アイコン**: 現状はテンプレートのまま。差し替え時期。 → issue #17 で詳細化済み
  - 結論: 着手時に詰める (v0.1.0 リリース前 or それ以降かも合わせて判断)。デザインのモチーフ/配色は確定済みブランド名 **Imago** を踏まえて決める。
- [x] **コードサイニング**: 公的 CA / EV 署名は v1 対象外 (一般配布は未署名 = SmartScreen 警告は受容)。
  - [x] **自己署名 (#61)**: 開発者自身の PC で警告なく起動するため、CI (`release.yml`) で portable EXE を自己署名証明書で署名する。証明書 (.pfx) は GitHub Secrets 経由、未設定時は署名スキップ。自己署名のため「証明書を信頼した PC でのみ」警告が消える (第三者は未署名同様)。 → PR #124 (CI 署名ステップ・証明書スクリプト実装完了、Secrets 登録後の起動確認は開発者手作業) / [spec-self-signing.md](spec-self-signing.md)
- [x] **ビルド OS**: 公式は Windows ネイティブビルドのみ (GitHub Actions の `windows-latest` runner)。

## J. 開発プロセス 🟢

- [x] **ログ**: ファイルベースの追記ロガーを `internal/logging` で実装済み (Phase 5 補足)。
- [x] **テスト**: Go ユニットテストとフロント vitest を導入済み。
- [x] **CI**: GitHub Actions で 2 yaml 構成 (テスト常時 + tag 駆動リリース)。
- [ ] **リンタ・フォーマッタ**: gofmt + golangci-lint / eslint + prettier の採用と CI 連携。 → issue #18 で詳細化済み
  - 結論: 着手時に詰める (ci.yml に lint ジョブを並列追加する想定)。
- [x] **useClassification.ts リファクタ**: 1635 行の単一フックを機能単位で分割 (#66 / PR #81)。 → [spec-classification-hook-refactor.md](spec-classification-hook-refactor.md) に従い案 B (軽量子フック分離) を採用。shared refs は orchestrator に集約、props で渡す。PR #75 の race 設計は維持。orchestrator ~560 行 + 子フック 8 個 + `entriesEquivalent.ts` 純関数。
- [x] **App.tsx orchestrator リファクタ**: 819 行の `App.tsx` を「軽量子フック分離 + TopTabsBar コンポーネント抽出」で orchestrator (実績 282 行) に縮小 (#67)。WindowGeometry polling / Global keybindings / Viewer rename / List→viewer wiring / ViewerTab を独立化。shared state は orchestrator が宣言し props で渡す ([#66](https://github.com/maretol/image-observer/issues/66) と同じ流儀)。 → [spec-app-orchestrator-refactor.md](spec-app-orchestrator-refactor.md)
- [x] **レビュー往復の再発防止 (#110)**: PR #109 (6 round) / PR #75 (16 round) の post-mortem を反映。docs A+D は PR #111 で着手済み — AGENTS.md H-8 (着手前マトリクス + 5 列同期モデルテンプレ) / 新規 I-1 (3 round 超で立ち止まる) / CLAUDE.md「非同期処理の着手前ルール」。
- [ ] **編集 auto-save のテスト網 + 境界リファクタ (#110 B+C)**: B (テスト基盤 = happy-dom + @testing-library/react 最小、`useAutoSaveQueue` + baseline reset reducer 抽出 + renderHook テスト) → C (`onSave(entry, {folder, baselineMtime})` の context API 化、`ClassificationView` の `folderPathRef` guard 撤去、saveEdit の ctx gate)。#110 内で 1 spec・Phase 分割 (別 issue に切らない)。Q1/Q2 triage 合意済み。folder=capture 時固定 / mtime=dispatch 時解決 の別軸扱いが C の肝 (round 2/6 両立)。 → [spec-edit-autosave-testing.md](spec-edit-autosave-testing.md)

---

## 進め方メモ

1. まず A (データ / API 設計) を確定 → Folder Tree フェーズに着手可能。
2. Folder Tree 着手と同時に B を詰める。
3. Thumbnail フェーズで C・D を詰める。
4. Tab + Viewer フェーズで E を詰める。
5. F・G は該当機能の実装ついでに決める。
6. H・I・J は v0.1 タグを切る前に揃っていれば良い。
