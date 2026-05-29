# ビューアタブ間プレビューキャッシュ 実装仕様書 (#106)

> **ステータス**: ドラフト。§4 / §5 / §10 の決定事項をユーザー合意後に着手。

ビューアでタブ切替を行うと、`<ImageView key={activeTab.path} />` の unmount → remount が走り、in-memory の `imageData` / `previewUrl` がリセットされて「読み込み中…」が一瞬出る。一度開いた画像であってもこの間 blank が見える (issue #106)。本仕様では **viewer 横断のモジュールスコープな preview Blob URL キャッシュ層** を追加し、タブ切替直後でも過去に取得済みの 1024px プレビューを即時表示することで、blank を解消する。

オリジナル (`ReadImage`) は引き続き fresh load し、到着次第 `<img src>` を差し替える (= 既存挙動の維持)。ファイル更新による preview の鮮度不一致は、オリジナル swap が最終的に上書きする経路で吸収する。

## 改訂履歴

| 日付 | 改訂 |
|------|------|
| 2026-05-29 | 初版 (ユーザーレビュー待ち) |

## 1. ゴール (DoD)

- ビューアで一度開いたタブを別タブから戻ってきたとき、`<img>` 要素が **同期的に preview Blob URL で描画** され、「読み込み中…」が出ない。
- preview Blob URL は **viewer 横断のモジュールスコープ Map** で保持し、最大 16 件 (固定) を LRU で管理する。
- 16 件を超えたら最も古いエントリを evict し、その時点で対応する Blob URL を `URL.revokeObjectURL` する。
- タブを閉じても cache から **明示削除しない** (LRU evict に任せる) — 誤クリック復元 / 同一画像の再オープンで cache を再利用するため。
- オリジナル取得は cache hit / miss に関わらず引き続き走る。到着すれば `<img src>` をオリジナルに差し替える (既存挙動)。
- `getPreview` IPC は cache hit 時はスキップ (重複 IPC を避ける)。cache miss 時のみ発火し、成功すれば cache に保存する。
- メモリリークなし: モジュールスコープ Map に登録された Blob URL の revoke 責任は **cache 側だけが負う** (ImageView 側で revoke しない)。
- 純関数として LRU の動作を vitest でユニットテストする (add / get / overflow evict / 同 path 上書き)。
- 手動確認: タブ A → B → A 戻り時に blank フレームが出ない / 16 タブ超えで evict 動作 / ReadImage 失敗時のエラーパネル surface (既存挙動と整合)。

## 2. 用語

| 用語 | 定義 |
|------|------|
| preview cache | 本仕様で導入する viewer 横断のモジュールスコープ Map (`path` → Blob URL)。LRU 16 件。 |
| Blob URL | `URL.createObjectURL(new Blob([bytes], { type }))` が返す `blob:` プロトコルの URL 文字列。`URL.revokeObjectURL` で解放するまで Blob の参照が維持される。 |
| hit | `getCachedPreview(path)` が non-null を返す状態 (= 当該 path の Blob URL が cache に登録済み)。 |
| miss | `getCachedPreview(path)` が null を返す状態。 |
| evict | LRU 上限超過で最も古いエントリを削除し、その Blob URL を revoke する操作。 |

## 3. 現状の構造

### 3.1 関連ファイル

- [frontend/src/features/viewer-grid/Panel.tsx](../frontend/src/features/viewer-grid/Panel.tsx#L70): `<ImageView key={activeTab.path} ... />` でタブ切替時に ImageView を remount している。
- [frontend/src/features/viewer-grid/ImageView.tsx](../frontend/src/features/viewer-grid/ImageView.tsx): `useEffect([tab.path])` で 3 並列 IPC (`GetImageInfo` / `getPreview` / `ReadImage`) を発火。`createdPreviewUrl` を local 変数として持ち、`releasePreview()` / cleanup で revoke している (= 「自分が作った Blob は自分が解放する」モデル)。
- [frontend/src/shared/utils/thumbnailDefaults.ts](../frontend/src/shared/utils/thumbnailDefaults.ts): `PREVIEW_SIZE` (1024) / `PREVIEW_MODE` ("letterbox") + `getPreview(path)` ラッパ。

### 3.2 現状フロー (タブ切替時に blank が見える理由)

```
タブ A 表示中: ImageView(key="A") mount 済み、imageData_A 描画中
       ↓ ユーザーがタブ B をクリック
Panel が <ImageView key="B" .../> に切り替え
       ↓ React reconciler
ImageView(key="A") unmount → cleanup で Blob revoke
ImageView(key="B") mount    → state 初期値 (imageData=null, previewUrl=null) → hasContent=false → "読み込み中…"
       ↓ useEffect([tab.path]) 発火
3 並列 IPC: GetImageInfo, getPreview, ReadImage
       ↓ 最速で preview が返る (~数十 ms with disk cache hit)
setPreviewUrl(blob) → hasContent=true → <img> 描画開始
```

この「最速 preview 到着までの数十 ms 〜 数 frame」がユーザーに見える blank の正体。

## 4. 設計判断 (要点)

| ID | 論点 | 採用案 | 理由 / 棄却案 |
|----|------|-------|---------------|
| D-1 | キャッシュする対象 | **preview Blob URL のみ** (1024px PNG) | オリジナルもキャッシュする案は per-entry 数 MB〜数十 MB のメモリ消費になり、16 枚 LRU でも数百 MB に達しうる。preview のみなら 1 件 数百 KB に収まる。issue #106 の本質は「blank フレームを無くす」ことなので preview だけで満たせる。Phase 2 で imageData 拡張を検討する余地は残す |
| D-2 | キャッシュ単位 | **viewer 横断のモジュールスコープ Map** | viewer 間で同じ path を開くケース (`onMoveTabToViewer` 等) は十分ありえる。viewer per-instance だと共有が効かない。モジュールスコープ Map は AGENTS.md H-3 の「リーク防御」が必要だが、LRU の固定上限 + evict 時 revoke の責任分離で対応する |
| D-3 | LRU 上限 | **固定 16 (定数 export)** | max panels (16) と揃える。設定 UI で可変化する案 (Phase 2 候補) は、デフォルト固定で十分体感改善するため Phase 1 は単純化 |
| D-4 | タブ閉じ時の扱い | **cache から削除しない (LRU 任せ)** | 誤クリック復元 (再オープン) で cache hit させたい / 明示削除は close UX (タブ閉じる ≠ 画像を破棄したい) との矛盾。LRU で自然に押し出される |
| D-5 | `Panel.tsx` の `key={activeTab.path}` | **維持する** | key を外して ImageView を 1 instance にする案は、useEffect / zoom command bus / pointer drag ref / ResizeObserver 等の lifecycle が複雑化する。key 維持 + mount 時に cache から hydrate する方が変更範囲が小さい (ImageView 内の 1 useEffect のみ改修) |
| D-6 | cache hit 時の `getPreview` IPC | **スキップ** | cache hit 時は既に Blob URL を持っているので IPC を走らせる意味がない。preview の mtime drift は、後着の ReadImage が新オリジナルを取得して `<img src>` を上書きする経路で吸収する |
| D-7 | cache hit 時の `GetImageInfo` / `ReadImage` IPC | **常に走らせる (= 既存挙動)** | 寸法 / オリジナル本体は cache していないので fresh load 必須。ReadImage 成功で <img src> が cache の preview から original へ swap される |
| D-8 | mtime ベースの invalidation | **入れない (Phase 1)** | フロント側に mtime 取得経路がない (`imgread.Info` / `thumb.Result` に mtime フィールドなし)。新たに Go IPC を追加すれば可能だが、ReadImage swap で最終的に上書きされるので Phase 1 では不要。preview が古いまま見える窓は ReadImage 完了までの数百 ms〜数秒で、ユーザー体感では blank が無くなるメリットが上回る |
| D-9 | Blob URL の revoke 責任 | **cache 側のみが負う** (ImageView 側は revoke しない) | 二重所有を避ける。ImageView の cleanup で revoke すると、cache に登録済みの Blob URL が無効化されて他タブから再利用時に表示崩壊する。LRU evict 時 / `evictPreview(path)` 明示呼び出し時のみ revoke |
| D-10 | cache 登録前の Blob (= `getPreview` 成功直後、`setCachedPreview` を呼ぶ前) の orphan 防止 | **`getPreview.then` 内で `cancelled || originalSettled` を最初にチェックし、true なら `URL.createObjectURL` を呼ばない (現状コード踏襲)** | 既存実装 [ImageView.tsx:126-133](../frontend/src/features/viewer-grid/ImageView.tsx#L126-L133) と同じパターン。これにより「Blob URL を作ったが cache にも `<img>` にも渡らない」状態を起こさない |
| D-11 | `originalSettled` 後の cache 動作 | **cache には preview を保存する** (original 表示中でも cache は維持) | original 表示中に同じタブを再オープン (タブ閉じ → 再オープン) するケースで cache hit させるため。「original 表示中だから preview cache は不要」と判断すると後続の利得を失う |
| D-12 | cache 同一 path の重複保存時 (例: 何らかの理由で同じ path の getPreview が二重に成功した) | **既存エントリを LRU の先頭に移動するのみ。新 Blob URL は捨てる (= cache の Blob URL を引き続き使う)** | 同じ path から同じ getPreview で取れる Blob は内容同一なので新規 Blob は redundant。古い Blob を revoke して新規を入れる案は <img> 再描画が走るので捨てる方を採用 |
| D-13 | mount 時の cache lookup の同期性 | **`useState(initialValue)` の lazy initializer で cache から hydrate して同期初期化** | mount 直後の最初の render で `<img src>` を出すには `useEffect` (= commit 後) より先に state が埋まっている必要がある。`useState(() => getCachedPreview(tab.path))` で lazy initializer に乗せれば一度の render で hasContent=true から始められる |
| D-14 | `getCachedPreview(path)` の戻り Blob URL を `<img src>` に渡したまま、別経路で同じ Blob URL が revoke されないことの保証 | **LRU が「現在 N 件未満なら evict は起きない」性質 + `setCachedPreview` 時の重複チェック (D-12) で「呼び出し側が表示中の Blob URL が突然 revoke される」状況は発生しない**。ただし「タブ 16 個開いていて 17 個目を開く瞬間に LRU evict が走る」ケースは存在しうる: その際、evict 対象の Blob URL が「別 ImageView 側で `<img src>` にまだバインド中」の可能性がある。これは D-15 で扱う | — |
| D-15 | LRU evict 対象が他 `<img>` に bind 中の場合の表示崩壊リスク | **revoke は遅延実行 (`setTimeout(..., PREVIEW_REVOKE_DELAY_MS)`)** で吸収。既存定数 `PREVIEW_REVOKE_DELAY_MS = 100ms` (ImageView.tsx) を再利用する。100ms 内に「全 `<img>` が src を取り終わって描画 commit する」を期待する。ブラウザ実装上、`<img src="blob:...">` は src 属性に Blob URL を代入すると即座に内部参照を増やす (revoke しても描画継続) ため、100ms あれば十分余裕 | — |
| D-16 | preview Blob URL を保持中の `evictPreview(path)` 明示呼び出し経路 | **Phase 1 では入れない** | ファイル削除 (`DeleteImage`) 時の明示 evict は理にかなうが、現状の DeleteImage 経路は一覧タブの Card 右クリックのみで viewer タブからは呼ばれない (viewer 内で削除 UI なし)。「viewer に開いているタブが一覧から削除される」と "ファイルがありません" エラーで ReadImage が失敗するが、preview cache に残った 1024px PNG は LRU で押し出されるまでメモリに残る (最大 数百 KB × 16 = 数 MB)。Phase 2 で必要性を再評価 |
| D-17 | watcher (folder-watch #19) 連携 | **Phase 1 では入れない** | 現状の watcher は classification sidecar 専用で画像ファイル更新通知はしない。画像ファイル更新は ReadImage swap で吸収 (D-8 と同じ理屈) |
| D-18 | cache の test 用 reset | **`__resetPreviewCacheForTests()` を export** (vitest 用) | LRU の状態が test 間で leak しないように。`__` プレフィックスで「test only」を明示。本番コードから呼ばれない |

## 5. データモデル / API

### 5.1 Go 側

**追加なし**。

### 5.2 フロント側

#### 5.2.1 `frontend/src/features/viewer-grid/previewCache.ts` (新規)

モジュールスコープの LRU Map + Blob URL の所有権管理。

```ts
// preview Blob URL の viewer 横断 LRU キャッシュ (#106)。
//
// AGENTS.md H-3 (グローバル / モジュール state のリーク) 対応:
// - 上限超過時に必ず evict + revoke する (capacity overflow を放置しない)
// - 同 path 再登録時は新 Blob を捨てて既存を保持する (revoke 二重を避ける)
// - test 用に __resetPreviewCacheForTests() を export
//
// JS の Map は insertion order を保持するため、LRU "touch on access" は
// delete + set で表現できる (= 容量超過時の eviction も「先頭」=「最も古い」
// を渡せば良い)。

// LRU 上限。max panels (16) と揃える。
// AGENTS.md D-1 (定数共有): ImageView 等から import して使う。
export const PREVIEW_CACHE_CAPACITY = 16;

// Blob URL の revoke を遅延する ms。既存 ImageView の
// PREVIEW_REVOKE_DELAY_MS と同値 (D-1: 同概念の定数が分散しないよう
// shared 化する選択肢もあるが、Phase 1 では module 内に定義し、
// ImageView 側が import する形にして単一定義化する)。
//
// (実際の値定義は ImageView 側で既に存在するため、Phase 1 では同値を
// shared utility に移送して両側が import する形にする。詳細は §5.2.3)

type CacheEntry = {
  url: string;        // Blob URL ("blob:...")
};

const cache = new Map<string, CacheEntry>();

// hit なら URL を返す + entry を LRU の最新位置に touch する。miss なら null。
export function getCachedPreview(path: string): string | null {
  const e = cache.get(path);
  if (!e) return null;
  // touch: delete + set で insertion order 末尾に移動
  cache.delete(path);
  cache.set(path, e);
  return e.url;
}

// path → url を cache に登録する。
// - 同 path 既存: 新 url は捨てて既存を保持する (D-12)。
//   (呼び出し側は「捨てられた url を revoke する責任」を持つ — D-9 / D-10)
//   戻り値は「cache が引き継いだか」を示す boolean。false なら呼び出し側が
//   revoke を行う。
// - capacity 超過: 最も古いエントリを evict (delete + revoke 遅延)。
//
// 戻り値: true = cache が url を引き取った / false = 既存があり url は引き取らない
export function setCachedPreview(path: string, url: string): boolean {
  const existing = cache.get(path);
  if (existing) {
    // 既存を最新位置に touch、新 url は捨てる
    cache.delete(path);
    cache.set(path, existing);
    return false;
  }
  cache.set(path, { url });
  if (cache.size > PREVIEW_CACHE_CAPACITY) {
    evictOldest();
  }
  return true;
}

// 明示 evict (Phase 1 では呼び出し経路なし、test 用 + 将来用)。
export function evictPreview(path: string): void {
  const e = cache.get(path);
  if (!e) return;
  cache.delete(path);
  scheduleRevoke(e.url);
}

function evictOldest(): void {
  // Map iteration は insertion order = 最も古いものが最初に出る
  const first = cache.keys().next();
  if (first.done) return;
  const oldestPath = first.value;
  const e = cache.get(oldestPath)!;
  cache.delete(oldestPath);
  scheduleRevoke(e.url);
}

// revoke を遅延実行する (D-15: <img> がまだ参照中の可能性)。
function scheduleRevoke(url: string): void {
  setTimeout(() => URL.revokeObjectURL(url), PREVIEW_REVOKE_DELAY_MS);
}

// test 用 reset (D-18)。
export function __resetPreviewCacheForTests(): void {
  for (const [, e] of cache) {
    URL.revokeObjectURL(e.url);
  }
  cache.clear();
}
```

#### 5.2.2 `ImageView.tsx` の改修ポイント

- `useState(previewUrl)` を **lazy initializer** で cache hit 初期化:
  ```tsx
  const [previewUrl, setPreviewUrl] = useState<string | null>(
    () => getCachedPreview(tab.path),
  );
  ```
  これにより mount 直後の最初の render で `previewUrl` が non-null、`hasContent` の preview 側条件が満たされ、初回コミットで `<img>` が描画される。
- `useEffect([tab.path])` の冒頭にあった `setPreviewUrl(null)` は削除 (cache hit を初期値で活かすため)。代わりに `setImageData(null)` と `setLoadError(null)` のリセットは残す。
- `getPreview(tab.path)` の発火は **cache hit 時にスキップ** する:
  ```tsx
  const hadCacheHit = previewUrl !== null; // mount 時点での lazy init 結果
  if (!hadCacheHit) {
    getPreview(tab.path).then((res) => {
      if (cancelled || originalSettled) return;
      const blob = new Blob([toBytes(res.data)], { type: res.mimeType });
      const url = URL.createObjectURL(blob);
      const adopted = setCachedPreview(tab.path, url);
      if (!adopted) {
        // 重複登録: 新 url は捨てて、cache の既存 url を使う
        scheduleRevokeLocal(url);
        const cached = getCachedPreview(tab.path);
        if (cached) setPreviewUrl(cached);
        return;
      }
      setPreviewUrl(url);
    }).catch((e) => {
      if (cancelled) return;
      logger.warn("viewer-grid", "preview load failed", { path: tab.path, err: errorMessage(e) });
    });
  }
  ```
  `hadCacheHit` は useEffect 内のローカル定数として確定させる (useEffect 開始時に previewUrl !== null を 1 回だけ評価)。
- `releasePreview()` の Blob 解放は **削除する** (cache が責任を持つ)。具体的には:
  - `createdPreviewUrl` ローカル変数は廃止。
  - `releasePreview()` は `setPreviewUrl(null)` のみ呼ぶシンプルな関数に縮小、もしくは関数自体を廃止して inline 化。
  - `originalSettled` 後の preview src 非表示は React の src precedence (`if (imageData) src = original`) で自動的に行われるので、`setPreviewUrl(null)` も不要 (= `previewUrl` の state は残したまま src が original を選ぶ)。
- useEffect cleanup の Blob revoke 処理 (`setTimeout(URL.revokeObjectURL...)`) を削除。`cancelled = true` のみに縮小。
- `__resetPreviewCacheForTests` を直接 import しない (test only)。

#### 5.2.3 共通定数の shared 化

既存 `ImageView.tsx` の `PREVIEW_REVOKE_DELAY_MS = 100` を `previewCache.ts` でも参照したい (= 2 箇所に同じリテラルが分散すると AGENTS.md D-1 違反)。本 spec では:

- `frontend/src/shared/utils/thumbnailDefaults.ts` に `PREVIEW_REVOKE_DELAY_MS = 100` を移送 + export 追加。
- `ImageView.tsx` / `previewCache.ts` の両方が import する。

これで 1 箇所定義の原則を維持する。

## 6. 制御フロー

### 6.1 タブ切替 (cache hit — 戻ってきたタブ)

```
t=0    Panel が <ImageView key="A" /> から <ImageView key="B" /> に rerender
       (B は過去に開いていて preview cache に Blob URL 保持済み)
ImageView(key="B") unmount → cleanup (cancelled=true のみ、cache に手出ししない)
ImageView(key="A") (旧) は cache に preview を保持済み (D-11)
ImageView(key="B") mount
       useState(() => getCachedPreview("B")) → "blob:xxxx" 取得 (cache touch も自動)
       初回 render → previewUrl != null → hasContent (寸法はまだ 0 だが、tab.initialized & dims > 0 を満たすため
                                          ReadImage / GetImageInfo の到着まで待つ ※下記注)
       ↓
useEffect([tab.path]) 発火
       hadCacheHit = true → getPreview IPC スキップ
       GetImageInfo IPC 発火、ReadImage IPC 発火
t=10ms GetImageInfo 完了 → tab.imageWidth/Height 更新 → hasContent=true → <img src=preview> 描画
                                                       (この時点で blank → preview の遷移完了)
t=2s   ReadImage 完了 → setImageData(original) → <img src=original> swap
```

**注 (重要)**: 現行の `hasContent` 条件は `tab.initialized && tab.imageWidth > 0 && tab.imageHeight > 0 && (previewUrl || imageData)` ([ImageView.tsx:500-504](../frontend/src/features/viewer-grid/ImageView.tsx#L500-L504))。タブ切替で remount された新 instance は **tab.imageWidth/Height = 0** から始まる (Tab 型のデフォルト) ため、cache hit で previewUrl が埋まっていても `hasContent=false` になり「読み込み中…」が出る。

これを解決する選択肢:

**選択肢 A (推奨)**: タブの zoom/pan/dimensions を `Tab` 型に永続化する (現状は LayoutNodeState.tabs に zoom/pan は保存されるが imageWidth/Height は保存されない、状態セッション復元時に 0 から始まる挙動と同じ)。タブ切替時にも imageWidth/Height が 0 にリセットされるのは Panel 経由の remount で `activeTab` が leaf.tabs の state を引き継ぐので、`leaf.tabs` 側で imageWidth/Height を保持していれば 0 にならない。**実装上は `useViewerSet` / 関連 hook で `onUpdateTabState` がすでに imageWidth/Height を patch しているか確認 → 保存済みなら問題なし、未保存ならそこも修正する**。

**選択肢 B (補助)**: `hasContent` の判定で「previewUrl が cache hit で初期化された場合は dimensions=0 でも待たずに `<img>` を出す」。ただし `<img width=0 height=0>` は描画されず、CSS で表示しても 0×0 のため意味なし。寸法到着まで待つ方が結局 UX 上正しい。

**結論**: 選択肢 A を採用。`leaf.tabs[i].imageWidth/Height` は `onUpdateTabState` の patch で更新済み → タブ切替で別タブにアクティブが移っても `leaf.tabs` 上の各 Tab object が dimensions を保持し続けるはず。Panel の `activeTab` は `leaf.tabs[leaf.activeIndex]` で取り出すので、戻ってきたタブも dimensions を保持している = `tab.imageWidth/Height > 0` が満たされる (= remount でも initial state が 0 ではなく、Tab object が持っている値)。

**実装時に検証**: `useViewerSet` 内の Tab object lifecycle を読んで、タブ切替前後で `imageWidth/Height` が保持されることを確認する。保持されていなければ既存実装の方を修正する (= preview cache が効くための前提として必須)。

### 6.2 タブ切替 (cache miss — 初めて開くタブ)

```
t=0    ImageView(key="C") mount
       useState(() => getCachedPreview("C")) → null
       初回 render → previewUrl=null, imageData=null → hasContent=false → "読み込み中…"
       ↓
useEffect 発火
       hadCacheHit = false → 3 並列 IPC (GetImageInfo / getPreview / ReadImage)
t=10ms GetImageInfo → tab.imageWidth/Height 更新
t=80ms getPreview 成功 → setCachedPreview("C", url) → adopted=true → setPreviewUrl(url)
                                                   → hasContent=true → <img src=preview>
t=2s   ReadImage → setImageData → <img src=original>
```

= 既存の Phase 1 (#97) の挙動とほぼ同じ。差分は「cache に保存」する一行のみ。

### 6.3 LRU 上限超過 (cache がいっぱいで 17 個目を開く)

```
cache.size = 16 (満杯)
ユーザーがタブ "Q" を新規オープン (Q は cache にない)
       ↓
useEffect → getPreview → setCachedPreview("Q", url_q)
       cache.set("Q", { url: url_q }) → size=17
       evictOldest() → 最も古い path "A" を delete + scheduleRevoke(url_a)
       100ms 後: URL.revokeObjectURL(url_a)
```

100ms の遅延中に「A タブが他の Panel で表示中」のケース: その Panel の `<img src=url_a>` は src 属性に Blob URL を代入した時点でブラウザ内部参照を持っているので、URL.revokeObjectURL 後も既存の表示は維持される (注: 新しい `<img>` に同じ url を渡すと表示失敗する。これは新規 mount で cache miss → fresh getPreview で別 Blob URL が生成されるので問題なし)。

### 6.4 同一 path の再登録 (race)

```
タブ A (path="P") が remount 1 回目 → cache miss → getPreview → adopted=true → cache に "P" 登録
タブ A unmount (タブ閉じ or 別タブへ)
タブ A 即再オープン (path="P") → remount 2 回目 → cache hit → setPreviewUrl(cached) → IPC スキップ
```

問題なし。

別ケース:

```
タブ A path="P" remount 1 回目 → cache miss → getPreview 発火 (in-flight)
タブ A unmount → cancelled=true (IPC 結果は捨てる)
タブ A 即再オープン (= remount 2 回目) → cache miss (まだ前の IPC が完了していない) → getPreview 2 回目発火
1 回目の IPC 完了 → cancelled=true なので破棄
2 回目の IPC 完了 → setCachedPreview → adopted=true → setPreviewUrl
```

これも問題なし (重複 Blob は生成されない)。

別ケース (2 viewer で同 path を同時に開く):

```
Viewer1 タブ P mount → cache miss → getPreview 発火 (in-flight)
Viewer2 タブ P mount → cache miss (まだ Viewer1 の IPC が完了していない) → getPreview 発火 (in-flight)
Viewer1 の IPC 完了先着 → setCachedPreview("P", url1) → adopted=true → cache 登録 + setPreviewUrl(url1)
Viewer2 の IPC 完了後着 → setCachedPreview("P", url2) → adopted=false (既存あり) →
                            scheduleRevokeLocal(url2) (捨てる) + getCachedPreview("P") → url1 → setPreviewUrl(url1)
```

D-12 の挙動が効く。Viewer2 の <img src> が url1 になるので Viewer1 と一致。

## 7. AGENTS.md H-8 マトリクス (非同期 race 検証)

`previewCache` 自体は同期 API なので race は ImageView 側の useEffect に集約。既存 spec-low-res-preview §7 のマトリクスを継承しつつ、cache 連携で増える列は「cache adoption」のみ。

| 経路 | cancelled check | imageData precedence | URL revoke | tab.path change | cache adoption |
|------|:--:|:--:|:--:|:--:|:--:|
| GetImageInfo success | ✓ | – | – | ✓ | – |
| GetImageInfo fail | ✓ | – | – | ✓ | – |
| getPreview success (cache miss) | ✓ | imageData !== null なら createObjectURL せずに早期 return (D-10 既存挙動踏襲) | cache 側 (D-9) | ✓ | setCachedPreview, adopted=false なら local revoke |
| getPreview fail (cache miss) | ✓ | – | – | ✓ | – |
| getPreview スキップ (cache hit) | – | – | – | – | – |
| ReadImage success | ✓ | – (常に上書き) | – | ✓ | – (cache の preview はそのまま残す) |
| ReadImage fail | ✓ | – (loadError set) | – | ✓ | – (cache の preview はそのまま残す) |

- **cache adoption**: `setCachedPreview` の戻り値 `adopted` が false の場合 (= 既に同 path が cache にある)、呼び出し側が手元の Blob URL を revoke する責任を持つ。これを忘れると orphan Blob のリーク。
- **cancelled & adoption の race**: `cancelled = true` の後で getPreview .then が実行された場合は早期 return で `URL.createObjectURL` 自体を呼ばない (既存挙動踏襲)。adopted false の local revoke 経路に到達する前に cancelled で抜けるので、local revoke の orphan は発生しない。
- **二重 cleanup**: ImageView remount 連打で同一 path の useEffect が重なるケース、各 useEffect は独立した `cancelled` クロージャを持つので互いに干渉しない。setCachedPreview は同 path 重複時に adopted=false を返すので、後着の Blob は捨てられる。

「pending gen check」「mode entry/post-await」「intent reconcile」のような複雑な generation 管理は本仕様では不要 (useEffect は path 単位で完結し、外部から先取り commit を受けない。cache が外部 commit 経路に該当しうるが、同期 API なので race にはならない)。

## 8. テスト方針

### 8.1 自動テスト (vitest)

`frontend/src/features/viewer-grid/previewCache.test.ts` を新規作成。純関数テスト中心:

1. `setCachedPreview` + `getCachedPreview` の往復 (touch order を検証するため connection order を確認)
2. 同 path 重複登録時に `adopted=false` が返り cache の url は変わらない
3. capacity 超過時 (`PREVIEW_CACHE_CAPACITY + 1` 件登録) で最も古い entry が evict されその url の revoke が予約される
4. `evictPreview(path)` で対象 url の revoke が予約される + cache size 減
5. `__resetPreviewCacheForTests` で cache が空になる
6. `getCachedPreview` が touch (LRU 順序更新) する: 古いものを get → 再度 capacity 超過で「直前 touch したのではなく次に古いもの」が evict される

`URL.createObjectURL` / `URL.revokeObjectURL` は jsdom / happy-dom 未導入なので vitest setup でモック化する (`globalThis.URL = { revokeObjectURL: vi.fn(), createObjectURL: vi.fn(() => "blob:test") }`)。`setTimeout` は `vi.useFakeTimers()` で advance する。

### 8.2 手動確認 (PR test plan に明記)

1. **タブ切替 hit**: 同一 viewer 内でタブ A → B → A を切り替え、「読み込み中…」が **一切表示されない** (preview が即出る)。
2. **タブ切替 miss**: 新規タブを開いた直後は「読み込み中…」が短時間表示される (既存挙動)。
3. **タブ閉じ → 再オープン**: タブ A を閉じて同じ画像を再オープン、preview cache hit で blank が無い。
4. **17 個目のタブ**: 既に 16 タブ開いている状態で 17 個目を開く → 最も古いタブの cache が evict (≒ 17 個目を作って 18 個目を開くと最古が evict される)。同タブを後から開き直すと cache miss で IPC 走る。
5. **viewer 横断 hit**: Viewer1 で開いていたタブを Viewer2 にコンテキストメニューで移動 (`onMoveTabToViewer`)、Viewer2 側で blank が無い。
6. **オリジナル後着 swap**: 大きい画像で preview → original の swap が見える (既存挙動 #97 を踏襲)。
7. **ReadImage 失敗**: 壊れた画像でエラーパネル surface (既存挙動)。preview が一瞬出ても最終的にエラー表示が勝つ。
8. **大量タブ切替**: 16 タブを高速に Ctrl+Tab で回す → メモリリーク (DevTools の Performance / Memory パネル) なし。

## 9. 決定事項 (Phase 1)

- preview Blob URL の **viewer 横断モジュールスコープ Map** で hit を実現
- 上限は固定 16 件 (定数 `PREVIEW_CACHE_CAPACITY` を export)
- LRU は JS の Map insertion order を利用 (touch on access = delete + set)
- タブ閉じでも cache から削除しない (LRU 任せ)
- cache hit 時は `getPreview` IPC をスキップ (GetImageInfo / ReadImage は併走)
- ImageView は `useState` の lazy initializer で cache から hydrate (初回 render から `<img src=preview>`)
- Blob URL の revoke 責任は cache のみが負う (ImageView 側の revoke 処理は削除)
- `setCachedPreview` の戻り値 `adopted` で同一 path 重複時の Blob 廃棄を呼び出し側に伝達
- `PREVIEW_REVOKE_DELAY_MS` を `shared/utils/thumbnailDefaults.ts` に移送して 2 経路 (cache / 過去の ImageView 内) で共有 (AGENTS.md D-1)
- vitest で previewCache の純関数ユニットテストを 6 ケース追加
- mtime invalidation / DeleteImage 連携 / watcher 連携は Phase 1 では入れない

## 10. Out of scope (Phase 2 候補)

- 設定 UI でキャッシュ枚数を可変 (`previewCacheSize`)
- オリジナル (`imgread.Result`) の cache 拡張 (フル品質も即時表示)
- mtime ベース invalidation (Go IPC 追加: `GetThumbnailWithMtime` 等)
- `DeleteImage` 経路から `evictPreview(path)` を明示呼び出し
- watcher (#19) と連携した cache invalidation (画像ファイル更新検知)
- CSS transition (preview → original の fade)
- preview を出すか出さないかの設定 UI

## 11. Phase 分割

| Phase | 範囲 | 着手条件 |
|-------|------|---------|
| **Phase 1** | 本仕様の §1〜§9 | ユーザー合意 |
| Phase 2 | §10 の各項目 (使ってみての要望ベース) | 必要が出た時に別 issue を起票 |

## 12. 関連

- 元 issue: [#106](https://github.com/maretol/image-observer/issues/106)
- 親 spec (Phase 1 = preview 先行表示): [spec-low-res-preview.md](spec-low-res-preview.md) (§11 の Out of scope に挙げていた「viewer 横断のプレビューメモリキャッシュ」が本 spec の Phase 1 にあたる)
- 関連 spec: [spec-thumbnail.md](spec-thumbnail.md) (Go 側ディスクキャッシュ)
- 関連 PR: #103 / #104 / #107 (preview 関連の最近の iterate)
- AGENTS.md 該当節:
  - **B-1** (ミュータブル参照を直接 export しない) — module-scoped Map は内部閉鎖、getter/setter のみ export
  - **D-1** (定数共有) — `PREVIEW_REVOKE_DELAY_MS` を shared 化 / `PREVIEW_CACHE_CAPACITY` を 1 箇所定義
  - **H-3** (グローバル / モジュール state のリーク) — capacity 上限 + evict revoke で leak 防御
  - **H-7** (波及確認) — 同概念 (in-memory image cache) が他にあるか grep で確認 (現状は preview の disk cache のみ in Go side)
  - **H-8** (race マトリクス) — §7 で簡易マトリクス
