// preview Blob URL の viewer 横断 LRU キャッシュ (#106)。
//
// タブ切替で <ImageView key={tab.path} /> が unmount → remount される際、
// 過去に取得済みの 1024px プレビュー Blob URL を即時に hydrate して
// 「読み込み中…」blank フレームを潰すための層 (spec-viewer-tab-cache.md)。
//
// ## 所有権モデル
//
// - Blob URL の revoke 責任は **cache 側だけ** が負う。`setCachedPreview` で
//   採用された url は LRU evict 時 / `evictPreview` 時に遅延 revoke される。
// - 呼び出し側 (= ImageView) は `setCachedPreview` の戻り値 `adopted` で
//   「cache が引き取ったか」を判定する。`adopted === false` の場合は
//   既存エントリが残るので、呼び出し側が手元の新 url を自分で revoke する
//   責任を持つ (重複登録時の orphan Blob を防ぐ)。
//
// ## AGENTS.md 該当節
//
// - B-1: モジュール内 Map は閉鎖し、getter / setter のみ export する
//   (export const map = ... のような mutable ref 公開はしない)
// - D-1: `PREVIEW_REVOKE_DELAY_MS` は thumbnailDefaults.ts から import し
//   ImageView と共有 / `PREVIEW_CACHE_CAPACITY` は本ファイル単一定義
// - H-3: 上限超過時に必ず evict + scheduleRevoke でリークを防ぐ。
//   同 path 重複登録時は新 Blob を引き取らず adopted=false で返し、
//   呼び出し側に廃棄を任せる (二重所有 / orphan 防止)。

import { PREVIEW_REVOKE_DELAY_MS } from "../../shared/utils/thumbnailDefaults";

// LRU 上限。max panels (16) と揃える。
export const PREVIEW_CACHE_CAPACITY = 16;

type CacheEntry = {
  url: string;
};

// JS の Map は insertion order を保持する。
// LRU "touch on access" は delete + set で先頭 → 末尾の移動で表現する。
const cache = new Map<string, CacheEntry>();

// hit なら url を返し、entry を LRU の最新位置に touch する (= 直近使用)。
// miss なら null。
export function getCachedPreview(path: string): string | null {
  const e = cache.get(path);
  if (!e) return null;
  cache.delete(path);
  cache.set(path, e);
  return e.url;
}

// path → url を cache に登録する。
//
// - 既存 path がある場合: 新 url は引き取らず、既存を最新位置に touch して
//   adopted=false を返す。呼び出し側が新 url を自分で revoke する必要がある。
// - 新規登録の場合: 末尾に追加し、容量超過なら最も古い entry を evict + 遅延 revoke。
//   adopted=true を返す。
export function setCachedPreview(path: string, url: string): boolean {
  const existing = cache.get(path);
  if (existing) {
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

// 明示 evict (Phase 1 では呼び出し経路なし、Phase 2 で DeleteImage 連携用 + test 用)。
export function evictPreview(path: string): void {
  const e = cache.get(path);
  if (!e) return;
  cache.delete(path);
  scheduleRevoke(e.url);
}

function evictOldest(): void {
  // Map.keys() の iteration は insertion order なので、最初の next() が
  // 最も古い key を返す。
  const first = cache.keys().next();
  if (first.done) return;
  const oldestPath = first.value;
  const e = cache.get(oldestPath)!;
  cache.delete(oldestPath);
  scheduleRevoke(e.url);
}

// revoke を遅延実行する。
// LRU evict 直後に、他の Panel の <img src=blob:...> がまだ参照中の可能性が
// あるため、即時 revoke すると表示が壊れる。`<img>` は src 属性に Blob URL を
// 代入した時点で内部参照を持つので、`PREVIEW_REVOKE_DELAY_MS` 経過後の
// revoke なら既存表示は維持される (新規 mount で同 url を渡す経路は無いので
// 表示崩壊しない)。
function scheduleRevoke(url: string): void {
  setTimeout(() => URL.revokeObjectURL(url), PREVIEW_REVOKE_DELAY_MS);
}

// test 用 reset。本番コードから呼ばない (export 名に __ プレフィクス)。
export function __resetPreviewCacheForTests(): void {
  for (const [, e] of cache) {
    URL.revokeObjectURL(e.url);
  }
  cache.clear();
}
