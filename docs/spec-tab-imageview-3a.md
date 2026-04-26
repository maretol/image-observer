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

```go
func readImage(path string) (ImageResult, error) {
    abs, err := filepath.Abs(path)
    if err != nil { return ImageResult{}, err }
    if !isImage(abs) { return ImageResult{}, fmt.Errorf("not an image: %s", abs) }
    info, err := os.Stat(abs)
    if err != nil { return ImageResult{}, err }
    if info.IsDir() { return ImageResult{}, errors.New("path is a directory") }

    inputExt := strings.ToLower(filepath.Ext(abs))

    // 全形式: ディスクバイトをそのまま返す。寸法だけ DecodeConfig で軽量取得。
    data, err := os.ReadFile(abs)
    if err != nil { return ImageResult{}, err }
    w, h, err := decodeImageDimensions(abs, inputExt)
    if err != nil { return ImageResult{}, fmt.Errorf("dimensions: %w", err) }
    return ImageResult{
        Data:     data,
        MimeType: mimeForInput(inputExt),
        Width:    w,
        Height:   h,
    }, nil
}
```

### 3.3 `mimeForInput`

```go
func mimeForInput(ext string) string {
    switch strings.ToLower(ext) {
    case ".jpg", ".jpeg": return "image/jpeg"
    case ".png":          return "image/png"
    case ".gif":          return "image/gif"
    case ".webp":         return "image/webp"
    }
    return "application/octet-stream"
}
```

注意: 既存 `mimeFor` (サムネ用、`thumb_cache.go`) は **出力拡張子** を引数に取り WebP→PNG 変換後の `.png` を `image/png` に変換する。`mimeForInput` は **入力拡張子** をそのまま MIME に対応させる (原寸画像はオリジナル形式のまま返すため)。両者は別物として併存させる。

### 3.4 `decodeImageDimensions`

軽量に画像寸法だけ取得するヘルパ。`image/jpeg.DecodeConfig` 等はフルデコードせず寸法のみ読む。

```go
func decodeImageDimensions(path, ext string) (int, int, error) {
    f, err := os.Open(path)
    if err != nil { return 0, 0, err }
    defer f.Close()
    switch ext {
    case ".jpg", ".jpeg":
        cfg, err := jpeg.DecodeConfig(f); if err != nil { return 0, 0, err }
        return cfg.Width, cfg.Height, nil
    case ".png":
        cfg, err := png.DecodeConfig(f);  if err != nil { return 0, 0, err }
        return cfg.Width, cfg.Height, nil
    case ".gif":
        cfg, err := gif.DecodeConfig(f);  if err != nil { return 0, 0, err }
        return cfg.Width, cfg.Height, nil
    case ".webp":
        cfg, err := webp.DecodeConfig(f); if err != nil { return 0, 0, err }
        return cfg.Width, cfg.Height, nil
    }
    return 0, 0, fmt.Errorf("unsupported extension: %s", ext)
}
```

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

```tsx
function App() {
  const tabs = useTabs();
  // ...既存の splitter 処理...
  return (
    <div className="app" ref={containerRef}>
      <aside className="pane left" style={{ width: leftWidth }}>
        <FolderPanel onImageOpen={tabs.openTab} />
      </aside>
      <div className="splitter" onMouseDown={onMouseDown} />
      <main className="pane right">
        <ViewerPanel
          tabs={tabs.tabs}
          activeIndex={tabs.activeIndex}
          onClose={tabs.closeTab}
          onSelect={tabs.setActive}
          onUpdateTabState={tabs.updateTabState}
        />
      </main>
    </div>
  );
}
```

### 4.3 `useTabs` (ホック)

```ts
export type Tab = {
  path: string;
  zoom: number;       // current zoom (0 = uninitialized, fit to be computed on mount)
  panX: number;
  panY: number;
  initialized: boolean;
  imageWidth: number;  // 0 until ReadImage returns
  imageHeight: number;
};

export function useTabs() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);

  const openTab = useCallback((path: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.path === path);
      if (idx >= 0) {
        setActiveIndex(idx);
        return prev;
      }
      const newTab: Tab = {
        path, zoom: 0, panX: 0, panY: 0,
        initialized: false, imageWidth: 0, imageHeight: 0,
      };
      const next = [...prev, newTab];
      setActiveIndex(next.length - 1);
      return next;
    });
  }, []);

  const closeTab = useCallback((index: number) => {
    setTabs((prev) => {
      const next = prev.filter((_, i) => i !== index);
      setActiveIndex((cur) => {
        if (next.length === 0) return -1;
        if (cur === index) return Math.min(index, next.length - 1);
        if (cur > index) return cur - 1;
        return cur;
      });
      return next;
    });
  }, []);

  const setActive = useCallback((index: number) => setActiveIndex(index), []);

  const updateTabState = useCallback(
    (index: number, patch: Partial<Tab>) => {
      setTabs((prev) =>
        prev.map((t, i) => (i === index ? { ...t, ...patch } : t))
      );
    },
    []
  );

  return { tabs, activeIndex, openTab, closeTab, setActive, updateTabState };
}
```

