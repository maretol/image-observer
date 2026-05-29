import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GetImageInfo, ReadImage } from "../../../wailsjs/go/main/App";
import { imgread } from "../../../wailsjs/go/models";
import type { Tab } from "./useTabs";
import { toBytes, toDataURL } from "../../shared/utils/base64";
import { pushBodyStyle } from "../../shared/utils/bodyStyles";
import { useToastFn } from "../../shared/components/Toast";
import { errorMessage } from "../../shared/utils/error";
import { zoomCommandBus, type ZoomCommand } from "../../shared/utils/keybindings";
import { logger } from "../../shared/utils/logger";
import { basename } from "../../shared/utils/path";
import {
  getPreview,
  PREVIEW_REVOKE_DELAY_MS,
} from "../../shared/utils/thumbnailDefaults";
import { getCachedPreview, setCachedPreview } from "./previewCache";

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8.0;
const ZOOM_STEP = 1.2;

type Props = {
  tab: Tab;
  tabIndex: number;
  isActivePanel: boolean;
  // "zoom" (default) → wheel zooms. "shift-zoom" → wheel pans, Shift+wheel zooms.
  wheelMode?: string;
  onUpdateTabState: (index: number, patch: Partial<Tab>) => void;
};

export function ImageView({
  tab,
  tabIndex,
  isActivePanel,
  wheelMode,
  onUpdateTabState,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [imageData, setImageData] = useState<imgread.Result | null>(null);
  // 低解像度プレビュー (#97 + #106)。original 到着までの一時表示用 Blob URL。
  //
  // タブ切替で ImageView が remount された直後の最初の render で「読み込み中…」
  // blank を出さないため、`useState` の **lazy initializer** で viewer 横断
  // preview cache から hydrate する (#106 spec D-13)。cache hit なら mount
  // 直後 (= useEffect 発火前) から `<img src=preview>` が描画される。
  //
  // cache miss なら null で始まり、後段の useEffect 内の getPreview が成功
  // した時点で setPreviewUrl(url) + cache 登録。
  const [previewUrl, setPreviewUrl] = useState<string | null>(
    () => getCachedPreview(tab.path),
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const toast = useToastFn();
  const dragRef = useRef<{
    startX: number;
    startY: number;
    startPanX: number;
    startPanY: number;
    pointerId: number;
    release: () => void;
  } | null>(null);

  // Mirror tab/tabIndex/onUpdateTabState into refs so the zoom-command
  // listener stays stable across renders (we only re-bind on activation
  // change, not on every pan/zoom).
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const tabIndexRef = useRef(tabIndex);
  tabIndexRef.current = tabIndex;
  const updateRef = useRef(onUpdateTabState);
  updateRef.current = onUpdateTabState;

  // Fetch image when path changes. spec-viewer-tab-cache.md §6:
  //   - GetImageInfo → 寸法を tab state に流し initial fit を駆動 (常に発火)
  //   - getPreview   → cache miss 時のみ発火。成功すれば cache 登録 + 表示
  //   - ReadImage    → オリジナル本体 (常に発火、cache hit 時も併走させて
  //                    最終的に <img src> を original で上書きする)
  //
  // originalSettled フラグは getPreview .then 内で ReadImage 完了を観測する
  // ためのローカル。original 先着時は cache に preview を登録せず Blob 自体
  // を作らない (orphan / 無駄を回避、spec D-10)。
  //
  // Blob URL の revoke 責任は viewer 横断 previewCache に一元化される
  // (spec D-9)。ImageView は revoke 処理を持たない。cache に渡した Blob URL
  // は LRU evict 時 / 明示 evictPreview 時に cache 側が遅延 revoke する。
  useEffect(() => {
    let cancelled = false;
    let originalSettled = false;
    // cache hit 判定。hit 時は getPreview IPC をスキップ (表示自体は useState
    // の lazy initializer で既に hydrate 済み)。miss 時は IPC を発火し、結果
    // を cache に登録する。判定は useEffect 開始時に 1 回固定。
    const hadCacheHit = getCachedPreview(tab.path) !== null;

    setImageData(null);
    // previewUrl はリセットしない: lazy initializer で cache hit 値が入って
    // いる場合 / cache miss で null の場合のいずれも、ここでクリアすると
    // 初回 render の <img src> 描画機会を失う。後段の getPreview success で
    // 上書き、後着の ReadImage success で src precedence によって <img src>
    // が自動的に original に切り替わる (useMemo)。
    setLoadError(null);

    // 寸法先行確定 (header 読み only)。失敗は黙殺 — ReadImage が同じ理由で
    // 失敗するならそちらでユーザー向けエラーが surface する。
    // async callback 内の onUpdateTabState は updateRef/tabIndexRef 経由で
    // 呼ぶ (タブ並び替え中に await から戻ると closure 内 tabIndex が古く
    // なり別タブを更新するリスクがあるため)。
    GetImageInfo(tab.path)
      .then((info) => {
        if (cancelled) return;
        const cur = tabRef.current;
        if (cur.imageWidth !== info.width || cur.imageHeight !== info.height) {
          updateRef.current(tabIndexRef.current, {
            imageWidth: info.width,
            imageHeight: info.height,
          });
        }
      })
      .catch(() => {
        /* swallow: ReadImage surfaces user-facing error */
      });

    // 低解像度プレビュー (cache miss 時のみ)。
    // - cancelled || originalSettled: Blob を作らない (spec D-10 = #97 D-12
    //   踏襲、orphan + 不可視 Blob 回避)
    // - adopted=false: 別経路で先着登録された (viewer 横断 race 等)。手元の
    //   url は呼び出し側で revoke する責任 (cache 側責任との二重所有回避)
    // 失敗は logger.warn のみで吞む。cancelled 後は warn も抑止 (ノイズ回避)。
    if (!hadCacheHit) {
      getPreview(tab.path)
        .then((res) => {
          if (cancelled || originalSettled) return;
          const bytes = toBytes(res.data);
          const blob = new Blob([bytes], { type: res.mimeType });
          const url = URL.createObjectURL(blob);
          const adopted = setCachedPreview(tab.path, url);
          if (!adopted) {
            setTimeout(
              () => URL.revokeObjectURL(url),
              PREVIEW_REVOKE_DELAY_MS,
            );
            const cached = getCachedPreview(tab.path);
            if (cached) setPreviewUrl(cached);
            return;
          }
          setPreviewUrl(url);
        })
        .catch((e) => {
          if (cancelled) return;
          logger.warn("viewer-grid", "preview load failed", {
            path: tab.path,
            err: errorMessage(e),
          });
        });
    }

    // オリジナル本体。success/failure どちらでも originalSettled を立てて
    // 後着 preview の Blob 生成 (cache 登録) を抑止。Blob URL の revoke は
    // cache が責任を持つので ImageView 側では行わない。<img src> は useMemo
    // の src precedence で自動的に original に切り替わる。
    ReadImage(tab.path)
      .then((res) => {
        if (cancelled) return;
        originalSettled = true;
        setImageData(res);
        const cur = tabRef.current;
        if (cur.imageWidth !== res.width || cur.imageHeight !== res.height) {
          updateRef.current(tabIndexRef.current, {
            imageWidth: res.width,
            imageHeight: res.height,
          });
        }
      })
      .catch((e) => {
        if (cancelled) return;
        originalSettled = true;
        const msg = errorMessage(e);
        setLoadError(msg);
        toast(`画像読み込みに失敗: ${basename(tab.path)} — ${msg}`, "error");
      });

    return () => {
      cancelled = true;
      // Blob URL revoke は previewCache 側責任 (spec D-9)。cleanup では何もしない。
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.path]);

  // Initial fit when both image and container known
  useEffect(() => {
    if (tab.initialized) return;
    if (tab.imageWidth <= 0 || tab.imageHeight <= 0) return;
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const fit = computeInitialFit(
      tab.imageWidth,
      tab.imageHeight,
      rect.width,
      rect.height
    );
    onUpdateTabState(tabIndex, { ...fit, initialized: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.initialized, tab.imageWidth, tab.imageHeight]);

  // Re-pan on viewport (panel) resize. Axis-independent rule:
  //   - axis where image fits   → center on that axis
  //   - axis where image hangs  → keep the image-pixel that was at the
  //                                viewport's geometric center, then clamp
  // Zoom is never modified here. See spec note in `Phase H UI/UX 修正`.
  useEffect(() => {
    if (!tab.initialized) return;
    const el = containerRef.current;
    if (!el) return;
    let prev: { w: number; h: number } | null = null;
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (!cr) return;
      const newW = cr.width;
      const newH = cr.height;
      if (newW <= 0 || newH <= 0) return;
      const t = tabRef.current;
      if (t.imageWidth <= 0 || t.imageHeight <= 0 || t.zoom <= 0) return;
      // First callback after attach records the baseline; nothing to recompute.
      if (!prev) {
        prev = { w: newW, h: newH };
        return;
      }
      if (prev.w === newW && prev.h === newH) return;

      const renderedW = t.imageWidth * t.zoom;
      const renderedH = t.imageHeight * t.zoom;
      let nx: number;
      let ny: number;
      if (renderedW <= newW) {
        nx = (newW - renderedW) / 2;
      } else {
        const imgCenterPx = (prev.w / 2 - t.panX) / t.zoom;
        nx = newW / 2 - imgCenterPx * t.zoom;
      }
      if (renderedH <= newH) {
        ny = (newH - renderedH) / 2;
      } else {
        const imgCenterPy = (prev.h / 2 - t.panY) / t.zoom;
        ny = newH / 2 - imgCenterPy * t.zoom;
      }
      ({ panX: nx, panY: ny } = clampPan(nx, ny, renderedW, renderedH, newW, newH));
      prev = { w: newW, h: newH };
      if (nx !== t.panX || ny !== t.panY) {
        updateRef.current(tabIndexRef.current, { panX: nx, panY: ny });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [tab.initialized]);

  // After session restore: tab.initialized is true but imageWidth/Height start at 0.
  // Once they arrive (from ReadImage), the saved pan may be out of range if the
  // window was resized between sessions. Clamp once when dims become known.
  const clampedAfterRestoreRef = useRef(false);
  useEffect(() => {
    if (clampedAfterRestoreRef.current) return;
    if (!tab.initialized) return;
    if (tab.imageWidth <= 0 || tab.imageHeight <= 0) return;
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    clampedAfterRestoreRef.current = true;
    const renderedW = tab.imageWidth * tab.zoom;
    const renderedH = tab.imageHeight * tab.zoom;
    const { panX, panY } = clampPan(
      tab.panX,
      tab.panY,
      renderedW,
      renderedH,
      rect.width,
      rect.height
    );
    if (panX !== tab.panX || panY !== tab.panY) {
      onUpdateTabState(tabIndex, { panX, panY });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.initialized, tab.imageWidth, tab.imageHeight]);

  // Wheel handler. Attach as non-passive to allow preventDefault. Reads tab
  // state via tabRef so the listener is attached once per wheelMode change
  // rather than rebound on every pan/zoom.
  //
  // wheelMode === "shift-zoom":
  //   - Shift+wheel / Ctrl+wheel → zoom (cursor-anchored, like the default)
  //   - plain wheel              → pan (deltaY → vertical, deltaX → horizontal trackpads)
  //
  // wheelMode === "zoom" (default): wheel always zooms.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (e: WheelEvent) => {
      const t = tabRef.current;
      if (!t.initialized) return;
      const rect = container.getBoundingClientRect();
      const shouldZoom =
        wheelMode === "shift-zoom" ? e.shiftKey || e.ctrlKey || e.metaKey : true;
      if (shouldZoom) {
        e.preventDefault();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        // Some browsers swap deltaY into deltaX when Shift is held; pick the
        // non-zero one so the modifier+wheel zooms regardless.
        const d = e.deltaY !== 0 ? e.deltaY : e.deltaX;
        if (d === 0) return;
        const factor = d < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
        const newZoom = clamp(t.zoom * factor, MIN_ZOOM, MAX_ZOOM);
        const px = (cx - t.panX) / t.zoom;
        const py = (cy - t.panY) / t.zoom;
        let newPanX = cx - px * newZoom;
        let newPanY = cy - py * newZoom;
        const renderedW = t.imageWidth * newZoom;
        const renderedH = t.imageHeight * newZoom;
        ({ panX: newPanX, panY: newPanY } = clampPan(
          newPanX,
          newPanY,
          renderedW,
          renderedH,
          rect.width,
          rect.height,
        ));
        updateRef.current(tabIndexRef.current, {
          zoom: newZoom,
          panX: newPanX,
          panY: newPanY,
        });
        return;
      }
      // Pan mode: scroll the image. Subtract delta so deltaY > 0 (wheel down)
      // moves the image upward — same direction sense as a scrollable view.
      e.preventDefault();
      const renderedW = t.imageWidth * t.zoom;
      const renderedH = t.imageHeight * t.zoom;
      let nx = t.panX - e.deltaX;
      let ny = t.panY - e.deltaY;
      ({ panX: nx, panY: ny } = clampPan(
        nx,
        ny,
        renderedW,
        renderedH,
        rect.width,
        rect.height,
      ));
      if (nx !== t.panX || ny !== t.panY) {
        updateRef.current(tabIndexRef.current, { panX: nx, panY: ny });
      }
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, [wheelMode]);

  // Subscribe to zoom commands when this panel is active. Single-listener
  // bus: when the active panel changes, the new ImageView replaces the
  // previous one. Inactive panels don't react to keyboard commands.
  useEffect(() => {
    if (!isActivePanel) return;
    const handle = (cmd: ZoomCommand) => {
      const t = tabRef.current;
      const c = containerRef.current;
      if (!c) return;
      if (t.imageWidth <= 0 || t.imageHeight <= 0) return;
      const rect = c.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      if (cmd === "fit") {
        const fit = computeInitialFit(
          t.imageWidth,
          t.imageHeight,
          rect.width,
          rect.height,
        );
        updateRef.current(tabIndexRef.current, { ...fit, initialized: true });
        return;
      }

      // For "actualSize" / "in" / "out" we zoom around the viewport center
      // so the user's gaze stays put.
      let newZoom: number;
      if (cmd === "actualSize") {
        newZoom = 1.0;
      } else if (cmd === "in") {
        newZoom = clamp(t.zoom * ZOOM_STEP, MIN_ZOOM, MAX_ZOOM);
      } else {
        newZoom = clamp(t.zoom / ZOOM_STEP, MIN_ZOOM, MAX_ZOOM);
      }
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const px = (cx - t.panX) / t.zoom;
      const py = (cy - t.panY) / t.zoom;
      let nx = cx - px * newZoom;
      let ny = cy - py * newZoom;
      ({ panX: nx, panY: ny } = clampPan(
        nx,
        ny,
        t.imageWidth * newZoom,
        t.imageHeight * newZoom,
        rect.width,
        rect.height,
      ));
      updateRef.current(tabIndexRef.current, { zoom: newZoom, panX: nx, panY: ny });
    };
    zoomCommandBus.setListener(handle);
    return () => zoomCommandBus.setListener(null);
  }, [isActivePanel]);

  // Drag pan (left button only — leave right click for context menu).
  // Unified on PointerEvent + setPointerCapture so the same dragger that
  // started on the container keeps receiving moves even if the cursor leaves
  // the viewport, matching the touch/pen story too.
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      if (!tab.initialized) return;
      // A drag is already in flight (e.g. multi-touch second finger). Ignore
      // the new pointer so we don't overwrite dragRef and orphan the existing
      // release(), which would leak the body cursor/userSelect override.
      if (dragRef.current) return;
      e.preventDefault();
      const release = pushBodyStyle({
        cursor: "grabbing",
        userSelect: "none",
      });
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        startPanX: tab.panX,
        startPanY: tab.panY,
        pointerId: e.pointerId,
        release,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [tab.panX, tab.panY, tab.initialized]
  );

  // Drag-pan move/up listeners. Refs let us attach once on mount instead of
  // re-binding on every pan update.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const t = tabRef.current;
      let nx = drag.startPanX + (e.clientX - drag.startX);
      let ny = drag.startPanY + (e.clientY - drag.startY);
      const renderedW = t.imageWidth * t.zoom;
      const renderedH = t.imageHeight * t.zoom;
      ({ panX: nx, panY: ny } = clampPan(
        nx,
        ny,
        renderedW,
        renderedH,
        rect.width,
        rect.height
      ));
      updateRef.current(tabIndexRef.current, { panX: nx, panY: ny });
    };
    const endDrag = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      drag.release();
      dragRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
      // Restore if the component unmounts mid-drag.
      dragRef.current?.release();
      dragRef.current = null;
    };
  }, []);

  // src precedence (spec D-11): original > preview > 空文字。
  const src = useMemo(
    () => {
      if (imageData) return toDataURL(imageData.data, imageData.mimeType);
      if (previewUrl) return previewUrl;
      return "";
    },
    [imageData, previewUrl],
  );

  if (loadError) {
    return (
      <div className="image-view" ref={containerRef}>
        <div className="image-view-error">読み込み失敗: {loadError}</div>
      </div>
    );
  }

  // hasContent = 初期 fit 完了 + 寸法到着済み + 表示する src あり (spec D-14)。
  // セッション復元では `layout/serialization.ts` が `initialized: zoom > 0` を
  // 立てるため initialized=true && imageWidth/Height=0 の窓が存在する。
  // この窓中に previewUrl が先着して <img> を 0×0 で描画して blank になるのを
  // 避けるため、寸法 > 0 も AND 条件に含める。
  const hasContent =
    tab.initialized &&
    tab.imageWidth > 0 &&
    tab.imageHeight > 0 &&
    (imageData !== null || previewUrl !== null);

  // <img> の寸法 / 位置 (spec D-7):
  //   - original 表示中: W×H (= 元画像寸法) をそのまま使う。
  //   - preview 表示中: bitmap が N×N letterbox 正方形 (内側に W:H で
  //     content + 透過余白) のため、W×H に直接 stretch すると非一様
  //     scale で content のアスペクト比が歪む (#104)。
  //     代わりに bitmap を max(W,H) の正方形として描画し、offset で
  //     content 領域がちょうど [0..W]×[0..H] (= original と同じ矩形) に
  //     乗るよう寄せる。letterbox 余白は矩形の外側に押し出され、
  //     コンテナの `overflow: hidden` で clip される。
  const isPreview = imageData === null && previewUrl !== null;
  const renderedSize = Math.max(tab.imageWidth, tab.imageHeight);
  const previewOffsetX = (tab.imageWidth - renderedSize) / 2;
  const previewOffsetY = (tab.imageHeight - renderedSize) / 2;
  const imgWidth = isPreview ? renderedSize : tab.imageWidth;
  const imgHeight = isPreview ? renderedSize : tab.imageHeight;
  const imgX = tab.panX + (isPreview ? previewOffsetX * tab.zoom : 0);
  const imgY = tab.panY + (isPreview ? previewOffsetY * tab.zoom : 0);

  return (
    <div className="image-view" ref={containerRef} onPointerDown={onPointerDown}>
      {hasContent && (
        <img
          className="image-view-img"
          src={src}
          alt=""
          draggable={false}
          style={{
            transform: `translate3d(${imgX}px, ${imgY}px, 0) scale(${tab.zoom})`,
            transformOrigin: "0 0",
            width: imgWidth,
            height: imgHeight,
          }}
        />
      )}
      {!hasContent && (
        <div className="image-view-loading">読み込み中…</div>
      )}
    </div>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

function computeInitialFit(
  imgW: number,
  imgH: number,
  vpW: number,
  vpH: number
) {
  const fitZoom = Math.min(vpW / imgW, vpH / imgH);
  const zoom = Math.min(1.0, fitZoom);
  const renderedW = imgW * zoom;
  const renderedH = imgH * zoom;
  return {
    zoom,
    panX: (vpW - renderedW) / 2,
    panY: (vpH - renderedH) / 2,
  };
}

function clampPan(
  panX: number,
  panY: number,
  renderedW: number,
  renderedH: number,
  vpW: number,
  vpH: number
) {
  const nx =
    renderedW < vpW ? (vpW - renderedW) / 2 : clamp(panX, vpW - renderedW, 0);
  const ny =
    renderedH < vpH ? (vpH - renderedH) / 2 : clamp(panY, vpH - renderedH, 0);
  return { panX: nx, panY: ny };
}

