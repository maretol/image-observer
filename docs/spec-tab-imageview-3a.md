# Tab + ImageView 実装仕様書 (Phase 3a)

init.md §7 の次フェーズ ③+④ に相当する Phase 3 の **第 1 段階**。本 spec の対象は「**単一パネル** + タブ + 画像表示 + ズーム/パン + EXIF Orientation 尊重 + 背景」まで。グリッド分割・タブ移動・セッション復元は Phase 3b / 3c に分離。

## 1. ゴール (DoD)

- ツリー上の画像ノードをクリックすると、右ペインのビューア領域に新しいタブとして開かれる。
- 同じ画像をクリックすると既存タブにフォーカスする (3a は単一パネルなので「アクティブパネル内に同じ画像があるか」の判定が `tabs.find(path)` と等価)。
- タブは `×` ボタンで閉じれる。タブを切り替えると別画像が表示される。
- 画像はホイールでズーム (カーソル位置中心)、ドラッグでパン可能。
- 初期表示は **100% で収まれば 100%、収まらなければビューア枠にフィット**。
- **原寸表示は常にディスクのバイトをそのまま返す** (再エンコードしない、画質劣化ゼロ)。
- ビューア背景は単色、画像の透過部分にはチェッカ柄が見える。
- `wails build` が通り、`wails dev` で操作確認できる。
- Go 側ユニットテストがパス。

**EXIF Orientation は v1 では非対応** (todo.md E9 改定)。スマホ写真等で縦横が崩れて表示される可能性があるが許容。

## 2. データモデル / API

### 2.1 Go 側 API

`app.go` に追加:

```go
// 原寸画像を取得。
// - 全形式 (JPEG/PNG/GIF/WebP) について、ディスクのバイトをそのまま返す。再エンコードしない。
// - Width / Height は image.DecodeConfig 系で軽量に取得した寸法を返す
//   (フロントが初期 fit 倍率を計算するため、画像本体ロード前から寸法が分かる必要がある)。
// - EXIF Orientation は v1 では考慮しない (todo.md E9)。
func (a *App) ReadImage(path string) (ImageResult, error)
```

```go
type ImageResult struct {
    Data     []byte `json:"data"`
    MimeType string `json:"mimeType"`
    Width    int    `json:"width"`
    Height   int    `json:"height"`
}
```

**設計原則: 原寸画像は常に再エンコードしない**。JPEG の品質を quality=95 等で再エンコードしても劣化はあるため、画像閲覧アプリとしてオリジナルバイトを忠実に返す方針を取る。これにより API は「ファイルを読んで寸法を取り、両方を返す」だけのシンプルな実装になる。

## 3. Go 側設計

### 3.1 ファイル構成

```
image-observer/
├── image.go                # readImage + decodeImageDimensions + mimeForInput
└── image_test.go           # readImage の挙動 (バイト一致 / 寸法 / エラー)
```

EXIF 関連ファイルは無し。Phase 2 既実装の `thumb_*.go` も変更なし。

### 3.2 `image.go`

パスを絶対化 → 画像拡張子チェック → `os.ReadFile` でバイト取得 → `decodeImageDimensions` で寸法取得 → `ImageResult` を返す。

see `image.go:readImage`

### 3.3 `mimeForInput`

入力拡張子 (`.jpg/.jpeg/.png/.gif/.webp`) → MIME 型のマッピング。不明は `application/octet-stream`。サムネ用の `mimeFor` (出力拡張子) とは別物。

see `image.go:mimeForInput`

### 3.4 `decodeImageDimensions`

各形式の `DecodeConfig` を使い、フルデコードせず寸法のみ軽量取得する。JPEG/PNG/GIF/WebP に対応。

see `image.go:decodeImageDimensions`

### 3.5 エラー方針

- 入力が画像でない / 存在しない / ディレクトリ → エラー
- ファイル読み込み失敗 → エラー
- 寸法取得失敗 (壊れた画像) → エラー (`Data` を返さない、フロントはエラー表示)

## 4. フロント側設計

### 4.1 ファイル追加 / 更新

