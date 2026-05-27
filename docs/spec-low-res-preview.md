# 低解像度プレビュー先行表示 実装仕様書 (#97)

> **ステータス**: Phase 1 実装済み (PR #103)。手動検証は同 PR の test plan で実施。

ストレージ速度が遅い場合、ビューア (`ImageView`) でオリジナル画像のロードに数百 ms 〜 数秒かかると、その間「読み込み中…」のプレーンテキストしか出ない。本仕様では **オリジナルが届くまでの間、サムネイル/モーダルで使っているのと同じ Go 側ディスクキャッシュから 1024px プレビューを取得して一時表示** することで、画面が真っ暗にならないようにする。

## 改訂履歴

| 日付 | 改訂 |
|------|------|
| 2026-05-27 | 初版 (ユーザーレビュー待ち) |
| 2026-05-27 | レビュー反映: §10 の 5 論点を確定 (閾値なし / transition なし / TS 側ラッパ `getPreview` 採用)。§4 D-10 / §5.2.1 / §5.2.2 / §5.2.3 / §10 を更新。 |
| 2026-05-27 | PR #103 Copilot レビュー反映: §3.1 SampleModal 記述を `getPreview` 経由に更新 / §10 D-14・D-15 の実装挙動を「`tab.initialized && (previewUrl || imageData)` 揃うまで「読み込み中…」維持」に統一。 |
| 2026-05-27 | PR #103 Copilot レビュー round 3 反映: 表記の `⏐⏐` (Unicode lookalike) を `||` に修正 (コピペ誤植防止)。 |

## 1. ゴール (DoD)

- ビューアタブで画像を開いたとき、オリジナル ([ReadImage](../app.go#L82)) が到着するまでの間、`thumb.Get(path, 1024, "letterbox")` の結果を `<img>` の src に流して表示する。
- プレビューがディスクキャッシュにヒットしていれば 1 frame 以内に絵が出る (典型: 一覧で一度ホバー / モーダルで一度開いた画像)。
- オリジナルが届いた時点で同じ `<img>` の src を差し替える (位置 / ズームは保たれる)。
- プレビュー取得に失敗してもオリジナル取得には影響しない (プレビュー失敗時は黙殺 + log のみ)。
- オリジナル取得が失敗した場合の表示はこれまで通り「読み込み失敗: <msg>」+ toast。
- 同一プレビューについて viewer / SampleModal が独立に呼んでも Go 側で 1 ジョブに合流する (既存の `thumb.pool` inflight dedup が効く)。
- ユニットテストはほぼ無し (副作用中心)。手動確認 (slow disk / cold cache / hot cache の 3 シナリオ) を Test plan に明示する。

## 2. 用語

| 用語 | 定義 |
|------|------|
| プレビュー (preview) | `thumb.Get(path, 1024, "letterbox")` が返す PNG/JPEG/GIF バイト列。ディスクキャッシュ前提で「速くて粗い」。 |
| オリジナル (original) | `imgread.Read(path)` が返す元画像バイト列。 |
| 寸法 | `imgread.ReadInfo(path)` が返す元画像の `Width` / `Height`。header decode のみで cheap。 |
| ホット | プレビュー / オリジナルのいずれかが OS ページキャッシュ or 自前ディスクキャッシュにある状態。 |
| コールド | どちらもキャッシュにない初回アクセス状態。 |

## 3. 現状の構造

### 3.1 関連ファイル

- [internal/thumb/thumb.go](../internal/thumb/thumb.go): `Get(path, size, mode)`。ディスクキャッシュ + worker pool dedup。
- [internal/imgread/imgread.go](../internal/imgread/imgread.go): `Read(path)` (全データ) / `ReadInfo(path)` (header だけ)。
- [app.go](../app.go#L73-L90): `GetThumbnail` / `ReadImage` / `GetImageInfo` を Wails binding 公開済み。
- [frontend/src/features/viewer-grid/ImageView.tsx](../frontend/src/features/viewer-grid/ImageView.tsx): `ReadImage` を呼んで `setImageData(res)` → `<img src>` に流す。ロード中は `<div className="image-view-loading">読み込み中…</div>`。
- [frontend/src/features/classification/SampleModal.tsx](../frontend/src/features/classification/SampleModal.tsx): `getPreview(imagePath)` (= `shared/utils/thumbnailDefaults.ts` のラッパ) でプレビューを取得。本 PR で同じラッパを ImageView でも使う構成にした。

### 3.2 既存キャッシュの再利用境界

`thumb.Get(path, 1024, "letterbox")` を viewer / modal の両方が呼ぶと:
- ディスクキャッシュキー: `cacheKey(path, mtime, size)` で path/mtime/size が同じなら同一キー → 同じディスクファイル参照 (再生成なし)。
- worker pool inflight dedup: 並行リクエストが 1 ジョブに合流 (二重デコードなし)。

つまり Go 側で何も変えなくても再利用は成立する。フロント側で 1024 px をリクエストするだけで済む。

## 4. 設計判断 (要点)

| ID | 論点 | 採用案 | 理由 / 棄却案 |
|----|------|-------|---------------|
| D-1 | プレビューを単一 `<img>` の src 差し替えで表示するか、別 `<img>` レイヤを overlay するか | **単一 `<img>` の src 差し替え** | overlay 案は z-index / transform 同期 / opacity 制御の追加コストが見合わない。`<img src>` を変えるだけで位置 / zoom は保持される (transform は React state なので src 変更で再計算されない) |
| D-2 | プレビューサイズ | **1024 (SampleModal と共通定数化)** | キャッシュ共有が成立 (D-1, AGENTS.md)。viewport > 1024 px ではボケるが「オリジナル到着までの一時表示」用途では許容 (= まさに「ボケてても何か映ってる」が issue の主旨) |
| D-3 | プレビュー / オリジナル / 寸法の発火タイミング | **3 つを並行 (Promise.all 風) 発火** | 順次発火だと preview のあとに original を開始することになり遅延が増える。並行発火なら各 IPC 経路が独立 (Go 側は別 goroutine) |
| D-4 | 寸法取得方法 (`tab.imageWidth/Height` を埋める手段) | **`GetImageInfo` を別 IPC で先行発火 (preview 表示前に必須)** | 寸法が無いと `<img>` の `width/height` style が決まらず初期 fit が走らない。preview の `<img onload>` 経由で取る案は「preview 画像のサイズ (= 1024 letterbox)」が見えるだけで「元画像の寸法」は取れず却下 |
| D-5 | プレビュー失敗時の挙動 | **黙殺 + log のみ。オリジナル待ち継続** | プレビュー失敗 (キャッシュ書き込みなし / decode error 等) は表示の劣化にとどめ、機能阻害しない |
| D-6 | オリジナル成功後にプレビューを `<img>` から差し替えるタイミング | **オリジナル受信 → 即 setImageData → React re-render で src 自動差し替え** | フェード transition なし (Phase 1)。差し替え時の 1 frame チラつきは現状 UX (loading text → image の遷移) と同等以下 |
| D-7 | プレビューとオリジナルの寸法不一致時の `<img>` style | **`<img>` の `width / height` style は常に元画像寸法 (`tab.imageWidth/Height`) を使う**。preview は src 側で letterbox の余白が入っているのでブラウザが scale で歪める | preview を「位置・サイズは正確で解像度だけ粗い」表現にできる。実画像の長辺基準 fit と一致 |
| D-8 | preview が letterbox の正方形余白を持つことの扱い | **余白部分は透過 PNG (WebP→PNG fallback 含む)** で問題なし。背景透過の元画像と同じ見え方になる | 既存仕様 (spec-thumbnail.md §3.5) で letterbox 余白は透過 |
| D-9 | preview を出すべきか判定する閾値 (small image なら skip) | **Phase 1 では一律出す**。閾値は将来 (Phase 2) | 閾値判定には先に `GetImageInfo` を await する必要があり、その分 preview 開始が遅れる。シンプルさ優先 |
| D-10 | preview 共通定数 + ラッパの置き場所 | **`frontend/src/shared/utils/thumbnailDefaults.ts` (新規)** に `PREVIEW_SIZE` / `PREVIEW_MODE` 定数 + **`getPreview(path)` TS ラッパ関数** を export。viewer / modal の両方が `getPreview(path)` を呼ぶ | AGENTS.md D-1 (同概念の定数が複数箇所にあるなら共通化)。`features/viewer-grid` ↔ `features/classification` の cross feature import を避けるため `shared/utils/` 配下。Go 側 binding は変えない (将来 viewer/modal で実装が分岐するなら Go 側ラッパに昇格させる) — レビュー反映 |
| D-11 | preview と original の race (preview のあとに original) | **常に「最新の `setImageData(original)`」が優先**。preview だけが届いた段階では `<img src>` は preview。original が後着で setImageData → React の reconciliation で src を上書き | 単一 useState (`imageData`) + 別 useState (`previewUrl`) の 2 state で表現。`src = imageData ? toDataURL(imageData) : previewUrl ?? ""` の memo |
| D-12 | original が **先に** 到着するケース (preview がディスクキャッシュにない + ReadImage が速い) | **preview の resolve 時点で imageData が既にあれば preview を捨てる (setPreviewUrl しない)** | 余計な src 差し替えを避ける。preview 結果は廃棄 (cancel ではなく resolve 後の早期 return) |
| D-13 | preview が `<img src>` に当たっている間の `tab.initialized` フラグ | **寸法 (`GetImageInfo` 完了) を受けて `tab.initialized = true` を立てる。preview / original どちらの到着でもよい** | 既存 `useEffect` (initial fit) は `tab.initialized` + `imageWidth/Height` をトリガとして動くので、寸法だけ揃えば fit が走り、その時点で preview src で表示開始できる |
| D-14 | 既存の "読み込み中…" テキスト | **`tab.initialized && (previewUrl || imageData)` が揃うまで表示し続ける**。揃った時点で `<img>` を出し、テキストは消える | 「寸法のみ + src 無し」で空 `<img>` を出すと alt 文字が一瞬出てチラつく。AND 成立を待つ方が UX として穏当 (実装も `hasContent` フラグ 1 つで済む) |
| D-15 | preview / GetImageInfo の失敗時の `tab.initialized` | **GetImageInfo 成功でのみ寸法が埋まる。`ReadImage` 成功時も寸法は埋まる**。両方失敗なら従来通り loadError surface | GetImageInfo は header だけ読むので壊れた画像でない限り通る。失敗するならどうせ ReadImage も失敗するはずなので extra error handling は不要 |
| D-16 | 既存の `ReadImage` の戻り `width/height` との関係 | **ReadImage の戻りの width/height は引き続き受け取って tab state 同期に使う**。GetImageInfo は寸法を早く知るための先行発火であり、ReadImage の戻りも同等の値を持つ (両方とも `imgread.decodeImageDimensions` 経由) | dup check ロジックは現状通り `tab.imageWidth !== res.width` の不一致時にだけ updateTabState |

## 5. データモデル / API

### 5.1 Go 側

**追加なし**。既存 binding をそのまま使う:
- `GetThumbnail(path, 1024, "letterbox")` — プレビュー
- `ReadImage(path)` — オリジナル
- `GetImageInfo(path)` — 寸法

### 5.2 フロント側

**新規 1 ファイル + ImageView.tsx 改修 + SampleModal.tsx 微修正**。

#### 5.2.1 `frontend/src/shared/utils/thumbnailDefaults.ts` (新規)

```ts
import { GetThumbnail } from "../../../wailsjs/go/main/App";
import type { thumb } from "../../../wailsjs/go/models";

// プレビュー用のサムネサイズ / モード。
//
// SampleModal とビューアの「オリジナル到着待ちプレビュー」が同じパラメータで
// GetThumbnail を呼ぶことで、Go 側のディスクキャッシュ + inflight dedup が
// 自然に効く (path/mtime/size/mode が同じならディスク上の同一ファイルを参照
// + 並行リクエストは 1 ジョブに合流)。
//
// AGENTS.md D-1: ハードコード fallback (`?? 1024`) は禁止、必ずこの定数 or
// getPreview() ラッパ経由で呼ぶ。
export const PREVIEW_SIZE = 1024;
export const PREVIEW_MODE = "letterbox";

// 「ビューア / モーダルの一時プレビュー」用ラッパ。GetThumbnail は本来
// 一覧グリッドの 256px サムネ用 API だが、本プロジェクトでは同じディスク
// キャッシュ機構を 1024px プレビューにも流用している (#97)。意味的には
// "thumbnail" ではなく "preview" なので、call site の意図を明示するため
// この関数を経由する。中身は GetThumbnail への薄い委譲。
export function getPreview(path: string): Promise<thumb.Result> {
  return GetThumbnail(path, PREVIEW_SIZE, PREVIEW_MODE);
}
```

#### 5.2.2 `ImageView.tsx` の改修ポイント

- 既存の `imageData: imgread.Result | null` state に加えて:
  - `previewUrl: string | null` (Blob URL)
  - `dimensions: { width: number; height: number } | null` (`GetImageInfo` 結果。`imageData` 到着時はそちらが優先)
- `useEffect([tab.path])` 内で **3 つを並行発火**:
  1. `GetImageInfo(tab.path)` → 寸法を dimensions に保存 → `tab.initialized` の前提を整える
  2. `getPreview(tab.path)` (= shared ラッパ) → Blob URL を `previewUrl` に保存 (`imageData` 既に届いていれば setPreviewUrl 抑止)
  3. `ReadImage(tab.path)` → 従来通り `imageData` に保存
- `<img>` の `src`:
  - `imageData` があれば `toDataURL(imageData.data, imageData.mimeType)` (オリジナル)
  - 無ければ `previewUrl ?? ""` (プレビュー or 空)
- `<img>` の `width/height`: 寸法 (`imageData?.width || dimensions?.width || tab.imageWidth`) を使う。優先順位は **imageData > dimensions > tab (session restore 後の初期値)** だが、normal flow では先行する `GetImageInfo` が必ず最初に dimensions を埋める
- 寸法が確定したら `tab.imageWidth/Height` を更新 (existing logic を流用)
- cleanup: cancelled フラグ + `previewUrl` の URL.revokeObjectURL

#### 5.2.3 `SampleModal.tsx` の修正

- ローカル定数 `PREVIEW_SIZE` / `PREVIEW_MODE` と `GetThumbnail` 直接呼び出しを削除し、`shared/utils/thumbnailDefaults.ts` の `getPreview(path)` ラッパに置換。
- 値は同じ (1024 / "letterbox") なので動作差分なし。

## 6. 制御フロー (シーケンス)

### 6.1 コールド (両方ともキャッシュなし、典型的な遅いストレージ)

```
t=0    useEffect → 並行発火: GetImageInfo / GetThumbnail / ReadImage
t=10ms GetImageInfo resolve → setDimensions → tab.initialized = true
                            → <img> がレンダリング開始 (src は "" or 旧プレビュー)
t=80ms GetThumbnail resolve (生成 + decode + encode 込み)
                            → setPreviewUrl(blob) → <img src> に preview がのる
t=2s   ReadImage resolve (大きい画像)
                            → setImageData(original) → <img src> が original に差し替わる
```

### 6.2 ホット (プレビューだけキャッシュ済み、オリジナルは初回)

```
t=0    並行発火
t=5ms  GetImageInfo / GetThumbnail がほぼ同時 resolve
                            → 1 frame 後には preview 表示開始
t=2s   ReadImage resolve → original に差し替え
```

### 6.3 オリジナルが先に到着 (small image or fast disk)

```
t=0    並行発火
t=10ms GetImageInfo / ReadImage がほぼ同時 resolve
                            → setImageData(original) → <img src> = original
t=80ms GetThumbnail resolve → imageData 既存 → setPreviewUrl 抑止 (Blob は revoke して破棄)
```

### 6.4 プレビュー失敗 / オリジナル成功

```
t=0    並行発火
t=10ms GetImageInfo resolve
t=80ms GetThumbnail reject → logger.warn のみ。setPreviewUrl しない
t=2s   ReadImage resolve → original 表示
```

### 6.5 オリジナル失敗

```
t=0    並行発火
t=80ms GetThumbnail resolve → setPreviewUrl(blob) → preview 表示
t=2s   ReadImage reject → setLoadError(msg) → エラーパネルに切替
                                              → previewUrl は revoke して破棄
```

エラーパネル中に preview を出し続ける選択肢もあるが、エラー時はユーザーに状況を明確に伝える方が優先 (= 旧来の挙動を尊重)。

## 7. AGENTS.md H-8 マトリクス (非同期 race 検証)

ImageView の 1 つの `useEffect([tab.path])` に 3 つの IPC を並行発火する。各経路の race 検証列:

| 経路 | cancelled check | imageData precedence | URL revoke on cleanup | tab.path change |
|------|:--:|:--:|:--:|:--:|
| GetImageInfo success | ✓ | – (寸法のみ) | – | ✓ (cancelled で setState 抑止) |
| GetImageInfo fail | ✓ | – | – | ✓ |
| GetThumbnail success | ✓ | **`imageData !== null` なら廃棄 (Blob revoke)** | ✓ (cleanup で revoke) | ✓ |
| GetThumbnail fail | ✓ | – (logger.warn のみ) | – | ✓ |
| ReadImage success | ✓ | – (常に上書き) | – | ✓ |
| ReadImage fail | ✓ | – (loadError set) | – | ✓ |

**imageData precedence**: preview resolve 時に既に imageData があれば preview を捨てる。これは「original 先着 → preview 後着」の race。

**URL revoke on cleanup**: previewUrl は Blob URL なので `useEffect` cleanup で必ず `URL.revokeObjectURL`。useState ではなく useRef + cleanup ベースで管理する手もあるが、`previewUrl` を `<img src>` に渡す都合 useState の方が React の再描画に乗せやすい。

「pending gen check」「mode entry/post-await」のような複雑な generation 管理は不要 (この `useEffect` はタブパス単位で完結し、外から `setLoadResult` のような別経路の commit を受けない)。

## 8. テスト方針

### 8.1 自動テスト

純関数追加なし。`ImageView.tsx` 内の race 制御は副作用中心のため vitest 化が難しい (DOM テスト未導入、CLAUDE.md / context.md §5)。

### 8.2 手動確認 (PR test plan に明記)

1. **コールド**: 一覧で未ホバーの画像をタブで開く。**寸法 → preview → original** の順で表示が遷移する (preview は粗いが何か映る)。
2. **ホット (preview のみ)**: 一覧でホバーして preview をキャッシュさせた画像を、タブで開く。`<img>` が即出る (preview)、しばらくして original に差し替わる。
3. **ホット (両方)**: 一度開いたタブを閉じて再度開く。OS ページキャッシュ込みで original も速いはず → preview がほぼ見えず original 表示。
4. **オリジナル失敗 (壊れた画像)**: 既存テスト fixture (壊れた jpeg 等) でエラーパネル表示。preview が一時的に出る挙動は許容、最終的にエラーが surface。
5. **プレビュー失敗 (= キャッシュ書き込み権限なし or decode error)**: `chmod 000 <cacheRoot>` で疑似的に再現。preview は出ないが original はそのまま表示。
6. **同一画像を modal と viewer で開く**: 一覧から SampleModal を出した後、同じ画像を viewer で開く。`thumb.pool` の inflight dedup でログに「重複生成なし」が見える (要 `logger.debug` 確認、Phase 1 では log は出さない)。
7. **タブ切替中の path 変更**: 大きい画像のロード中に別画像のタブに切り替え。旧タブ用の preview / original が新タブに leak しない (cancelled フラグ動作確認)。

## 9. 決定事項 (Phase 1)

- プレビューは `GetThumbnail(path, 1024, "letterbox")` を流用 (SampleModal と共通)
- 呼び出しは `shared/utils/thumbnailDefaults.ts` の **`getPreview(path)` TS ラッパ経由** で行い、call site から「サムネ」名称を消す
- `<img>` 単一を src 差し替えで運用 (overlay なし、transition なし)
- `GetImageInfo` を別経路で先行発火し寸法だけ早く確定させる (preview 表示開始の前提)
- preview 失敗は黙殺、original 失敗のみ surface (loadError)
- 共通定数 `PREVIEW_SIZE` / `PREVIEW_MODE` + ラッパ `getPreview` を `shared/utils/thumbnailDefaults.ts` に置き、viewer / modal の両方が import
- preview の skip threshold (small image) は Phase 1 で入れない
- fade transition は Phase 1 で入れない
- 自動テストは追加せず、手動確認 7 項目を PR test plan に明示

## 10. 確定済み論点 (レビュー反映 2026-05-27)

着手前にユーザーレビューを受け、以下で確定:

1. **D-9 (preview skip threshold)**: **入れない**。`GetImageInfo` の await を待たずに preview を発火する単純設計を維持。small + fast disk のケースは D-12 の race (original 先着 → preview 破棄) で自然に preview なしになる。
2. **D-10 (共通定数 + ラッパの置き場所)**: **`shared/utils/thumbnailDefaults.ts` に `PREVIEW_SIZE` / `PREVIEW_MODE` + `getPreview(path)` ラッパ**。call site から「サムネ」名称を消し、意図 (= viewer / modal の一時プレビュー) を明示。Go 側 binding は変更しない (`thumb.pool` の dedup は引数同一性で効くのでラッパでも効く)。
3. **D-6 (transition)**: **入れない**。1 frame の瞬間置換 (`<img>` の width/height が常に元画像寸法 = D-7 なので位置 / サイズはズレない)。
4. **D-15 (preview を出さない場合の挙動)**: **`<img>` を出すのは `tab.initialized && (previewUrl || imageData)` が揃った時のみ。揃わない間は "読み込み中…" を表示し続ける** (= D-14 と整合)。空 `<img>` を一瞬出す挙動 (初案) は採用していない — そちらだと alt 文字が瞬間的に出てチラつくため。
5. **Phase 2 候補**: 今回は Phase 1 のみ実装。Phase 2 用の issue 起票は使ってみて判断する (skip threshold / fade transition / viewer 横断メモリキャッシュ等)。

## 11. Out of scope (Phase 1 では作らない)

- preview / original の placeholder としての CSS animation (skeleton 等)
- viewer 横断のプレビューメモリキャッシュ (タブ閉じ → 再オープン時の即時表示)
- preview を出すかどうかの設定 UI (always on / off / auto)
- preview のサイズをユーザー設定で変える機能
- preview / original の同時表示 (overlay) + transition

## 12. Phase 分割

| Phase | 範囲 | 着手条件 |
|-------|------|---------|
| **Phase 1** | 本仕様の §1〜§9 | ユーザー合意 |
| Phase 2 | §11 の検討 (使ってみての要望ベース) | 必要が出た時に別 issue を起票 |

## 13. 関連

- 元 issue: [#97](https://github.com/maretol/image-observer/issues/97)
- 参考: [spec-thumbnail.md](spec-thumbnail.md) (キャッシュ仕様)、[spec-tab-imageview-3a.md](spec-tab-imageview-3a.md) (ReadImage / 元画像表示)、[spec-sample-modal-edit.md](spec-sample-modal-edit.md) (preview を使う既存箇所)
- AGENTS.md 該当節: D-1 (定数共通化)、H-2 (新規 onPointerDown 等は今回追加しない)、H-7 (波及確認)、H-8 (race 検証マトリクス §7)
