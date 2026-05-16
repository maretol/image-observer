# image-observer 決定事項 TODO

実装に入る前に詰めるべき方針を列挙する。各項目は決定後にチェックを入れ、結論を末尾に追記する。優先度: 🔴 実装着手の前提 / 🟡 該当フェーズ着手時 / 🟢 v0.1 タグ前まででOK。

---

## A. データ / API 設計 🔴

- [x] **画像配信方式**: Go バインディング経由で `[]byte` / base64 を返す。キャッシュ判断 (有無・再生成) も Go 側で行い、フロントは受け取った内容を表示するのみ。サムネと原寸で同じ方針。
  - 結論: Go バインディング経由。Go メソッドが `[]byte` を返せば Wails は自動で base64 化して JS に渡るため、API 上は `[]byte` で統一すれば OK (フロントは `data:image/...;base64,${...}` で `<img src>` に乗せる)。AssetServer は使わない。
  - 想定 API: `GetThumbnail(path string) ([]byte, error)` / `ReadImage(path string) ([]byte, error)`。両者ともキャッシュ参照とミス時の生成 / 読み込みを内包する。
  - 留意点: 大画像 (数十 MB) を base64 で返すとメモリと IPC レイテンシに響く。原寸は将来 AssetServer 切替の余地を残しつつ、まず簡素な方針で進める。
- [x] **ツリー列挙の粒度**: 遅延展開 (lazy load) を前提とする。
  - 結論: ルート選択時はルート直下のみ列挙。フォルダノード展開時に都度子を取得。
  - 想定 API: `ListDirectory(path string) ([]Node, error)` (一階層のみ)。フロントは展開イベントで再呼び出し。
  - 影響: ノード型に `children` ではなく `hasChildren: bool` を持たせる必要あり (B 項の並び順や空ディレクトリ表示の判定にも関わる)。
- [x] **Go ⇄ TS の型定義**: Wails のバインディング自動生成 (`wailsjs/go/...`) に乗せる。手書きの型を別途用意しない。
  - 結論: Go 構造体に `json:"..."` タグを付け、`wails generate module` で TS 型を出力。フロントは `wailsjs/go/main/App` から型ごと import する。
  - ノード型素案 (要追加検討): `Node { path string; name string; kind string ("dir"|"image"); hasChildren bool; mtime int64; size int64 }`。サムネイル URL や thumb status 等を含めるかは C 項で決定。
- [x] **パス**: 絶対パスで統一。
  - 結論: Go ↔ TS 間のパスは常に絶対パス (Windows: `C:\...` / WSL 開発時: `/home/...`)。タブ識別子・キャッシュキー・状態永続化キーすべて絶対パス基準。
  - 留意点: ルートフォルダ移動時に既存タブのパスが指す先が無効化することがある (G 項「フォルダ消失中の挙動」と合わせて扱う)。表示用に「ルートからの相対」が欲しい場面はフロント側で `path.replace(rootPath, '')` して都度算出。

## B. フォルダツリー仕様 🟡

- [x] **並び順**: 名前順。
  - 結論: 名前昇順でソート。
  - 未確定の細部 (実装時に決定): 大文字小文字を区別するか / 自然順 (file2 < file10) を採るか / ディレクトリと画像ファイルを混在ソートするか分けて表示するか。
- [x] **フィルタ**: 隠しファイル非表示 / シンボリックリンクを辿る / 空ディレクトリは表示。
  - 結論:
    - 隠しファイル (`.` 始まり、Windows の Hidden 属性付き) は表示しない。
    - シンボリックリンクは辿る (ジャンクション含む)。
    - 空ディレクトリ (子要素ゼロ) はディレクトリノードとして表示する (中身は空)。
  - 留意点: シンボリックリンクを辿るとループの可能性があるため、訪問済み inode / 実パスをトラッキングして循環を検出 / 打ち切る仕組みが必要。
- [x] **画像ゼロのフォルダ**: 表示する (フォルダノードのみ、子要素は無し)。
  - 結論: 画像が一つも無いフォルダもツリーに出す。展開しても何も出ないだけ。
