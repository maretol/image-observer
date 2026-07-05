// grid サムネの LRU キャッシュ。溢れたら LRU entry を捨てて object URL を revoke し、
// Blob メモリを解放する。get/set 両方が "use" で MRU に上げる (Map の挿入順 +
// delete+set で LRU を実現)。

export type ThumbCacheValue = {
  url: string;
  state: "ok" | "error";
};

export type ThumbCache = {
  get(path: string): ThumbCacheValue | undefined;
  set(path: string, value: ThumbCacheValue): void;
  size(): number;
};

export function createThumbCache(
  maxEntries: number,
  revoke: (url: string) => void = (url) => URL.revokeObjectURL(url),
): ThumbCache {
  const cache = new Map<string, ThumbCacheValue>();

  const revokeIfBlob = (v: ThumbCacheValue) => {
    if (v.state === "ok" && v.url) {
      try {
        revoke(v.url);
      } catch {
        // revoke が throw するのは不正 URL のときだけで、ここでは起きない想定。
      }
    }
  };

  return {
    get(path) {
      const v = cache.get(path);
      if (v === undefined) return undefined;
      cache.delete(path);
      cache.set(path, v);
      return v;
    },
    set(path, value) {
      const existing = cache.get(path);
      if (existing) {
        if (existing.url !== value.url) revokeIfBlob(existing);
        cache.delete(path);
      }
      cache.set(path, value);
      while (cache.size > maxEntries) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey === undefined) break;
        const oldest = cache.get(oldestKey)!;
        revokeIfBlob(oldest);
        cache.delete(oldestKey);
      }
    },
    size() {
      return cache.size;
    },
  };
}
