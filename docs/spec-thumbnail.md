# Thumbnail 実装仕様書 (Phase 2)

init.md §7 の次フェーズ ② に相当。Go 側のサムネイル生成 + ディスクキャッシュ + フロント側のホバーポップアップ表示 までを対象とする。タブ / ビューア / ズーム は含まない。

## 1. ゴール (DoD)

- ツリー上の画像ノードにマウスを乗せて 250ms 以上経過すると、ノード右側にサムネイルポップアップが表示される。
- サムネイル生成は Go 側で非同期に行い、ディスクキャッシュ済みなら即返す、未生成ならその場で生成して返す。
- サムネイル生成中はポップアップ内にスピナー表示。生成失敗時はエラーアイコン表示。
- 元形式と同じ形式でキャッシュ (JPEG/PNG/GIF)。**WebP はエンコーダが Go エコシステムに無いため PNG にフォールバック**。アニメ GIF/WebP は 1 コマ目を抽出。
- アスペクト比を維持したレターボックス表示 (既定)。クロップ切替は将来対応のためフラグだけ用意。
- 並行生成数は `runtime.NumCPU() / 2` (最低 1) を上限に worker pool で制御。
- `wails build` が通り、`wails dev` でホバー動作が確認できる。
- Go 側ユニットテスト (キー生成・キャッシュヒット/ミス・形式判定) がパス。

## 2. データモデル / API

### 2.1 Go 側 API

`app.go` に追加:

```go
// 画像のサムネイルを取得 (キャッシュ優先、無ければ生成してキャッシュ)。
// 戻りは元画像形式そのままのバイト列 (JPEG/PNG/GIF/WebP)。
// フロントは `data:image/<ext>;base64,${...}` で <img src> に乗せる。
//
// 引数:
//   path: 元画像の絶対パス
//   size: 表示サイズ (px)。生成時は内部で 2 倍に拡張 (HiDPI)
//   mode: "letterbox" | "crop"
func (a *App) GetThumbnail(path string, size int, mode string) (ThumbResult, error)
```

```go
type ThumbResult struct {
    Data     []byte `json:"data"`     // 画像バイト列
    MimeType string `json:"mimeType"` // "image/jpeg" 等
}
```

`ThumbResult` を返す理由: フロントが `data:` URL を組むのに MIME を知る必要があり、毎回拡張子から推定するより明示的に渡す方が安全。

エラーは `error` で返す。フロントは catch してエラーアイコン表示に切替。

### 2.2 Go 側内部型

`thumb.go`:

```go
type ThumbConfig struct {
    DisplaySize  int    // 表示サイズ (px)
    GenerateSize int    // 生成サイズ (px) = DisplaySize * 2
    Mode         string // "letterbox" | "crop"
}

// キャッシュエントリのファイルパス組み立てに使う。
func (c ThumbConfig) cacheDir(root string) string {
    return filepath.Join(root, c.Mode, strconv.Itoa(c.GenerateSize))
}
```

### 2.3 TS 側型定義

Wails 自動生成 (`wailsjs/go/main/App.d.ts` に `GetThumbnail` が、`models.ts` に `main.ThumbResult` が出る)。手書きラッパー無し。

## 3. Go 側設計

### 3.1 ファイル構成

```
image-observer/
├── thumb.go            # GetThumbnail エントリポイント、キャッシュ参照と生成のオーケストレーション
├── thumb_cache.go      # キャッシュキー生成、ファイル読み書き
├── thumb_decode.go     # 元画像のデコード (JPEG/PNG/GIF/WebP、アニメは1コマ目)
├── thumb_resize.go     # BiLinear リサイズ + アスペクト処理 (letterbox / crop)
├── thumb_encode.go     # サムネを元形式と同じ形式でエンコード
├── thumb_pool.go       # 並行生成 worker pool (シングルトン)
└── thumb_test.go       # 単体テスト
```

### 3.2 キャッシュキー (`thumb_cache.go`)

```go
func cacheKey(path string, mtime int64, size int64) string {
    h := sha256.New()
    fmt.Fprintf(h, "%s\x00%d\x00%d", path, mtime, size)
    return hex.EncodeToString(h.Sum(nil))[:32]
}

func cachePath(root string, cfg ThumbConfig, key string, ext string) string {
    return filepath.Join(cfg.cacheDir(root), key[:2], key[2:]+ext)
}

func cacheRoot() (string, error) {
    base, err := os.UserCacheDir()
    if err != nil {
        return "", err
    }
    return filepath.Join(base, "image-observer", "cache", "thumbnails"), nil
}
```

