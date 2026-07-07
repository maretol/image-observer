import { useEffect, useRef, useState } from "react";
import { GetThumbnail } from "../../../wailsjs/go/main/App";
import { toBytes } from "../../shared/utils/base64";
import { createThumbCache, type ThumbCacheValue } from "./thumbnailCache";

// module レベルの live サムネパラメータ (settings ロード前の初回 GetThumbnail 用に
// 既定値を seed)。App.tsx が settings ロード後と更新ごとに setThumbnailParams() する。
// 注意: 変更しても既にキャッシュ済みの entry は invalidate されない (旧サイズの
// object URL を eviction まで保持)。size 変更は稀なので v1 では許容。
let thumbSize = 256;
let thumbMode = "letterbox";

export function setThumbnailParams(size: number, mode: string) {
  if (Number.isFinite(size) && size > 0) thumbSize = Math.floor(size);
  if (mode === "letterbox" || mode === "crop") thumbMode = mode;
}

// メモリ保持するサムネ上限。1 entry ~30-150KB (256px JPG/PNG) なので 500 で ~15-75MB。
// 溢れたら LRU を evict + object URL revoke。Go 側にディスクキャッシュがあり再取得は安い。
const CACHE_MAX = 500;

// revoke を遅延させ、evict 直後で <img> の取得が終わっていない URL に猶予を与える。
// commit で即 fetch が始まるので 5s あれば十分。
const REVOKE_DELAY_MS = 5000;

const cache = createThumbCache(CACHE_MAX, (url) => {
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
});
const inflight = new Map<string, Promise<ThumbCacheValue>>();

function load(path: string): Promise<ThumbCacheValue> {
  const cached = cache.get(path);
  if (cached) return Promise.resolve(cached);
  const existing = inflight.get(path);
  if (existing) return existing;

  const p = (async () => {
    try {
      const res = await GetThumbnail(path, thumbSize, thumbMode);
      const bytes = toBytes(res.data);
      const blob = new Blob([bytes], { type: res.mimeType });
      const url = URL.createObjectURL(blob);
      const value: ThumbCacheValue = { url, state: "ok" };
      cache.set(path, value);
      return value;
    } catch {
      const value: ThumbCacheValue = { url: "", state: "error" };
      cache.set(path, value);
      return value;
    } finally {
      inflight.delete(path);
    }
  })();
  inflight.set(path, p);
  return p;
}

// IntersectionObserver が要素を可視と報告したら、その path のサムネ object URL を返す。
// 使い方: 返り ref を wrapper div に、返り url を <img> の src に (null 時は placeholder)。
export function useGridThumbnail(path: string) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "ok" | "error">(
    "idle",
  );

  useEffect(() => {
    // path 変更時に reset (フィルタが card を並べ替えて entry がずれるとき重要)。
    setUrl(null);
    setState("idle");

    const el = ref.current;
    if (!el) return;

    let cancelled = false;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          observer.disconnect();
          setState("loading");
          load(path).then((v) => {
            if (cancelled) return;
            if (v.state === "ok") {
              setUrl(v.url);
              setState("ok");
            } else {
              setState("error");
            }
          });
          break;
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [path]);

  return { ref, url, state };
}