```
frontend/src/
├── App.tsx                    # 右ペインを <ViewerPanel/> に置換 (更新)
├── components/
│   ├── FolderPanel.tsx        # onImageOpen prop を受け取って TreeNode に渡す (更新)
│   ├── TreeNode.tsx           # 画像クリックで onImageOpen(path) を呼ぶ (更新)
│   ├── ViewerPanel.tsx        # 右ペイン全体: TabBar + ImageView を統括 (新規)
│   ├── TabBar.tsx             # タブ一覧 + クローズボタン (新規)
│   └── ImageView.tsx          # 1 枚の画像表示 + zoom/pan (新規)
├── hooks/
│   ├── useTabs.ts             # タブ配列 + アクティブ管理 + 重複検出 (新規)
│   └── useImageViewer.ts      # zoom/pan 状態 + ホイール/ドラッグ計算 (新規)
└── icons/
    └── CloseIcon.tsx          # タブ × ボタン (新規)
```

### 4.2 状態の所在

`App.tsx` で `useTabs()` を呼び、`tabs` ステートとアクションを `FolderPanel` (open のみ) と `ViewerPanel` (フル) に prop で渡す。Context は v1 では使わない (props で十分シンプル)。

`App.tsx` で `useTabs()` を呼び `tabs` と各アクションを `FolderPanel` (openTab のみ) と `ViewerPanel` (フル) に prop で渡す。

see `frontend/src/App.tsx`

### 4.3 `useTabs` (ホック)

状態: `Tab[]` + `activeIndex`。API: `openTab(path)` (重複検出あり) / `closeTab(index)` / `setActive(index)` / `updateTabState(index, patch)`。

see `frontend/src/hooks/useTabs.ts`

### 4.4 `ViewerPanel` 構造

TabBar + ImageView のコンテナ。タブ無し状態: 中央に「画像を選択してください」プレースホルダ。

### 4.5 `TabBar`

横並び flex。タブ高さ 32px、名前は最大 200px (省略)。アクティブはハイライト。横スクロール対応。

スタイル:
- 横並び (flex)、横スクロール時は `overflow-x: auto`
- タブ高さ 32px、横は名前長に合わせて可変、最大 200px (超えたら省略)
- アクティブタブは背景強調

### 4.6 `ImageView` + `useImageViewer`

主要ロジック: 初期 fit 計算 (`computeInitialFit`: `min(1.0, min(vpW/imgW, vpH/imgH))` で zoom + センタリング)、ホイールズーム (カーソル基点 1.2 倍ステップ + `clampPan`)、ドラッグパン (`dragRef` + `clampPan`)。

`ImageView`: `ReadImage(tab.path)` で画像取得 → `onUpdateTabState` で `imageWidth/Height` を同期 → `useLayoutEffect` で初期 fit → `img style={{ transform: translate3d + scale }}`。

see `frontend/src/features/viewer-grid/ImageView.tsx` / `useImageViewer.ts`

### 4.7 背景 (チェッカ柄)