- `key[:2]` でディレクトリをシャーディング (FS スループット維持)。
- `ext` は元画像の拡張子 (`.jpg` `.png` `.gif` `.webp` のいずれか、小文字)。
- 入力パスを変えずに mtime / size だけ変わるとキーが変わるため、自動的に別ファイルに書かれる (古い方は孤児として残る、v1 ではクリーンアップなし)。

### 3.3 GetThumbnail のフロー (`thumb.go`)

```
func GetThumbnail(path, size, mode):
    // 1. 入力検証
    abs := filepath.Abs(path)
    if !isImage(abs): return error
    if mode != "letterbox" && mode != "crop": mode = "letterbox"
    if size <= 0: size = 256
    cfg := ThumbConfig{DisplaySize: size, GenerateSize: size*2, Mode: mode}

    // 2. キャッシュ参照
    info := os.Stat(abs)
    key := cacheKey(abs, info.ModTime().Unix(), info.Size())
    ext := strings.ToLower(filepath.Ext(abs))
    root := cacheRoot()
    cachePath := cachePath(root, cfg, key, ext)
    if data := readFileIfExists(cachePath):
        return ThumbResult{Data: data, MimeType: mimeFor(ext)}, nil

    // 3. ミス: worker pool で生成 (重複リクエストを単一ジョブにまとめる)
    data := pool.Generate(abs, cfg, ext)   // 生成完了まで待機
    if err: return error

    // 4. キャッシュ書き込み
    os.MkdirAll(filepath.Dir(cachePath), 0755)
    os.WriteFile(cachePath, data, 0644)

    return ThumbResult{Data: data, MimeType: mimeFor(ext)}, nil
```

### 3.4 デコード (`thumb_decode.go`)

形式別:

| 拡張子 | デコード方法 | 備考 |
|--------|-------------|------|
| `.jpg` `.jpeg` | `image/jpeg.Decode` | 標準 |
| `.png` | `image/png.Decode` | 透過保持 |
| `.gif` | `image/gif.DecodeAll` で `*gif.GIF` を取得し `Image[0]` を採用 | 1 コマ目のみ |
| `.webp` | `golang.org/x/image/webp.Decode` | アニメ WebP は標準ライブラリでは1コマ目のみ取得される |

ファイルオープン → デコード → `image.Image` を返す関数 `decodeImage(path, ext) (image.Image, error)` を 1 つ提供。

### 3.5 リサイズ (`thumb_resize.go`)

```go
func resize(src image.Image, cfg ThumbConfig) image.Image {
    bounds := src.Bounds()
    sw, sh := bounds.Dx(), bounds.Dy()
    target := cfg.GenerateSize

    var dst *image.RGBA
    var srcRect image.Rectangle

    switch cfg.Mode {
    case "crop":
        // 短辺基準でスケール、中央クロップ
        scale := float64(target) / float64(min(sw, sh))
        scaledW, scaledH := int(float64(sw)*scale), int(float64(sh)*scale)
        // クロップ後 = target x target
        offsetX := (scaledW - target) / 2
        offsetY := (scaledH - target) / 2
        dst = image.NewRGBA(image.Rect(0, 0, target, target))
        // src を先にスケールしてからクロップ、ではなく
        // draw で srcRect を計算して直接書く
        ...
    case "letterbox":
        // 長辺基準でスケール、余白で埋める
        scale := float64(target) / float64(max(sw, sh))
        dstW, dstH := int(float64(sw)*scale), int(float64(sh)*scale)
        offsetX := (target - dstW) / 2
        offsetY := (target - dstH) / 2
        dst = image.NewRGBA(image.Rect(0, 0, target, target))
        // 余白色: 背景透明 (RGBA zero値 = 透過)
        // PNG/WebP/GIF なら透過保持、JPEG は黒余白になる (JPEG は透過非対応)
        draw.BiLinear.Scale(dst, image.Rect(offsetX, offsetY, offsetX+dstW, offsetY+dstH), src, bounds, draw.Over, nil)
    }
    return dst
}
```

