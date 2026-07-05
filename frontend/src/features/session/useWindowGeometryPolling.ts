import { useEffect, useState } from "react";
import {
  Environment,
  WindowGetPosition,
  WindowGetSize,
  WindowIsMaximised,
} from "../../../wailsjs/runtime/runtime";
import type { state } from "../../../wailsjs/go/models";
import { logger } from "../../shared/utils/logger";

// WindowGetSize/Position と WindowIsMaximised を固定間隔 (と resize 時) で poll する。Wails に
// window-move / maximize イベントが無いので poll が最善。返す width/height/x/y は *非最大化*
// (restore) geometry — maximized の間はあえて上書きしないので、最大化のまま閉じても次回起動に
// まともな restore サイズが残る (issue #86)。
//
// Windows では poll を無効化する: native Win32 WINDOWPLACEMENT (issue #129) が window 欄を所有
// (main.go が OnBeforeClose で捕捉、state.SaveWindow が唯一の writer) するので、poll すると
// useSessionSave に競合値が流れ Go 所有の geometry を潰す。Windows では hook はロード初期値を
// 固定で返す (spec-window-placement.md §8)。
//
// 返り object は useState の値なので、変化なしの poll をまたいで Object.is identity が安定する。
// consumer (useSessionSave) は追加の memo なしで渡せる。

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
// Environment() は起動直後に一時失敗しうる。早期の 1 回失敗が非 Windows の #86 poll を
// 恒久無効化しないよう数回 retry する。
const ENV_RETRY_LIMIT = 5;
const ENV_RETRY_DELAY_MS = 300;

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
    // geometry は固定し maximized フラグだけ立てる。初回 WindowIsMaximised() 分岐と await 後
    // 再チェック分岐が共有 (変更を一箇所に集約)。
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
        // maximized 再チェック: 最初の WindowIsMaximised() から今の間にユーザーが最大化し得て、
        // その場合 sz/pos は *最大化* geometry を反映する。maximized: false で commit すると
        // あえて固定している restore geometry を潰す (issue #86)。snapshot を捨て、次の poll が
        // 上の early-return で maximized を拾う。再チェックは Promise.all の *後* でないと、
        // WindowIsMaximised が WindowGetSize より先に resolve して race を取り逃す。
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
        // 無視 — 起動中は Wails runtime が一瞬未準備のことがある
      }
    };
    const onResize = () => update();
    let interval: number | undefined;
    let resizeListening = false;
    let retryTimer: number | undefined;
    const startPolling = () => {
      window.addEventListener("resize", onResize);
      resizeListening = true;
      interval = window.setInterval(update, POLL_INTERVAL_MS);
      logger.debug("session", "window pos/size polling started", {
        intervalMs: POLL_INTERVAL_MS,
      });
      update();
    };

    // poll するか決める前に platform を解決。Environment() は起動直後に一時失敗しうるので数回
    // retry する — 1 回の早期失敗が非 Windows の #86 poll を恒久無効化しないように。retry を
    // 使い切ったら "poll しない" に fallback (Windows でも Go 所有 geometry を潰さない安全既定)。
    let lastEnvError: unknown;
    const resolvePlatform = async (): Promise<string | null> => {
      for (let attempt = 0; attempt < ENV_RETRY_LIMIT; attempt++) {
        try {
          return (await Environment()).platform;
        } catch (err) {
          lastEnvError = err;
          if (cancelled || attempt === ENV_RETRY_LIMIT - 1) return null;
          await new Promise<void>((resolve) => {
            retryTimer = window.setTimeout(resolve, ENV_RETRY_DELAY_MS);
          });
          if (cancelled) return null;
        }
      }
      return null;
    };

    resolvePlatform().then((platform) => {
      if (cancelled) return;
      if (platform === null) {
        // 直近の失敗理由をログし、非 Windows で poll が始まらない理由が分かるように。
        logger.debug(
          "session",
          "window geometry polling skipped (Environment() unresolved after retries)",
          { err: String(lastEnvError) },
        );
        return;
      }
      // Windows は window geometry を native 所有する (issue #129) ので poll しない。他 platform は #86 poll を維持。
      if (platform === "windows") {
        logger.debug(
          "session",
          "window geometry polling disabled on windows (issue #129)",
        );
        return;
      }
      startPolling();
    });

    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      if (resizeListening) window.removeEventListener("resize", onResize);
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, []);

  return windowState;
}
