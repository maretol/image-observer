import { useEffect, useRef, useState } from "react";
import { GetThumbnail } from "../../../wailsjs/go/main/App";
import { toBytes } from "../../shared/utils/base64";
import { createThumbCache, type ThumbCacheValue } from "./thumbnailCache";

const THUMB_SIZE = 256;
const THUMB_MODE = "letterbox";

// Maximum thumbnail entries held in memory. Each entry stores a Blob (raw
// bytes) referenced by an object URL; with 256px JPG/PNG thumbs that runs
// ~30-150KB per entry, so 500 caps roughly at 15-75MB. Overflow evicts the
// least-recently-used entry and revokes its object URL so the underlying
// Blob can be reclaimed. The Go side keeps its own disk cache so re-fetching
// after eviction is cheap.
const CACHE_MAX = 500;

const cache = createThumbCache(CACHE_MAX);
const inflight = new Map<string, Promise<ThumbCacheValue>>();

function load(path: string): Promise<ThumbCacheValue> {
  const cached = cache.get(path);
  if (cached) return Promise.resolve(cached);
  const existing = inflight.get(path);
  if (existing) return existing;

  const p = (async () => {
    try {
      const res = await GetThumbnail(path, THUMB_SIZE, THUMB_MODE);
      const bytes = toBytes(res.data as unknown as string | number[]);
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

// useGridThumbnail returns the thumbnail object URL for a path once an
// IntersectionObserver reports the element as visible.
//
// Intended use: render the wrapper div with the returned ref, and an <img>
// child whose `src` is the returned `url` (or a placeholder when null).
export function useGridThumbnail(path: string) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "ok" | "error">(
    "idle",
  );

  useEffect(() => {
    // Reset when the path changes — this matters when filtering reorders cards
    // and a card's underlying entry shifts.
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