要点:
- `golang.org/x/image/draw.BiLinear` を使用。
- 出力は常に `target × target` (= `GenerateSize`) の正方形。
- レターボックス時の余白は **透過** にする (元画像が透過対応形式なら維持される)。JPEG エンコード時は背景が黒くなる点を許容 (JPEG は元から透過なし)。

### 3.6 エンコード (`thumb_encode.go`)

| 入力拡張子 | 出力形式 | 出力拡張子 | エンコード方法 | パラメータ |
|-----------|---------|-----------|---------------|-----------|
| `.jpg` `.jpeg` | JPEG | `.jpg` | `image/jpeg.Encode` | quality: 85 |
| `.png` | PNG | `.png` | `image/png.Encode` | デフォルト |
| `.gif` | GIF | `.gif` | `image/gif.Encode` | デフォルト (256 色パレット) |
| `.webp` | **PNG** | **`.png`** | `image/png.Encode` | デフォルト (透過保持) |

**WebP は PNG にフォールバック** する。理由: `golang.org/x/image/webp` はデコード専用で Encode を提供せず、エンコードには libwebp 経由 (cgo) の外部依存が必要になる。配布の複雑さを避けるため v1 では PNG で保存する。透過は PNG が保持できるので画質的な劣化はない。

将来 WebP エンコードを入れる際は `github.com/chai2010/webp` 等の cgo 依存か、ピュア Go の `github.com/HugoSmits86/nativewebp` 等を検討する (Phase 後ろ倒し)。

実装上の動作:
- ソースが `.webp` の場合、サムネのキャッシュファイル名は `<key>.png`、MimeType は `image/png` を返す。
- フロントは `data:image/png;base64,...` として表示する (透過扱いされる)。

### 3.7 並行生成 (`thumb_pool.go`)

シンプルな worker pool:

```go
type pool struct {
    sem      chan struct{}    // 並行数制限 (容量 = NumCPU/2)
    inflight sync.Map         // path -> *job (重複リクエスト合流)
}

type job struct {
    done chan struct{}
    data []byte
    err  error
}

func (p *pool) Generate(path string, cfg ThumbConfig, ext string) ([]byte, error) {
    // 同じ path + cfg のリクエストが既に進行中なら結果を待ち合わせる
    // (今回はキャッシュキーをそのままジョブキーに使う)
    ...
}
```

要点:
- `sem` で並行数を制限。
- `inflight` で同一キーのリクエスト合流 (ホバーで複数 GetThumbnail が連続した場合の二重生成を防ぐ)。
- v1 では起動時 `NumCPU()/2` で固定 (設定 UI 経由の動的変更は Phase H)。

### 3.8 設定 (`thumb_defaults.go` に集約)

v1 では設定 UI なし。下記の値はすべて `thumb_defaults.go` 1 ファイルに集約してハードコード:

| 項目 | 値 | 備考 |
|------|----|----|
| 表示サイズ既定 | 256 px | フロントから引数で渡す |
| 生成倍率 | 2 | Go 側で固定 (HiDPI 想定) |
| アスペクト処理既定 | "letterbox" | フロントから引数で渡す |
| 並行 worker 数 | `max(runtime.NumCPU() / 2, 1)` | アプリ起動時に算出して固定 |
| JPEG 品質 | 85 | |

将来 Phase H で設定画面 UI を導入する際は、この `thumb_defaults.go` を `thumb_settings.go` (ディスク永続化 + ランタイム書き換え) に置換するだけで済むよう、各値を `var` の初期値として単一ファイルにまとめる。

```go
// thumb_defaults.go (v1)
package main

import "runtime"

var (
    defaultDisplaySize  = 256
    defaultMode         = "letterbox"
    generateScaleFactor = 2
    jpegQuality         = 85
)

func defaultWorkerCount() int {
    if n := runtime.NumCPU() / 2; n >= 1 {
        return n
    }
    return 1
}
```

将来 Settings struct から差し替える際の境界がここに固定される。

### 3.9 エラー方針

