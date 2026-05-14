import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReadImage } from "../../../wailsjs/go/main/App";
import { imgread } from "../../../wailsjs/go/models";
import type { Tab } from "./useTabs";
import { toDataURL } from "../../shared/utils/base64";
import { pushBodyStyle } from "../../shared/utils/bodyStyles";
import { useToastFn } from "../../shared/components/Toast";
import { errorMessage } from "../../shared/utils/error";
import { zoomCommandBus, type ZoomCommand } from "../../shared/utils/keybindings";
import { basename } from "../../shared/utils/path";

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

  // Fetch image when path changes
  useEffect(() => {
    let cancelled = false;
    setImageData(null);
    setLoadError(null);
    ReadImage(tab.path)
      .then((res) => {
        if (cancelled) return;
        setImageData(res);
        if (tab.imageWidth !== res.width || tab.imageHeight !== res.height) {
          onUpdateTabState(tabIndex, {
            imageWidth: res.width,
            imageHeight: res.height,
          });
        }
      })
      .catch((e) => {
        if (cancelled) return;
        const msg = errorMessage(e);
        setLoadError(msg);
        toast(`画像読み込みに失敗: ${basename(tab.path)} — ${msg}`, "error");
      });
    return () => {
      cancelled = true;
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

  const src = useMemo(
    () =>
      imageData
        ? toDataURL(
            imageData.data as unknown as number[] | string,
            imageData.mimeType
          )
        : "",
    [imageData]
  );

  if (loadError) {
    return (
      <div className="image-view" ref={containerRef}>
        <div className="image-view-error">読み込み失敗: {loadError}</div>
      </div>
    );
  }
  if (!imageData) {
    return (
      <div className="image-view" ref={containerRef}>
        <div className="image-view-loading">読み込み中…</div>
      </div>
    );
  }

  return (
    <div className="image-view" ref={containerRef} onPointerDown={onPointerDown}>
      {tab.initialized && (
        <img
          className="image-view-img"
          src={src}
          alt=""
          draggable={false}
          style={{
            transform: `translate3d(${tab.panX}px, ${tab.panY}px, 0) scale(${tab.zoom})`,
            transformOrigin: "0 0",
            width: tab.imageWidth,
            height: tab.imageHeight,
          }}
        />
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

