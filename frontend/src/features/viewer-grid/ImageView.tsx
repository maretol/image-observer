import { useCallback, useEffect, useRef, useState } from "react";
import { ReadImage } from "../../../wailsjs/go/main/App";
import { imgread } from "../../../wailsjs/go/models";
import type { Tab } from "./useTabs";
import { toDataURL } from "../../shared/utils/base64";
import { useToastFn } from "../../shared/components/Toast";

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8.0;
const ZOOM_STEP = 1.2;

type Props = {
  tab: Tab;
  tabIndex: number;
  onUpdateTabState: (index: number, patch: Partial<Tab>) => void;
};

export function ImageView({ tab, tabIndex, onUpdateTabState }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [imageData, setImageData] = useState<imgread.Result | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const toast = useToastFn();
  const dragRef = useRef<{
    startX: number;
    startY: number;
    startPanX: number;
    startPanY: number;
  } | null>(null);

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

  // Wheel zoom (cursor anchored). Attach as non-passive to allow preventDefault.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (e: WheelEvent) => {
      if (!tab.initialized) return;
      e.preventDefault();
      const rect = container.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      const newZoom = clamp(tab.zoom * factor, MIN_ZOOM, MAX_ZOOM);
      // Image-space pixel under cursor (pre-zoom)
      const px = (cx - tab.panX) / tab.zoom;
      const py = (cy - tab.panY) / tab.zoom;
      let newPanX = cx - px * newZoom;
      let newPanY = cy - py * newZoom;
      const renderedW = tab.imageWidth * newZoom;
      const renderedH = tab.imageHeight * newZoom;
      ({ panX: newPanX, panY: newPanY } = clampPan(
        newPanX,
        newPanY,
        renderedW,
        renderedH,
        rect.width,
        rect.height
      ));
      onUpdateTabState(tabIndex, {
        zoom: newZoom,
        panX: newPanX,
        panY: newPanY,
      });
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, [
    tab.zoom,
    tab.panX,
    tab.panY,
    tab.imageWidth,
    tab.imageHeight,
    tab.initialized,
    tabIndex,
    onUpdateTabState,
  ]);

  // Drag pan (left button only — leave right click for context menu)
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      if (!tab.initialized) return;
      e.preventDefault();
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        startPanX: tab.panX,
        startPanY: tab.panY,
      };
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
    },
    [tab.panX, tab.panY, tab.initialized]
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      let nx = dragRef.current.startPanX + (e.clientX - dragRef.current.startX);
      let ny = dragRef.current.startPanY + (e.clientY - dragRef.current.startY);
      const renderedW = tab.imageWidth * tab.zoom;
      const renderedH = tab.imageHeight * tab.zoom;
      ({ panX: nx, panY: ny } = clampPan(
        nx,
        ny,
        renderedW,
        renderedH,
        rect.width,
        rect.height
      ));
      onUpdateTabState(tabIndex, { panX: nx, panY: ny });
    };
    const onUp = () => {
      if (dragRef.current) {
        dragRef.current = null;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [tab.zoom, tab.imageWidth, tab.imageHeight, tabIndex, onUpdateTabState]);

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

  const src = toDataURL(
    imageData.data as unknown as number[] | string,
    imageData.mimeType
  );

  return (
    <div className="image-view" ref={containerRef} onMouseDown={onMouseDown}>
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

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}

function basename(p: string): string {
  const norm = p.replace(/[\\/]+$/, "");
  const idx = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}