- 入力パスが画像でない / 存在しない → エラーを返す (フロントはエラーアイコン)
- デコード失敗 (壊れた画像) → エラーを返す
- リサイズ失敗 → エラーを返す (基本起きない)
- エンコード失敗 → エラーを返す
- キャッシュ書き込み失敗 → ログのみ、生成済みデータはそのまま返す (次回ヒットしないだけ)
- ソースが WebP の場合 → 常に PNG にフォールバックして保存・返却 (3.6 参照)。これは "エラー" ではなく仕様上の正常動作。

## 4. フロント側設計

### 4.1 ファイル追加

```
frontend/src/
├── components/
│   └── ThumbnailPopup.tsx        # ホバー時のポップアップ
├── hooks/
│   └── useThumbnail.ts           # サムネ取得 + キャッシュ + ホバー遅延制御
└── icons/
    └── ThumbErrorIcon.tsx        # 生成失敗時のアイコン
```

`TreeNode.tsx` に統合。`hooks/useThumbnail.ts` は単一画像ノード単位ではなく、**FolderPanel スコープでの「現在ホバー中のノード + キャッシュ Map」** を管理する。

### 4.2 ホバー検知と遅延 (`useThumbnail`)

```ts
type ThumbState = {
  hoveredPath: string | null;       // ホバー中の画像パス
  popupVisible: boolean;            // 250ms 経過したか
  popupAnchor: DOMRect | null;      // ノードの位置 (right/top 計算用)
  cache: Map<string, CacheEntry>;   // 取得済み Base64 データ
};

type CacheEntry =
  | { status: "loading" }
  | { status: "ok"; src: string }   // "data:image/...;base64,..."
  | { status: "error"; message: string };
```

挙動:
- `onMouseEnter(path, rect)`: `hoveredPath = path`, `popupAnchor = rect`, 250ms タイマー開始
- 250ms 経過: `popupVisible = true`、`cache` に未エントリなら GetThumbnail 呼び出し開始
- `onMouseLeave`: タイマーキャンセル、`hoveredPath = null`, `popupVisible = false` (cache は保持)
- 別ノードに直接移動: 一旦 leave → enter として扱う (タイマー再起動)

ポップアップの位置計算:
- 既定: `popupAnchor.right + 8`, `popupAnchor.top - 4`
- 画面右端より 256+16 px 内側に出ない場合: `popupAnchor.left - 256 - 8` (左側に反転)
- 画面下端より 256 px 内側に出ない場合: `popupAnchor.bottom - 256` (上揃え)

### 4.3 ポップアップ (`ThumbnailPopup.tsx`)

Props: `entry: CacheEntry`, `position: { left: number, top: number }`

```
位置 absolute、z-index 高め (1000)
背景 #000d、border 1px #333、box-shadow 0 4px 12px #0008
内側 padding 4px、サイズ 256+8 px (枠込み)
```

中身:
- `loading` → SpinnerIcon (中央)
- `ok` → `<img src={entry.src} style="max-width: 256px; max-height: 256px"/>`
- `error` → ThumbErrorIcon + メッセージ

ポップアップは `<FolderPanel>` のルートに 1 個だけ存在し、`useThumbnail` の状態に応じて表示位置と中身を切り替える (各 TreeNode に複数レンダリングしない、レンダー数削減)。

### 4.4 TreeNode.tsx への組込み

画像ノードの `<div className="tree-row">` に:
- `onMouseEnter={(e) => thumb.onEnter(node.path, e.currentTarget.getBoundingClientRect())}`
- `onMouseLeave={() => thumb.onLeave()}`

dir ノードはホバーポップアップ対象外。

### 4.5 サムネ取得呼び出し

```ts
import { GetThumbnail } from "../../wailsjs/go/main/App";

const result = await GetThumbnail(path, 256, "letterbox");
const src = `data:${result.mimeType};base64,${bytesToBase64(result.data)}`;
```

注意: Wails が `[]byte` を JS に渡すとき自動 base64 化するが、TS 型上は `number[]` か `string` (実際は base64 文字列) として現れる。生成された型を確認のうえ `btoa` 不要で直接 `data:` に組み込めるか検証 (`models.ts` のフィールド型に従う)。`number[]` で来る場合は `Uint8Array.from(arr)` → `btoa(String.fromCharCode(...arr))` で変換。

### 4.6 設定の固定値

v1 ではフロントからの引数固定:
- size: 256
- mode: "letterbox"

将来は設定 Context 経由でユーザー設定値に置換。

## 5. 依存追加

