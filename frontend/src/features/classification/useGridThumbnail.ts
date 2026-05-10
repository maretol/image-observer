import { useEffect, useRef, useState } from "react";
import { GetThumbnail } from "../../../wailsjs/go/main/App";
import { toDataURL } from "../../shared/utils/base64";

const THUMB_SIZE = 256;
const THUMB_MODE = "letterbox";

type CacheValue = {
  url: string;        // data: URL
  state: "ok" | "error";
};

// Module-scoped cache: key is the absolute image path. Held for the lifetime
// of the renderer process so navigating between folders does not refetch
// already-seen thumbnails. Bounded loosely by the LRU strategy noted in
// spec §4.5; v1 has no eviction (Phase H follow-up).
const cache = new Map<string, CacheValue>();
const inflight = new Map<string, Promise<CacheValue>>();

function load(path: string): Promise<CacheValue> {
  const cached = cache.get(path);
  if (cached) return Promise.resolve(cached);
  const existing = inflight.get(path);
  if (existing) return existing;

  const p = (async () => {
    try {
      const res = await GetThumbnail(path, THUMB_SIZE, THUMB_MODE);
      const url = toDataURL(res.data as unknown as string, res.mimeType);
      const value: CacheValue = { url, state: "ok" };
      cache.set(path, value);
      return value;
    } catch {
      const value: CacheValue = { url: "", state: "error" };
      cache.set(path, value);
      return value;
    } finally {
      inflight.delete(path);
    }
  })();
  inflight.set(path, p);
  return p;
}

// useGridThumbnail returns the thumbnail data URL for a path once an
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