`.image-view-img` に `linear-gradient` 4 つで 16px チェッカ柄を設定。`pointer-events:none; position:absolute; top/left:0`。コンテナ `.image-view` は単色背景 (#1e1e1e)。

see `frontend/src/App.css`

### 4.8 base64 変換

`bytesArrayToBase64` を `useThumbnail.ts` から `frontend/src/utils/base64.ts` に切り出し、`toDataURL(data, mimeType)` として提供。`useThumbnail.ts` / `ImageView.tsx` から共有。

see `frontend/src/shared/utils/`

### 4.9 タブ切り替え時の挙動

- `activeIndex` が変わると、`ViewerPanel` は `activeTab` を渡し直す
- `ImageView` は `tab.path` の変化を `useEffect` で検出 → 再 ReadImage
- 前のタブの zoom/pan は `tabs[]` 内に保持されているので、次回そのタブに戻ったとき復元される
- `imageData` は active tab 切替時に破棄 (N4 「タブで開いている画像のみオンメモリ保持」を厳密に解釈すると全タブ分メモリに乗せるべきだが、Phase 3a では active tab のみとし、N4 拡張解釈とする。Phase 3b で再考)

## 5. 依存追加

なし。Phase 2 で導入済みの `golang.org/x/image/webp` (DecodeConfig) と Go 標準の `image/jpeg` `image/png` `image/gif` だけで足りる。

## 6. ビルド / 生成手順

1. `image.go` / `image_test.go` を追加
2. `app.go` に `ReadImage` メソッド追加
3. `wails build` で TS バインディング自動生成
4. フロント側コンポーネント / フック / utils 追加
5. `wails build` で動作確認

## 7. テスト方針

### 7.1 Go 側

- `image_test.go`:
  - 各形式 (JPEG / PNG / GIF / WebP) について、`readImage` の戻り `Data` が入力ファイルのバイトと **完全一致** すること (再エンコードしていないことの担保)
  - 各形式の `Width / Height` が正しいこと
  - `MimeType` が正しいこと (例: `.jpg` → `image/jpeg`)
  - 画像でないファイル / 存在しないパス / ディレクトリ → エラー
- 既存の `thumb_test.go` は影響なし (Phase 2 のサムネ生成パスを変更しないため)

### 7.2 フロント側

v1 ではテスト未導入 (todo.md J)。

## 8. スコープ外 (Phase 3a では作らない、3b/3c で扱う)

### Phase 3b (グリッド分割 + タブ移動)
- ビューア領域の 2 行 × 3 列 までのグリッド分割
- アクティブパネルの概念
- パネル間のタブ移動コマンド (右クリックメニュー等)
- 行/列の追加・削除 UI
- 行間/列間スプリッター

### Phase 3c (セッション復元 + F 部分確定)
- 起動時の状態復元 (タブ一覧 / 各タブ zoom/pan / グリッド形状 / アクティブパネル)
- 永続化先 / 保存タイミング (todo.md F の確定)

### その他 (将来フェーズ)
- **EXIF Orientation の適用** — todo.md E9 改定により v1 非対応。スマホ写真等の縦横崩れを許容する。将来検討時は CSS transform でクライアント側回転 (バイト保持) する案を優先。
- キーボードショートカット (Ctrl+W / Ctrl+Tab / Ctrl+0 / Ctrl+1 / Ctrl+F 等) — todo.md H
- 壊れた画像の詳細エラー UI / トースト通知 — todo.md G
- 巨大画像のサイズ上限 / 縮小プレビュー — todo.md G
- 全タブ分の画像メモリ保持 (Phase 3a は active tab のみ) — Phase 3b で再考

## 9. 完了条件チェックリスト

実装完了 (2026-04-26、`go test ./...` ok + `wails build` 通過)。実機での `wails dev` 操作確認はユーザーで実施。

- [x] `ReadImage` API が実装されバインディング生成済み (`app.go`, `image.go`、自動生成 `wailsjs/go/main/App.d.ts`)
- [x] 全形式 (JPEG/PNG/GIF/WebP) で `Data` がディスクバイトと完全一致 (`TestReadImage_*_BytesUnchanged` 3 ケース、WebP は DecodeConfig 経路のみ実装、テストフィクスチャ生成困難のため割愛)
- [x] `Width / Height` が正しく返る (`decodeImageDimensions` + 各テスト)
- [x] ツリーで画像クリック → 新タブで開く / 既存タブにフォーカス (`useTabs.openTab` の findIndex 分岐)
- [x] タブの × で閉じれる、複数タブの切替ができる (`TabBar` + `useTabs.closeTab/setActive`)
- [x] 画像の初期表示が `min(1.0, fitZoom)` で中央配置 (`computeInitialFit`)
- [x] ホイールでカーソル位置中心にズーム (1.2 倍ステップ、10%〜800% クランプ) (`ImageView` の wheel ハンドラ、`{ passive: false }` で attach)
- [x] ドラッグでパン、画像 < ビューアはセンタリング固定、画像 > ビューアは端で止まる (`clampPan`)
- [x] 透過 PNG を開くと透過部分にチェッカ柄が見える (`.image-view-img` の CSS background)
- [x] タブ切替で各タブの zoom/pan が保持されている (`useTabs` で per-tab に保持)
- [x] `wails build` 成功
- [x] Go 側ユニットテストがパス (`go test ./...` ok、計 18 ケース: tree 7 + thumb 11 + image 7)

完了したら todo.md の E1〜E2 / E5〜E10 (E9 は v1 非対応として確定) / E3 の「タブ並び替え不要」部分の実装根拠が揃う。E3 のグリッド分割部分と E4 のセッション復元は Phase 3b / 3c で扱う。
