// Bounded LRU cache for grid thumbnails. Keys are absolute image paths;
// values carry the resolved object URL (or an error marker). On overflow the
// least-recently-used entry is dropped and its object URL revoked so the
// underlying Blob memory is reclaimed by the browser.
//
// Both `get` and `set` count as a "use" and bump the entry to MRU. Map's
// insertion order gives us LRU semantics with delete+set on access.

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
        // Defensive: revoke only throws for malformed URLs, which shouldn't
        // happen here.
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