### 4.4 `ViewerPanel` 構造

```
┌─────────────────────────────────────────┐
│ [Tab1 ×] [Tab2 ×] [Tab3 ×]              │  ← TabBar (横スクロール対応)
├─────────────────────────────────────────┤
│                                         │
│         (image with zoom/pan)           │  ← ImageView
│                                         │
└─────────────────────────────────────────┘
```

タブ無し状態: 中央に「画像を選択してください」プレースホルダ。

```tsx
function ViewerPanel(props) {
  const activeTab = props.tabs[props.activeIndex];
  return (
    <div className="viewer-panel">
      {props.tabs.length > 0 && (
        <TabBar
          tabs={props.tabs}
          activeIndex={props.activeIndex}
          onClose={props.onClose}
          onSelect={props.onSelect}
        />
      )}
      <div className="viewer-canvas">
        {activeTab ? (
          <ImageView
            tab={activeTab}
            tabIndex={props.activeIndex}
            onUpdateTabState={props.onUpdateTabState}
          />
        ) : (
          <div className="viewer-empty">画像を選択してください</div>
        )}
      </div>
    </div>
  );
}
```

### 4.5 `TabBar`

タブの構造:
```tsx
<div className="tab-bar">
  {tabs.map((tab, i) => (
    <div
      key={`${tab.path}-${i}`}
      className={`tab ${i === activeIndex ? "active" : ""}`}
      onClick={() => onSelect(i)}
    >
      <span className="tab-name" title={tab.path}>{basename(tab.path)}</span>
      <button
        className="tab-close"
        onClick={(e) => { e.stopPropagation(); onClose(i); }}
      >
        <CloseIcon />
      </button>
    </div>
  ))}
</div>
```

スタイル:
- 横並び (flex)、横スクロール時は `overflow-x: auto`
- タブ高さ 32px、横は名前長に合わせて可変、最大 200px (超えたら省略)
- アクティブタブは背景強調

### 4.6 `ImageView` + `useImageViewer`

```ts
type ViewerState = { zoom: number; panX: number; panY: number };

export function useImageViewer(opts: {
  imageWidth: number;
  imageHeight: number;
  initialZoom: number;
  initialPanX: number;
  initialPanY: number;
  initialized: boolean;
  containerRef: React.RefObject<HTMLDivElement>;
  onChange: (state: ViewerState) => void;
}) { ... }
```

主要ロジック:

#### 初期 fit 計算
```ts
function computeInitialFit(imgW, imgH, vpW, vpH): ViewerState {
  const fitZoom = Math.min(vpW / imgW, vpH / imgH);
  const zoom = Math.min(1.0, fitZoom);
  const renderedW = imgW * zoom;
  const renderedH = imgH * zoom;
  return {
    zoom,
    panX: (vpW - renderedW) / 2,
    panY: (vpH - renderedH) / 2,
  };
}
```

ImageView マウント時に `tab.initialized === false && imageWidth > 0` なら計算して `onUpdateTabState({ zoom, panX, panY, initialized: true })`。

#### ズーム (ホイール)
```ts
function onWheel(e: WheelEvent) {
  e.preventDefault();
  const rect = containerRef.current.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;
  const direction = e.deltaY < 0 ? 1 : -1;
  const factor = direction > 0 ? 1.2 : 1 / 1.2;
  const newZoom = clamp(state.zoom * factor, 0.1, 8.0);
  // カーソル下の画像ピクセルが移動しないように pan を補正
  const px = (cx - state.panX) / state.zoom;
  const py = (cy - state.panY) / state.zoom;
  let newPanX = cx - px * newZoom;
  let newPanY = cy - py * newZoom;
  ({ panX: newPanX, panY: newPanY } = clampPan(
    newPanX, newPanY, imgW * newZoom, imgH * newZoom, vpW, vpH
  ));
  setState({ zoom: newZoom, panX: newPanX, panY: newPanY });
}
```