```bash
go get golang.org/x/image/webp
go get golang.org/x/image/draw
```

- `golang.org/x/image/webp`: WebP デコード (Encode は無い、PNG フォールバック方針なので不要)
- `golang.org/x/image/draw`: BiLinear リサイズ

外部依存はこの 2 つのみ。cgo を使うパッケージは導入しない (配布簡素化のため)。

## 6. ビルド / 生成手順

1. `thumb*.go` 群を追加
2. `app.go` に `GetThumbnail` メソッド追加
3. `wails build` で TS バインディング自動生成
4. フロント側コンポーネント / フック追加
5. `wails build` で動作確認

## 7. テスト方針

### 7.1 Go 側 (`thumb_test.go`)

- `cacheKey` の決定性 (同じ入力で同じキー、mtime 違うと別キー)
- `cachePath` のシャーディング (`/ab/cdef.../...`)
- 各形式のデコード → リサイズ → エンコード往復 (テストフィクスチャ画像をリポジトリに置く: `testdata/sample.{jpg,png,gif,webp}`)
- letterbox / crop の出力サイズが target × target になる
- キャッシュヒット時に元ファイルを読まずに済む (mock or 削除して確認)
- worker pool の重複リクエスト合流 (同じ path に並行 N 回呼んで生成は 1 回だけ走るか)

### 7.2 フロント側

v1 ではテスト未導入 (todo.md J)。

## 8. スコープ外 (Phase 2 では作らない)

- 設定画面 (サイズ / mode / worker 数の UI 変更)
- インライン表示モード
- LRU / 容量上限 / 自動クリーンアップ
- fsnotify によるファイル監視
- アニメーション GIF / WebP のコマ送りサムネ
- バックグラウンドでツリー全体を事前生成 (将来検討、v1 はホバー時オンデマンド)

## 9. 完了条件チェックリスト

実装完了 (2026-04-26、`go test ./...` ok + `wails build` 通過)。実機での `wails dev` 操作確認はユーザーで実施。

- [x] `GetThumbnail` API が実装されバインディング生成済み (`app.go`, `thumb.go`, 自動生成 `wailsjs/go/main/App.d.ts`)
- [x] JPEG / PNG / GIF / WebP の 4 形式すべてでデコード成功 (`thumb_decode.go`、JPEG/PNG/GIF はテスト済み、WebP はライブラリ呼び出しのみ)
- [x] WebP ソースは PNG として保存され MimeType も `image/png` を返す (`outputExtFor` + `mimeFor`、`TestOutputExtFor_WebPFallsBackToPNG`)
- [x] レターボックスで `target × target` 正方形が出る (`thumb_resize.go`、`TestGetThumbnail_RoundTripJPEG` 等で検証)
- [x] 同じ画像への 2 回目以降の `GetThumbnail` がキャッシュヒット (`TestGetThumbnail_CacheHitDoesNotReDecode`)
- [x] ファイル mtime を変えると別キャッシュとして再生成される (`TestGetThumbnail_MtimeChangeInvalidatesCache`)
- [x] キャッシュフォルダがシャーディングされている (`cacheFilePath` + `TestCacheFilePath_Sharding`)
- [x] worker pool が `NumCPU()/2` で並行制限 (`thumb_pool.go` + `defaultWorkerCount`)
- [x] 同一画像への並行リクエストが 1 ジョブに合流する (`TestThumbPool_DeduplicatesConcurrentJobs`)
- [x] フロント: 画像ノードにホバー → 250ms 後にポップアップ表示 (`useThumbnail` + `TreeNode` の `onMouseEnter`)
- [x] ポップアップが画面端で反転する (`ThumbnailPopup` の位置計算)
- [x] 画像ノードから外れるとポップアップが消える (`useThumbnail.onLeave`)
- [x] 連続ホバー時に同じ画像を 2 度取得しない (`useThumbnail` の `cacheRef` Map)
- [x] エラー時にエラーアイコン表示 (`ThumbErrorIcon` + `entry.status === "error"` 分岐)
- [x] `wails build` 成功
- [x] Go 側ユニットテストがパス (`go test ./...` ok)

完了したら todo.md の D 項目を `[x]` に更新済みであることを再確認し、次フェーズ (Phase 3: Tab + ImageView) の方針詰めに進む。
