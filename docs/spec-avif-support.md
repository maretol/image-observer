# AVIF 表示対応 実装仕様書

> **ステータス**: D1 (デコーダ依存の可否) = **Option A (依存を増やさない)** で合意済み (2026-05-31)。D2〜D5 は推奨デフォルト (D2=A1 / D3=元バイト列 / D4=許容 / D5=据え置き) を採用案として確定。最終 go サイン後に実装着手。

issue [#118](https://github.com/maretol/image-observer/issues/118) に対応する。ディレクトリスキャンで `.avif` が一覧に出るようにし、ビューア表示とサムネイルが動くようにする。

## 改訂履歴

| 日付 | 変更 |
|------|------|
| 2026-05-31 | 初版ドラフト。現状調査・設計案・決定事項を整理。 |
| 2026-05-31 | レビュー: D1 = Option A (依存追加なし) で合意。D2〜D5 は推奨デフォルトを採用案として確定 (§7 に追記)。 |
| 2026-05-31 | 実装追従: 寸法補完を本体 `<img onLoad>` から **probe Image** に変更 (本体 `<img>` は `hasContent` ゲートで描画されず onLoad で測れないため) — §4.3/§4.5 更新。Go は avif を decode しないため実 fixture 不要に — §6 更新。context.md に AVIF 行を追加。 |

## 1. ゴール (DoD)

- `.avif` を含むディレクトリで、avif ファイルがツリー / 一覧 / 分類ビューに **画像として** 列挙される。
- avif をタブで開くと **ビューアに表示される** (拡大縮小 / 初期 fit を含む)。
- グリッド (分類ビュー) で avif の **サムネイルが表示される** (エラーアイコンにならない)。
- `wails build` が通り、`wails dev` で avif の一覧 / 表示 / サムネイルが確認できる。
- Go 側ユニットテスト (allowlist 判定 / mime 判定 / 採用方式に応じた寸法・サムネ経路) がパス。
- **新規ライブラリ依存を増やさない** (D1 で Option A を採る場合)。

## 2. 用語

- **コンテナ**: AVIF は ISOBMFF (HEIF) コンテナ。実体は AV1 で符号化された 1 フレーム。
- **WebView デコード**: フロントが受け取った生バイト列を `Blob` 化し `<img>` に乗せる経路。実デコードは WebView (production = WebView2 / dev = WebKitGTK) が行う。
- **Go 側デコード**: `image/*` / `golang.org/x/image/*` で Go プロセス内でピクセルに展開する経路。寸法取得とサムネイル生成で使う。

## 3. 背景・現状調査

### 3.1 現状の経路と「読めない」原因

| 経路 | 実装 | avif の現状 |
|------|------|-------------|
| allowlist | `internal/imgfile/imgfile.go` `imageExts` (jpg/jpeg/png/gif/webp) | `.avif` が無い → スキャンに出ない / `IsImage` false で `Read` 等が即 error |
| 寸法 + 本体 | `internal/imgread/imgread.go` `Read` / `ReadInfo` → `decodeImageDimensions` | Go 側 decode 前提。avif は decode 不可で `Read` 全体が reject → 表示できない |
| サムネイル | `internal/thumb/{thumb,decode,encode}.go` | Go 側 decode→resize→re-encode 前提。avif decode 不可で生成失敗 → グリッドはエラーアイコン |
| フロント表示 | `ImageView.tsx` / `useGridThumbnail.ts` | bytes を `Blob`(mime) 化して `<img>` に渡すのみ。**WebView は avif をデコード可能** |

ポイント: **表示そのもの (WebView デコード) は元々可能**。詰まっているのは Go 側の (a) allowlist と (b) `Read`/`ReadInfo` が常に Go 側 decode で寸法を取ろうとして avif で落ちる点、(c) サムネイル生成が Go 側 decode 前提な点。

### 3.2 Go 側 avif デコーダの事情 (制約)

- 標準 `image/*` と `golang.org/x/image` (現 v0.41.0) に **avif デコーダは無い**。
- 既存方針 (`.claude/context.md` L63): 「WebP エンコード不採用 = **cgo 依存回避**」。
  → cgo ベースの libavif/libaom バインディング追加はこの方針と衝突する。
- 純 Go / wasm 系デコーダ (例: wazero 上で動く avif デコーダ) は cgo を避けられるが、埋め込み wasm を含む重量級依存であり、CLAUDE.md「追加ライブラリは原則入れない / 導入時は事前合意」に該当する。

### 3.3 寸法 (Width/Height) の使われ方 (Go 側 decode を外す場合の影響)

- `ImageView.tsx` 初期 fit useEffect は `tab.imageWidth > 0 && tab.imageHeight > 0` を要求 (`computeInitialFit` 駆動)。**0 だと初期 fit が走らない**。
- `useViewerSet.ts` の `preflight` は `info.width * info.height > maxPixels` で過大画像を警告する。**0 だと常に閾値を通過** (avif は size 警告がかからない)。
- フロントは現状 Go 提供の寸法のみを使い、`<img>.naturalWidth/Height` は使っていない。

## 4. 設計方針 (推奨 = Option A: 依存を増やさない)

> D1 の決定により A / B いずれかを採る。以下は **推奨案 A** を前提に記述し、B との差分は §7 に示す。

避けたいのは「allowlist に追加しただけで Go 側 decode に到達して落ちる」状態。**avif は Go 側 decode を経由させず、生バイト列を WebView に委ねる** のが A の骨子。

### 4.1 allowlist (`internal/imgfile/imgfile.go`)

- `imageExts` に `".avif": true` を追加。これで一覧 / スキャン / `IsImage` ゲートを通過する。

### 4.2 mime (`internal/imgread/imgread.go` / `internal/thumb/cache.go`)

- `mimeForInput` に `case ".avif": return "image/avif"` を追加。
- WebView は `Blob({type:"image/avif"})` を `<img>` で正しくデコードする。

### 4.3 寸法 (`internal/imgread/imgread.go`) — D2 で確定

`decodeImageDimensions` は avif で error を返してはならない (返すと `Read` 全体が落ちる)。候補:

- **A1 (採用): Go 側は寸法 0 を返し、フロントが decode 済み bitmap の `naturalWidth/Height` で補完**
  - `decodeImageDimensions` の avif ケースは `return 0, 0, nil` (error にしない)。
  - `ImageView.tsx`: 本体 `<img>` は `hasContent` (= `imageWidth/Height > 0`) ゲートの内側でしか描画されないため、その `onLoad` では寸法を測れない (chicken-and-egg)。代わりに `ReadImage` 受領時に `res.width/height === 0` を検出したら **独立した probe `Image`** に同じバイト列の Blob URL を読ませ、`onload` で `naturalWidth/Height` を取得 → tab state を更新して初期 fit / `hasContent` を駆動する (§4.5)。
  - 長所: コンテナ解析不要 / 回転 (irot) 込みの **表示実寸** が常に正しい。
  - 短所: `preflight` の過大画像ガードが avif で効かない (§7 D4 で扱う)。フロント変更が要る。probe で 1 回余分に decode する。
- **A2: Go で ISOBMFF `ispe` ボックスを解析して寸法を得る (依存なし、~60-100 行 + テスト)**
  - 長所: 既存の「寸法は Go が出す」モデルを保てる (フロント無改修 / preflight も機能)。
  - 短所: コンテナ解析のエッジ (irot/imir で表示と転置 / grid 派生 / 複数 item) を抱える。
- **A3 (折衷): preflight 用に Go で `ispe` のピクセル数のみ取得 (回転不変) + fit はフロント naturalWidth**
  - 長所: preflight も初期 fit も両立。短所: 最も実装量が多い。

### 4.4 サムネイル (`internal/thumb/`) — D3

Go で avif を decode できない以上、downscale 済みサムネイルは作れない。no-dep での唯一の選択は **元バイト列をそのまま「サムネイル」として返す**:

- `thumb.Get` の avif ケース: decode/resize/encode を行わず `os.ReadFile(orig)` を `Result{Data, MimeType:"image/avif"}` で返す (ディスクキャッシュは行わない or 元をそのまま置く)。
- フロント `useGridThumbnail` は `Blob(image/avif)` を生成し WebView が CSS で縮小表示する。
- これは WebP→PNG フォールバック (spec-thumbnail §3.6) と同じく **「エラーではなく仕様上の正常動作」** と位置づける。
- 短所 (明示): downscale されないので、巨大 avif を多数並べると `useGridThumbnail` のメモリ前提 (1 枚 30-150KB) を超える。§7 D5 で扱う。

### 4.5 フロント変更 (A1 採用時のみ)

- `ImageView.tsx` の `ReadImage(path).then(res => ...)`: `res.width/height > 0` の従来形式はこれまでどおり Go 寸法で tab state を更新。`0` (= avif) のときだけ **probe `Image`** を起こす:
  - `res.data`/`res.mimeType` から作った Blob URL を probe の `src` に設定。
  - `probe.onload`: URL を revoke → `cancelled` でなければ `naturalWidth/Height` を読み、`tab.imageWidth/Height` と異なれば `updateRef.current(tabIndexRef.current, {...})` で補完。
  - `probe.onerror`: URL を revoke → `logger.warn` のみ (cancelled 後は抑止)。
  - revoke は load/error どちらでも行うので、unmount / path 切替 (cancelled=true) 後に発火しても URL はリークしない。
  - 本体 `<img>` の `onLoad` は使わない (§4.3 A1 の chicken-and-egg 理由)。
- 既存の preview / original の src precedence・Blob revoke 責務 (spec D-9) には触れない。`getPreview` は `GetThumbnail` 委譲なので avif passthrough (§4.4) がそのまま効き、preview も元バイト列になる (downscale なし = D5 と整合)。

## 5. データモデル / API

- **変更なし**。`imgread.Result` / `imgread.Info` / `thumb.Result` の形は維持。
- 追加 IPC・state schema・永続化形式の変更は **無し**。

## 6. テスト

- Go (**A 採用では実 avif fixture は不要** — Go は avif を一切 decode しないため、`.avif` 拡張子のダミーバイト列で全経路を網羅できる):
  - `imgfile` (`TestIsImage`): `.avif` / `.AVIF` が `IsImage` true。
  - `imgread` (`TestRead_AVIF_PassThroughNoDecode` / `TestReadInfo_AVIF_ZeroDims` / `TestMimeForInput`): avif で `Read`/`ReadInfo` が error にならず mime=`image/avif`、Data=元バイト列、寸法 0x0。
  - `thumb` (`TestGetThumbnail_AVIF_PassThroughNoCache`): avif で `Get` が error にならず元バイト列 + `image/avif` を返し、disk cache を書かない。
- フロント: probe Image → naturalWidth 補完は DOM/Image の非同期経路で純関数化しづらいため、**手動確認に倒す** (§6 手動)。`tsc` / 既存 vitest スイートは緑であること。
- 手動 (`wails dev`): avif を含むフォルダで ①一覧に出る ②開いて表示 + 初期 fit ③グリッドでサムネ表示。
  - **dev 環境の注意**: dev は WSL2 / WebKitGTK。WebKitGTK の avif サポートはビルド依存で、production の WebView2 とは挙動が異なりうる。dev で表示できなくても production で出る可能性があるため、表示確認は WebView2 側を正とする旨を test plan に明記する。

## 7. 決定事項

> **確定 (2026-05-31)**: D1 = **A (依存追加なし)**。これに伴い D2 = **A1**、D3 = **元バイト列を返す**、D4 = **avif の preflight ガード欠落を許容**、D5 = **`CACHE_MAX` 据え置き (rare として許容)** を採用案として確定。下記は判断の経緯として残す。

### D1: avif デコーダ依存を追加するか **【最重要 / 確定: A】**

- **A (推奨): 追加しない**。Go 側 decode を回避し WebView に委ねる (§4)。
  - 根拠: context.md の「cgo 回避 / WebP エンコード不採用 → フォールバック」precedent と一貫。新規依存ゼロ。
  - 代償: サムネイルが downscale されない (D5) / 寸法を別手段で得る (D2)。
- **B: 純 Go/wasm の avif デコーダを追加** (cgo は context.md 方針で除外)。
  - 利点: 既存 webp と対称に Go で寸法取得 + 実サムネイル生成。フロント無改修。
  - 代償: 重量級の新規依存 (埋め込み wasm)。CLAUDE.md「事前合意」事項。バイナリサイズ増。
  - 採用するなら §4.3/§4.4 は不要になり、imgread/thumb の avif ケースは jpeg 等と同じ実 decode 経路になる。

### D2: 寸法の取得方式 (A 採用時) — **A1 / A2 / A3**

推奨は **A1** (Go 0 + フロント naturalWidth)。理由は回転込みの表示実寸が常に正しく、コンテナ解析の脆さを避けられるため。preflight ガードを重視するなら A3。

### D3: サムネイル方式 (A 採用時)

§4.4 の「元バイト列を返す」で確定で良いか。代替: avif グリッドはサムネ無し (汎用プレースホルダ) に倒す案もある (メモリは軽いが見た目が劣る)。

### D4: preflight 過大画像ガードを avif で諦めるか (A1 採用時)

A1 では avif の size 警告が効かない。許容するか / A3 にして `ispe` ピクセル数だけ取るか。

### D5: サムネイルのメモリ上限 (A 採用時)

元 avif をそのまま blob 化するため巨大 avif の多並びでメモリ増。`useGridThumbnail` の `CACHE_MAX` を avif 含有時に見直すか、当面 v1 は据え置き (rare として許容) か。

## 8. Out of scope

- avif の Go 側エンコード / 再圧縮。
- アニメーション avif のコマ送り (1 フレーム表示のみ)。
- HEIC / AVIF 以外の新フォーマット追加 (本 issue は avif のみ)。
- avif の EXIF / ICC プロファイル取り回し。

## 9. Phase 分割

A 採用なら 1 PR で完結可能:

1. allowlist + mime (§4.1/§4.2) + imgread 寸法 (§4.3 の採用案) + Go テスト。
2. thumb の avif フォールバック (§4.4) + Go テスト。
3. (A1 のとき) フロント naturalWidth 補完 (§4.5)。
4. `wails dev` 手動確認 + PR。
