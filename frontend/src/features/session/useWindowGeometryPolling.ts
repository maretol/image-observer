import { useEffect, useState } from "react";
import {
  Environment,
  WindowGetPosition,
  WindowGetSize,
  WindowIsMaximised,
} from "../../../wailsjs/runtime/runtime";
import type { state } from "../../../wailsjs/go/models";
import { logger } from "../../shared/utils/logger";

// useWindowGeometryPolling polls WindowGetSize/Position and WindowIsMaximised
// at a fixed interval (and on window-resize). Wails exposes no window-move /
// window-maximize event, so polling is the best we have. The returned width /
// height / x / y track the *non-maximized* (restore) geometry — while
// maximized is true we deliberately do not overwrite them, so closing the
// window while maximized still leaves a sensible restore size for the next
// launch (issue #86).
//
// On Windows the polling is disabled: the native Win32 WINDOWPLACEMENT path
// (issue #129) owns the window field there — main.go captures it at
// OnBeforeClose and state.SaveWindow is the sole writer — so polling
// WindowGetPosition would feed a competing value into useSessionSave and
// clobber the Go-owned geometry. On Windows the hook just returns the loaded
// initial value, frozen. See docs/spec-window-placement.md §8 (sync model).
//
// The returned object is the value held in useState, so `Object.is` identity
// is stable across polls that observe no change. Consumers (typically
// useSessionSave) can pass it directly without further memoization.

export type WindowGeometryState = {
  width: number;
  height: number;
  x: number;
  y: number;
  maximized: boolean;
};

const POLL_INTERVAL_MS = 2000;
const DEFAULT_WIDTH = 1024;
const DEFAULT_HEIGHT = 768;

type Opts = {
  initial?: state.WindowState | null;
};

export function useWindowGeometryPolling(
  { initial }: Opts = {},
): WindowGeometryState {
  const [windowState, setWindowState] = useState<WindowGeometryState>({
    width: initial?.width ?? DEFAULT_WIDTH,
    height: initial?.height ?? DEFAULT_HEIGHT,
    x: initial?.x ?? -1,
    y: initial?.y ?? -1,
    maximized: initial?.maximized ?? false,
  });

  useEffect(() => {
    let cancelled = false;
    // Freeze geometry; only the maximized flag is allowed to flip. Shared by
    // both the initial WindowIsMaximised() branch and the post-await re-check
    // branch so future tweaks land in one place.
    const markMaximized = () =>
      setWindowState((cur) =>
        cur.maximized ? cur : { ...cur, maximized: true },
      );
    const update = async () => {
      try {
        const maximized = await WindowIsMaximised();
        if (cancelled) return;
        if (maximized) {
          markMaximized();
          return;
        }
        const [sz, pos] = await Promise.all([
          WindowGetSize(),
          WindowGetPosition(),
        ]);
        if (cancelled) return;
        // Re-check maximized: between the first WindowIsMaximised() and now
        // the user could have maximized the window, in which case sz/pos
        // reflect the *maximized* geometry. Committing it under maximized:
        // false would clobber the restore geometry we are deliberately
        // freezing (issue #86). Drop the snapshot and let the next poll
        // pick up the maximized flag through the early-return branch above.
        // The recheck must come *after* the Promise.all — folding it into
        // the same Promise.all would let WindowIsMaximised resolve before
        // WindowGetSize observed the maximized state, missing the race.
        const maximizedAfter = await WindowIsMaximised();
        if (cancelled) return;
        if (maximizedAfter) {
          markMaximized();
          return;
        }
        setWindowState((cur) => {
          if (
            !cur.maximized &&
            cur.width === sz.w &&
            cur.height === sz.h &&
            cur.x === pos.x &&
            cur.y === pos.y
          ) {
            return cur;
          }
          const next = {
            width: sz.w,
            height: sz.h,
            x: pos.x,
            y: pos.y,
            maximized: false,
          };
          const geometryChanged =
            cur.width !== sz.w ||
            cur.height !== sz.h ||
            cur.x !== pos.x ||
            cur.y !== pos.y;
          logger.debug(
            "session",
            geometryChanged ? "window pos/size changed" : "window maximized cleared",
            next,
          );
          return next;
        });
      } catch {
        // ignore — Wails runtime may not be ready briefly during startup
      }
    };
    const onResize = () => update();
    let interval: number | undefined;
    let resizeListening = false;
    const startPolling = () => {
      window.addEventListener("resize", onResize);
      resizeListening = true;
      interval = window.setInterval(update, POLL_INTERVAL_MS);
      logger.debug("session", "window pos/size polling started", {
        intervalMs: POLL_INTERVAL_MS,
      });
      update();
    };

    // Gate the polling on platform: Windows owns the window geometry natively
    // (issue #129, see the file-level comment), so polling must not run there.
    // Every other platform keeps the #86 polling. If Environment() cannot be
    // resolved we err on the safe side and do not poll — a missing platform
    // check must never risk clobbering the Windows geometry; the loaded initial
    // value is retained.
    Environment()
      .then((env) => {
        if (cancelled) return;
        if (env.platform === "windows") {
          logger.debug(
            "session",
            "window geometry polling disabled on windows (issue #129)",
          );
          return;
        }
        startPolling();
      })
      .catch((err) => {
        // Environment() unavailable (runtime not ready) — do not poll (safe
        // default). Log so a non-Windows dev can tell *why* polling never
        // started instead of seeing silent inaction.
        logger.debug("session", "window geometry polling skipped (Environment() failed)", {
          err: String(err),
        });
      });

    return () => {
      cancelled = true;
      if (resizeListening) window.removeEventListener("resize", onResize);
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, []);

  return windowState;
}