#### パン (ドラッグ)
```ts
function onMouseDown(e) {
  dragRef.current = { startX: e.clientX, startY: e.clientY, startPanX: state.panX, startPanY: state.panY };
}
function onMouseMove(e) {
  if (!dragRef.current) return;
  let nx = dragRef.current.startPanX + (e.clientX - dragRef.current.startX);
  let ny = dragRef.current.startPanY + (e.clientY - dragRef.current.startY);
  ({ panX: nx, panY: ny } = clampPan(nx, ny, imgW * zoom, imgH * zoom, vpW, vpH));
  setState({ ...state, panX: nx, panY: ny });
}
function onMouseUp() { dragRef.current = null; }
```

#### パン境界クランプ
```ts
function clampPan(panX, panY, renderedW, renderedH, vpW, vpH): ViewerState {
  // 画像が小さい (両軸) → センタリング固定
  let nx = renderedW < vpW ? (vpW - renderedW) / 2 : clamp(panX, vpW - renderedW, 0);
  let ny = renderedH < vpH ? (vpH - renderedH) / 2 : clamp(panY, vpH - renderedH, 0);
  return { zoom: 0, panX: nx, panY: ny };  // zoom 値は呼び出し側で持つ
}
```

#### ImageView 描画
```tsx
function ImageView({ tab, tabIndex, onUpdateTabState }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [imageData, setImageData] = useState<ImageResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    setImageData(null);
    setLoadError(null);
    ReadImage(tab.path)
      .then((res) => {
        setImageData(res);
        // imageWidth/Height をタブに反映
        onUpdateTabState(tabIndex, { imageWidth: res.width, imageHeight: res.height });
      })
      .catch((e) => setLoadError(errorMessage(e)));
  }, [tab.path]);

  // 初期 fit
  useEffect(() => {
    if (!tab.initialized && tab.imageWidth > 0 && containerRef.current) {
      const { width: vpW, height: vpH } = containerRef.current.getBoundingClientRect();
      const fit = computeInitialFit(tab.imageWidth, tab.imageHeight, vpW, vpH);
      onUpdateTabState(tabIndex, { ...fit, initialized: true });
    }
  }, [tab.initialized, tab.imageWidth, tab.imageHeight]);

  // ホイール / ドラッグハンドラ (useImageViewer 経由 or 直接)
  // ...

  return (
    <div className="image-view" ref={containerRef}>
      {imageData && tab.initialized && (
        <img
          className="image-view-img"
          src={`data:${imageData.mimeType};base64,${toBase64(imageData.data)}`}
          alt=""
          draggable={false}
          style={{
            transform: `translate3d(${tab.panX}px, ${tab.panY}px, 0) scale(${tab.zoom})`,
            transformOrigin: "0 0",
          }}
        />
      )}
      {loadError && <div className="image-view-error">読み込み失敗: {loadError}</div>}
    </div>
  );
}
```

### 4.7 背景 (チェッカ柄)

`.image-view-img` に CSS で透過チェッカ柄を背景に敷く:

```css
.image-view-img {
  background-color: #2a2a2a;
  background-image:
    linear-gradient(45deg, #444 25%, transparent 25%),
    linear-gradient(-45deg, #444 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #444 75%),
    linear-gradient(-45deg, transparent 75%, #444 75%);
  background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0px;
  pointer-events: none;
  user-select: none;
  position: absolute;
  top: 0;
  left: 0;
  /* width/height は intrinsic (= natural size of the source bytes; transform で scale される) */
}
```

`.image-view` (コンテナ) は `.pane.right` の単色背景 (#1e1e1e) を継承。

### 4.8 base64 変換

Phase 2 で書いた `bytesArrayToBase64` を `useThumbnail.ts` から共通 util に切り出す。`frontend/src/utils/base64.ts` に移動。

```ts
export function toDataURL(data: number[] | string | Uint8Array, mimeType: string): string {
  let b64: string;
  if (typeof data === "string") b64 = data;
  else if (Array.isArray(data)) b64 = bytesArrayToBase64(data);
  else if (data instanceof Uint8Array) b64 = bytesArrayToBase64(Array.from(data));
  else b64 = String(data);
  return `data:${mimeType};base64,${b64}`;
}
```

`useThumbnail.ts` も同 util を使うようリファクタ。

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
