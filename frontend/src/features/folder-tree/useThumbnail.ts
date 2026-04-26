import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { GetThumbnail } from "../../../wailsjs/go/main/App";
import { thumb } from "../../../wailsjs/go/models";
import { toDataURL } from "../../shared/utils/base64";

export type ThumbMode = "letterbox" | "crop";

export type CacheEntry =
  | { status: "loading" }
  | { status: "ok"; src: string }
  | { status: "error"; message: string };

const HOVER_DELAY_MS = 250;

export function useThumbnail(displaySize = 256, mode: ThumbMode = "letterbox") {
  const [hoveredPath, setHoveredPath] = useState<string | null>(null);
  const [popupAnchor, setPopupAnchor] = useState<DOMRect | null>(null);
  const [popupVisible, setPopupVisible] = useState(false);
  const cacheRef = useRef(new Map<string, CacheEntry>());
  const [, forceUpdate] = useReducer((n: number) => n + 1, 0);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const onEnter = useCallback(
    (path: string, rect: DOMRect) => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      setHoveredPath(path);
      setPopupAnchor(rect);
      setPopupVisible(false);
      timerRef.current = window.setTimeout(() => {
        setPopupVisible(true);
        if (!cacheRef.current.has(path)) {
          cacheRef.current.set(path, { status: "loading" });
          forceUpdate();
          GetThumbnail(path, displaySize, mode)
            .then((result) => {
              cacheRef.current.set(path, { status: "ok", src: thumbToDataURL(result) });
              forceUpdate();
            })
            .catch((err) => {
              cacheRef.current.set(path, { status: "error", message: errorMessage(err) });
              forceUpdate();
            });
        }
      }, HOVER_DELAY_MS);
    },
    [displaySize, mode]
  );

  const onLeave = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setHoveredPath(null);
    setPopupVisible(false);
  }, []);

  const entry = hoveredPath ? cacheRef.current.get(hoveredPath) : undefined;

  return {
    onEnter,
    onLeave,
    popupVisible,
    popupAnchor,
    entry,
    displaySize,
  };
}

function thumbToDataURL(result: thumb.Result): string {
  return toDataURL(result.data as unknown as number[] | string, result.mimeType);
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}