- [x] **アイコン**: フォルダアイコン / 画像アイコンを名前の左に表示する。
  - 結論: 各ノードの左側に種類別アイコン (フォルダ用 / 画像ファイル用) を表示し、その右に名前を並べる。
  - 未確定: アイコン素材の出所 (フォントアイコン例: Lucide / Heroicons / Font Awesome、SVG ベタ書き、テンプレ標準のものなど) は実装時に選定。

## C. サムネイル仕様 🟡

- [x] **表示方式 (init.md F3 の解釈変更)**: マウスオーバーで浮かぶポップアップ表示を採用。
  - 結論: ホバー後 250ms でツリーノード右側にポップアップを出す。インライン表示は v1 では実装しない (将来オプションで切替の余地は残す)。
  - 細部:
    - 表示遅延: 250 ms (短すぎるとマウス通過で誤発火、長すぎると体感遅い)
    - ポップアップサイズ: 256 px 角 (画像はこの中にフィット)
    - 位置: ツリーノード右端に隣接。画面右端に近ければ反転して左側に出す。垂直方向もウィンドウ内に収まるよう調整。
    - 装飾: 半透明黒背景 (#000d) + 1px ボーダー + ドロップシャドウ
- [x] **サイズ**: ユーザー設定で可変。既定はホバーポップアップ用に 256 px。
  - 結論:
    - ポップアップ表示サイズ既定: 256 px。設定選択肢は 128 / 192 / 256 / 384 / 512 px。
    - 生成サイズは表示サイズの 2 倍 (HiDPI 想定) を固定 (キャッシュ容量は 4 倍になる点を許容)。
    - 「画面 DPI 自動」モードは v1 では入れない。
- [x] **形式**: 元画像の形式を維持してキャッシュする。
  - 結論: JPEG → JPEG, PNG → PNG, GIF → GIF, WebP → WebP のままサムネイルも同形式で保存・配信。
  - 留意点: GIF / WebP のアニメは原則 1 コマ目を抽出してサムネ化する (アニメGIFは init.md でビューア側はブラウザ任せだが、サムネ生成は静止画化が必要)。透過 PNG は透過保持。
- [x] **アスペクト比処理**: 枠サイズは固定。アスペクト比は維持し、クロップ / レターボックスはユーザー選択制。既定はレターボックス。
  - 結論: 設定で「クロップ (中央切り抜き、枠を埋める)」「レターボックス (余白で埋める)」を切替可能。**既定はレターボックス** (元画像の構図を破壊しない安全側)。
- [x] **リサイズ品質**: 速度重視。
  - 結論: `golang.org/x/image/draw` の `BiLinear` を採用 (`NearestNeighbor` は更に速いが品質が荒すぎるので不採用)。`CatmullRom` は使わない。
- [x] **並行生成数**: ユーザー設定で指定。既定は `runtime.NumCPU() / 2` (最低 1)。
  - 結論: 設定画面で並行 worker 数を指定可能にする。既定値は `max(runtime.NumCPU() / 2, 1)`。全コア使うと UI 体感が落ちる経験則による。
- [x] **生成失敗時**: エラーアイコン表示 (プレースホルダ画像はなし)。
  - 結論: サムネ生成に失敗したファイルはツリー (またはポップアップ) 上で「失敗」を示すアイコンに置き換える。エラー詳細はログにのみ残す。

## D. キャッシュ 🟡

- [x] **キー形式**: `sha256(path + mtime + size)` の先頭 32 hex を取り、`<先頭2文字>/<残り30文字>.<元拡張子>` でシャーディング保存。
  - 結論: 例 `cache/thumbnails/letterbox/256/ab/cdef...0123.jpg`。先頭 2 文字でディレクトリを分けることで単一ディレクトリにファイルが密集してファイルシステムが遅くなる問題を回避。`<元拡張子>` は元画像形式に従う。
  - キー入力: `path` (絶対パス) + `mtime` (Unix 秒、文字列化) + `size` (バイト、文字列化) を区切り文字 `\0` で連結して sha256。
  - パス階層には表示モード (`letterbox` / `crop`) と生成サイズ (`256` 等) も含める。これにより設定変更時もキャッシュが互いに干渉しない。
- [x] **保存場所**: `os.UserCacheDir()` 配下を基準にする。
  - 結論: Windows なら `%LOCALAPPDATA%\image-observer\cache\thumbnails\`、Linux なら `~/.cache/image-observer/thumbnails/`、Mac なら `~/Library/Caches/image-observer/thumbnails/`。Go の `os.UserCacheDir()` で OS 別を吸収。init.md N5 と一致。
- [x] **無効化**: mtime / size 不一致で再生成。fsnotify は v1 では入れない。
  - 結論: キャッシュキーに mtime / size を含めるため、元ファイルが書き換われば自動的に別キーになり旧キャッシュは「再生成」ではなく「無関係なファイル」として残る (孤児)。fsnotify による監視は OS 別差異と複雑性のため Phase 後ろ倒し。孤児クリーンアップは v1 では行わない (上限の項を参照)。
- [x] **上限**: v1 は無制限。次フェーズ以降で LRU 検討。
  - 結論: サムネ 1 枚 ~10〜30 KB として 3000 ファイルでも 100 MB 以下。当面ディスク圧迫は実害なし。LRU / 容量上限は H フェーズ (UX / 設定画面) と一緒に追加検討。
- [x] **クリア手段**: v1 では UI なし。手動でキャッシュフォルダ削除する手順を README に記載。
  - 結論: 設定画面が無い段階でクリア UI だけ作るのは早すぎ。Phase H で設定画面と一緒に「キャッシュをクリア」ボタンを追加する。それまでは README に `os.UserCacheDir()` 配下のパス例とフォルダ削除手順を記載。

## E. タブ / ビューア 🟡

- [x] **複数ビューア対応 (#11)**: ビューアタブを「ユーザーが追加 / 削除 / リネームできる N 個 (上限 8) のビューア」に拡張する。各ビューアは独立した BSP `Layout` を持つ。
  - 結論: state schema v6 (`Viewers []ViewerState` + `ActiveViewerID`) + v5→v6 ロスレス昇格マイグレーション。トップタブ末尾の `+` で追加、タブダブルクリックで inline rename、hover で × 削除 (タブが残っていれば確認ダイアログ)。`Ctrl+Shift+2..9` で N 番目のビューアに切替。一覧 → ビューア結線は刷新: Card クリック → SampleModal → モーダル内のビューア選択ボタン群、バルクは `<select>` で開く先指定。タブ右クリック「ビューアへ移動 ▶」サブメニューで cross-viewer タブ移動 (DnD は v1 スコープ外)。詳細 spec は [docs/spec-multi-viewer.md](spec-multi-viewer.md)。
- [x] **タブ最大数**: 制限なし。
  - 結論: ハード上限を設けない。N4 通り「タブで開いている画像のみオンメモリ保持」なので、開きすぎた場合のメモリは画像 N 枚分でリニアに増えるだけ。ユーザーが明示的に閉じる運用。
- [x] **同一画像の複数タブ**: 同一パネル内では許可せず、異なるパネル間でのみ許可する。
  - 結論: ツリーから画像 X をクリックしたときの挙動:
    - **アクティブパネル内** に X が既に開かれている → そのタブにフォーカスを移す (新規タブは作らない)
    - アクティブパネル内に X が無い → アクティブパネルに新しいタブとして X を開く (他のパネルで X が開かれていても無関係)
  - これにより 1 つの画像は最大「パネル数」個までタブとして同時に開ける (2 行 × 3 列の最大構成なら 1 画像最大 6 タブ)。各タブの zoom/pan は独立。
  - **注: init.md F5 の解釈拡張**。F5 は「既に開いていれば該当タブをアクティブ化」と書かれているが、これを「**アクティブパネルに対して**」のスコープに限定すると解釈する (パネル分割という新概念に合わせた拡張)。
- [x] **タブの順序操作 / パネル分割**: タブ並び替え + ビューア領域の **BSP ツリーによる自由分割 (上限 16 パネル)** + **タブの DnD でレイアウト編集** を v1 で実装する。
  - 結論 (Phase 3b → Phase 5 で改定):
    - **タブ並び替え**: v1 で実装する (Phase 5)。同一パネルのタブバー内で DnD すると並び替え。
    - **パネル分割**: ビューア領域を **BSP (二分空間分割) ツリー** で表現。`Layout = { root: SplitNode | LeafNode, activeId }`。ルート 1 leaf から始まり、edge drop で SplitNode を増やしていく。
      - 既定状態は 1 パネル (空 leaf がルート)。
      - **タブをパネルの 4 辺いずれかにドロップ** で分割発生 (ボタン UI は廃止)。タブをパネル中央 / 別パネルのタブバーにドロップで移動。
      - 各パネルは独立した TabBar とアクティブタブを持つ。
      - **Splitter は任意 SplitNode の境界に出る**。`MIN_PX = 100` と `MIN_RATIO = 0.05` の両方で clamp。
      - **アクティブパネル** の概念を持つ。ツリー / 一覧タブからの画像オープンはアクティブパネルに開く。
    - **タブ移動**: タブの DnD で他パネルへ移動可能。右クリック「別パネルへ移動」は廃止 (DnD で完全代替)。右クリックメニューは「閉じる / 右に分割 / 下に分割」の 3 項目のみ残す。
    - **空パネル削除時の挙動**: leaf の最後のタブを閉じる / 移動するとパネルが消滅し、兄弟パネルが親分割を吸収する (auto-collapse)。確認ダイアログは出さない (タブ単位の閉じる UX に統一)。
  - **重要 — init.md §2.3 の仕様変更**: init.md §2.3 では「ペインの 3 分割以上、ドッキング、フローティング」をスコープ外と明記しているが、この **「3 分割以上」を取り下げ、最大 16 パネルの BSP ツリー分割を v1 スコープに追加** する (Phase 3b → Phase 5 で 6 → 16 に拡張)。「ドッキング、フローティング」は引き続きスコープ外を維持。
  - **将来対応**: パネル最大数 (現 16) は `MAX_PANELS` で定数化。Phase H で設定画面 UI から変更可能にする予定。Esc キャンセル等のキーボード操作は Phase H 持ち越し。詳細 spec は [docs/spec-viewer-flexlayout.md](spec-viewer-flexlayout.md)。
- [x] **タブのセッション復元**: 必須。v1 で実装する。
  - 結論: 起動時に前回終了時の状態を復元する。**F (永続化) を Phase 3 と同時並行で詰める必要あり**。最低限保存する項目:
    - グリッド分割形状 (rows × cols、各分割スプリッター位置)
    - 各パネルの「タブ一覧 (パス)」「アクティブタブ」「各タブの zoom 倍率 + pan 位置」
    - アクティブパネル (グリッド内の位置)
    - ルートフォルダ・左右ペイン幅・ウィンドウサイズ・位置等は F 項全体で改めて整理。
- [x] **画像の初期表示**: 100% で収まれば 100%、収まらないならフィット (long edge fit)。
  - 結論: 初期 zoom = `min(1.0, fitZoom)`。`fitZoom = min(viewportW / imageW, viewportH / imageH)`。
    - 小さい画像 (アイコンサイズ等): 等倍 (拡大しない、ぼやけ防止)。
    - 大きい画像: ビューア枠に収まる最大サイズに縮小。
- [x] **ズーム範囲とステップ**: 10%〜800%、ホイール 1 段階で 1.2 倍。
  - 結論: 最小 0.1、最大 8.0。マウスホイール 1 ノッチで `zoom *= 1.2` (ノッチ方向で乗除)。範囲外はクランプ。ズーム中心は **カーソル位置基準** (init.md F7 通り)。
- [x] **パン境界**: 画像 < ビューア → センタリング固定。画像 > ビューア → 端で止める。
  - 結論: 画像が小さい (現在の zoom 倍率での画像サイズが両軸ともビューアより小さい) ときは中央にロック。画像が大きいときはドラッグで移動可能だが、画像端がビューア端に達したらそれ以上動かせない (画像の外側がビューア内に入らない)。
- [x] **EXIF Orientation**: v1 では読まない (尊重しない)。
  - 結論: Go 側で EXIF を読まず、ディスクのバイトをそのままフロントに返す。スマホ写真等で縦横が回転して表示されるケースがあるが、それを許容する。
  - 理由:
    - 「原寸表示は常にディスクバイトをそのまま返し、再エンコードしない」方針 (画像閲覧の品質劣化回避) と整合性が取れる。EXIF 適用には Orientation 2〜8 で再エンコードが避けられないため、今回の品質優先方針と相反する。
    - 実装ボリュームが見合わない (EXIF パース + 8 種の変換 + サムネ生成パスへの組み込み + 旧サムネキャッシュ無効化対応)。
  - 将来検討: ユーザー要望が出れば、Orientation 2〜8 のときだけ「クライアントサイド (CSS transform) で回転」する案を採れば原寸バイトを保ったまま見た目だけ補正できる。Phase 後ろ倒し。
- [x] **背景**: 単色 (ビューア領域の地色) + 透過部分はチェッカ柄。
  - 結論:
    - ビューア領域の地色 (画像の外側、フィット時の余白部分) は単色 (例: ダーク #1e1e1e、既存 App.css の `.pane.right` と統一)。
    - 画像自体の **透過ピクセル部分** には CSS の background-image でチェッカ柄を敷く (`<img>` のスタイルとして、半透明グレーの 16px 角チェッカ)。透過 PNG を開くと透明部分にチェッカが見え、ユーザーは透過の有無を即判別できる。

## F. 状態の永続化 🟡

Phase 3c で部分確定。**ユーザー作業状態 (タブ / グリッド / フォルダ等) のみ対象**。設定値 (サムネサイズ等) は Phase H で別ファイル `settings.json` として扱う。

- [x] **保存対象**: 以下を保存する。
  - 結論:
    - 最後に選択していた **rootPath**
    - 左ペイン幅 (`leftPaneWidth`)
    - **ウィンドウサイズ + 位置** (位置は OS / WM 依存でベストエフォート)
    - **グリッド形状** (rows × cols + rowSizes/colSizes ratios + active panel coord)
    - **各パネルのタブ一覧** (path のみ、絶対パス) + アクティブタブ index
    - **各タブの zoom / panX / panY**
    - スキーマバージョン (`version: 1`、将来の互換性のため)
  - 保存しない:
    - ツリーの全展開状態 (rootPath 直下しか初期展開しない)
    - 画像本体やサムネ (ディスクキャッシュ側で別管理)
    - 設定値 (Phase H で別ファイル `settings.json` に)
- [x] **保存先**: `os.UserConfigDir()/image-observer/state.json`
  - 結論: Windows なら `%APPDATA%\image-observer\state.json`、Linux なら `~/.config/image-observer/state.json`、Mac なら `~/Library/Application Support/image-observer/state.json`。Go の `os.UserConfigDir()` で OS 別を吸収。
  - 書き込みは **アトミック** (`*.tmp` に書いてから `rename`)、破損リスク回避。
- [x] **保存タイミング**: 状態変化時に **debounce 500ms**。
  - 結論: フロント側で input が変わるたびに 500ms タイマーをリセット → 静止後 500ms で `SaveState` を呼ぶ。連続変更 (ホイールズーム等) で書き込みが洪水になるのを防ぐ。
  - ウィンドウ位置はブラウザイベントが無いため 2 秒ごとにポーリングして state に反映 (これも debounce 経由で書く)。
  - 終了直前の確定保存 (`OnBeforeClose`) は v1 不採用。debounce 待機中の小さな取りこぼしは許容。必要なら Phase 後ろ倒し。

## G. エラー・境界条件 ✅ (完了)

- [x] **壊れた画像**: タブ内にエラー表示 / タブを開かない / トースト通知。
  - 結論: タブは開く + タブ内エラー表示 + トースト通知 (両方)。
- [x] **巨大画像**: サイズ上限 (例 200MP) を超えたら開かない / 縮小プレビューのみ。
  - 結論: しきい値超で開かない (タブも作らない、トースト通知)。しきい値は将来 Phase H の設定 UI で可変にする。
- [x] **アクセス権なしフォルダ**: スキップしてログ / ユーザに通知。
  - 結論: トースト通知 + ツリーにフォルダ名は出す (展開不可状態で表示)。
- [x] **フォルダ消失中の挙動**: 再描画 / エラー表示。
  - 結論: ツリーノードにエラー表示。

## H. UX / ショートカット 🟡 (進行中)

- [x] **設定基盤** (Phase H1): `internal/settings` パッケージ + `<UserConfigDir>/image-observer/settings.json` (v1 schema: `LogLevel` / `MultiSelectMode`) + Wails バインド `GetSettings` / `UpdateSettings` / `ResetSettings`。main.go で起動時に読み込んで `logging.SetLevel` を反映。
- [x] **設定 UI シェル** (Phase H2): 上部タブバー右端に歯車アイコン → モーダルダイアログ。ロギング (level / log path 表示) + 一覧タブ (multiSelectMode segment) + キーバインド表 (read-only) のセクション。Esc で閉じる + バックドロップクリック対応。
- [x] **キーバインド** (Phase H4): 結論: 以下を採用 (Phase 5 で持ち越した Esc キャンセルを含む)。
  - **Esc** — DnD 中のドラッグキャンセル (commit せずレイアウト無変更)
  - **Ctrl+W** — アクティブパネルのアクティブタブを閉じる
  - **Ctrl+Tab / Ctrl+Shift+Tab** — アクティブパネルのタブ巡回
  - **Ctrl+0** — フィット (画像が枠に収まる最大倍率、長辺合わせ)
  - **Ctrl+1** — 原寸 (100%、ビューポート中心基準)
  - **Ctrl++ / Ctrl+=** — ズームイン (1.2 倍ステップ、中心基準)
  - **Ctrl+-** — ズームアウト (1/1.2 倍ステップ、中心基準)
  - 入力フォーカス中 (input/textarea/select/contenteditable) と設定ダイアログ open 中は無効化
  - ダブルクリックでフィット / 原寸トグル、PgUp/PgDn によるタブ移動は将来検討 (要望が出た時点で追加)
- [x] **複数選択 UI のオプション化**: 設定 `multiSelectMode = "checkbox" | "modifier" | "both"` で挙動切替。
  - **checkbox** (既定): Card 左上に常時 checkbox。プレーンクリックは選択 ≥1 でトグル / それ以外で開く。修飾キーは無視。
  - **modifier**: checkbox 非表示。プレーンクリックは常に画像を開く。Ctrl+クリックでトグル + アンカー設定、Shift+クリックでアンカーから現在位置までの **表示順 (DFS グループ順)** で範囲選択。
  - **both**: checkbox 表示 + 修飾キー有効。プレーンクリックは選択 ≥1 でトグル / それ以外で開く。Ctrl/Shift は modifier モードと同じ。
  - アンカーは「直近のトグル位置」。Shift+クリック後もアンカーは保持され、別の終端で再 Shift+クリックすると範囲を更新できる。フォルダ変更で選択とアンカー両方クリア。
- [ ] **テーマ**: ダーク固定 / ライトも用意。 → issue #15 で詳細化済み
  - 結論: 着手時に詰める。
- [ ] **言語**: 日本語固定 / 英日切替。 → issue #16 で詳細化済み
  - 結論: 着手時に詰める。
- [ ] **ハードコード値の settings 化** (元 H3): max_pixels / 既知タグ配色 / サムネ既定値 / worker 数。 → issue #14 で詳細化済み
  - 結論: 着手時に詰める。
- [ ] **画像削除 (一覧タブから)**: Trash 送り (Phase 1: Card 右クリック単一削除のみ) + ビューアタブ自動 close。バルク削除 / Delete キーは Phase 2。 → issue #47 / docs/spec-image-delete.md で詳細化
- [ ] **Card 右クリックメニュー拡張**: 「ビューア×N で開く」「選択モードに切り替え」「削除」の固定メニュー。selection ≥1 + 該当 card 選択中ならバルクモードに切替 (「N 件をタブで開く / パネル分割で開く / 選択解除」)。v1 は設定 UI なし、バルク削除 / フォルダ移動 / 項目順設定 UI は Phase 2。 → issue #58 / docs/spec-card-context-menu.md で詳細化

## I. ビルド / 配布 🟢

- [x] **配布形態**: ポータブル EXE + NSIS インストーラ の両方を提供。
  - 結論:
    - `wails build -platform windows/amd64 -nsis` 一発で両方を同時出力 (`build/bin/image-observer.exe` + `build/bin/image-observer-amd64-installer.exe`)。
    - **portable EXE**: USB 持ち運び / レジストリ汚染ゼロ / 未署名でも警告が比較的薄い。
    - **NSIS インストーラ**: スタートメニュー / アンインストーラ / 標準的な Windows アプリ体験。
    - 未署名のうちは SmartScreen 警告が NSIS の方が目立ちがちなので、README に「警告が強ければ portable を選んでね」というフォールバック案内を書く。
    - NSIS 設定 (`build/windows/installer/project.nsi`) は Wails テンプレ初期値のまま。カスタマイズ (アイコン / インストール先デフォルト等) は I-3 アイコン差し替えと同時に検討。
- [x] **バージョン規約**: pre-1.0 semver (`0.x.y`) + `v` プレフィクス git tag。
  - **採番ルール**:
    - **Patch** (`0.1.x`): バグ修正、UI 微調整、無害なリファクタ。
    - **Minor** (`0.x.0`): Phase 完了 / 機能追加 / state schema or settings schema の bump。
    - **Major** (`1.0.0`): `init.md` R1〜R7 + todo.md H + I + J が一通り揃ったら切る。それ以降は通常 semver。
    - pre-release は必要に応じて `v0.2.0-rc.1` のような後置サフィックスで表現。
  - **打ち始め**: 配布 CI が動いた最初のリリースを `v0.1.0` として切る (現状の Phase 4 / 5 / H1+H2+H4 完了点)。
  - **注入経路** (将来 GitHub Actions 想定):
    - tag 名から CI で `0.1.0` 部分を抽出。
    - ビルド時に `wails build -ldflags "-X main.Version=v0.1.0"` で Go 側変数に注入 (`main.go` の `var Version = "dev"` がフォールバック)。
    - 加えて、CI 内で `wails.json` の `info.productVersion` を一時 `sed` で書き換えてからビルド (Windows VS_VERSION_INFO 用)。tag が正本、`wails.json` の値はビルド時派生の方針。コミットには戻さない。
    - 未注入時 (ローカル `wails dev` / `wails build`) は `Version = "dev"` のまま動く。`logging.Info("app", "starting", "version", Version)` でログにも記録される。
- [ ] **アイコン**: 現状はテンプレートのまま。差し替え時期。 → issue #17 で詳細化済み
  - 結論: 着手時に詰める (v0.1.0 リリース前 or それ以降かも合わせて判断)。
- [x] **コードサイニング**: v1 では未署名で配布 (Defender SmartScreen 警告は受容)。
  - 結論:
    - 個人開発・想定ユーザーが自分中心のため、年間コスト (個人開発者証明書 1〜2 万円~) に対して見合わない。
    - **将来検討**: 複数ターゲット (Mac / 公開 Linux 配布 / 公開ストア出品など) に展開する判断をした時点で改めて検討する。Mac の Apple Developer Program (年 99 USD) や Windows EV 証明書、ストア審査で署名必須になるため、ターゲット拡大の意思決定とセットで詰める。
    - 当面は GitHub Releases に未署名 EXE/インストーラを置き、README で SmartScreen の警告手順を案内する想定。
- [x] **ビルド OS**: 公式は Windows ネイティブビルドのみ (GitHub Actions の `windows-latest` runner)。
  - 結論:
    - 配布対象は Windows のみ (init.md スコープ通り)。配布物は GitHub Actions の `windows-latest` 上で `wails build -platform windows/amd64` で生成する EXE / NSIS インストーラのみ。
    - 開発機 WSL2 / Linux ホストでの `wails build` (Linux ELF 出力) は **動作確認用**であって配布物ではない。README にもその旨を明記する。
    - クロスコンパイル (WSL/Linux からの Windows ビルド) は **公式サポートしない**。Wails 側の機能としては可能だが、NSIS インストーラ生成や将来の署名作業が Windows ホスト前提のため、CI で常時検証しないものを「公式」と謳わない方針。
    - 副作用として CI yaml は windows-latest 1 ジョブだけになり、コストとメンテ負荷が最小化される。

## J. 開発プロセス 🟢

- [x] **ログ**: ファイルベースの追記ロガーを `internal/logging` で実装済み (Phase 5 補足)。
  - 結論: `<UserCacheDir>/image-observer/logs/app.log` に 2MB × 3 ファイルでローテ。レベルは env > log_level.txt > settings.json (`logLevel`) > 既定 INFO の優先順で resolve。`SetLevel` で runtime 切替可。フロントからは `LogEvent` バインディング経由で送信、`shared/utils/logger.ts` の ring buffer + 全域エラーハンドラで window.onerror / unhandledrejection も拾う。
- [x] **テスト**: Go ユニットテストとフロント vitest を導入済み。
  - 結論: Go は `internal/` 配下の各パッケージ (classification / imgread / thumb / state / settings / logging / imgfile) でテーブルテスト中心、計 47+ ケース。フロントは vitest で純関数 (filters / colors / groups / layout / logger / keybindings) を中心に 107 ケース。CI は ci.yml で `go test ./internal/...` + `npm run test` + `tsc --noEmit` を毎 push/PR 実行。
- [x] **CI**: GitHub Actions で 2 yaml 構成 (テスト常時 + tag 駆動リリース)。
  - 結論:
    - **`.github/workflows/ci.yml`** — `push` (any branch) + `pull_request` をトリガに、`ubuntu-latest` で常時走る健全性チェック。
      - ステップ: `actions/setup-go@v5` (`go-version: '1.26.2'`、`.go-version` を置かない方針に従って直書き) → `actions/setup-node@v4` (Node 20) → `go test ./...` → `cd frontend && npm ci && npm run test && npx tsc --noEmit`。
      - `wails build` は呼ばない (Linux ビルドの動作確認は配布物の保証ではないため、ここでは型 / 単体テストの保証に絞る)。
    - **`.github/workflows/release.yml`** — `push: tags: ['v*']` のみをトリガに、`windows-latest` 1 ジョブで `wails build` から GitHub Releases までを通す。
      - ステップ: setup-go (1.26.2) → setup-node (20) → `go install github.com/wailsapp/wails/v2/cmd/wails@v2.12.0` (バージョンピン) → tag から `v` を剥がして `${VERSION}` 抽出 → `wails.json` の `info.productVersion` を `sed` で一時上書き (コミットしない) → `wails build -platform windows/amd64 -nsis -ldflags "-X main.Version=${TAG}"` → `softprops/action-gh-release@v2` で portable EXE と NSIS インストーラを Release に添付。`fail_on_unmatched_files: true` で誤動作防止。
      - secrets は不要 (`GITHUB_TOKEN` は GHA 自動付与)。署名 (I-4) を将来追加するときに署名ステップを差し込む拡張点を残す。
    - **役割分離**: 「コードの健全性チェック」と「リリース成果物作成」を別ファイルにすることで、トリガ条件と保守責務を明快に分ける。lint (J-4) は ci.yml の並列ジョブとして追加予定。
- [ ] **リンタ・フォーマッタ**: gofmt + golangci-lint / eslint + prettier の採用と CI 連携。 → issue #18 で詳細化済み
  - 結論: 着手時に詰める (ci.yml に lint ジョブを並列追加する想定)。

---

## 進め方メモ

1. まず A (データ / API 設計) を確定 → Folder Tree フェーズに着手可能。
2. Folder Tree 着手と同時に B を詰める。
3. Thumbnail フェーズで C・D を詰める。
4. Tab + Viewer フェーズで E を詰める。
5. F・G は該当機能の実装ついでに決める。
6. H・I・J は v0.1 タグを切る前に揃っていれば良い。
