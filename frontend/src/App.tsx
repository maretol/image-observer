import { useState, useRef, useCallback, useEffect } from "react";
import {
  WindowGetSize,
  WindowGetPosition,
} from "../wailsjs/runtime/runtime";
import { FolderPanel } from "./components/FolderPanel";
import { ViewerGrid } from "./components/ViewerGrid";
import { useViewerGrid, type Grid } from "./hooks/useViewerGrid";
import { useTree } from "./hooks/useTree";
import { useSessionLoad } from "./hooks/useSessionLoad";
import { useSessionSave } from "./hooks/useSessionSave";
import { state } from "../wailsjs/go/models";
import "./App.css";

function App() {
  const { loaded, initialState } = useSessionLoad();
  if (!loaded) return null;
  return <AppInner initialState={initialState} />;
}

type AppInnerProps = {
  initialState: state.StateData | null;
};

function AppInner({ initialState }: AppInnerProps) {
  const initLeftWidth = initialState?.leftPaneWidth ?? 280;
  const initRoot = initialState?.rootPath || null;
  const initGrid = initialState?.grid
    ? gridFromGridState(initialState.grid)
    : undefined;

  const [leftWidth, setLeftWidth] = useState(initLeftWidth);
  const draggingRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const tree = useTree({ initialRootPath: initRoot });
  const viewer = useViewerGrid({ initialGrid: initGrid });

  // Window dimensions/position — polled because Wails JS runtime has no
  // window-move event. Resize is handled via the browser event for snappiness.
  const [windowState, setWindowState] = useState({
    width: initialState?.window?.width ?? 1024,
    height: initialState?.window?.height ?? 768,
    x: initialState?.window?.x ?? -1,
    y: initialState?.window?.y ?? -1,
  });
  useEffect(() => {
    let cancelled = false;
    const update = async () => {
      try {
        const sz = await WindowGetSize();
        const pos = await WindowGetPosition();
        if (cancelled) return;
        setWindowState((cur) => {
          if (
            cur.width === sz.w &&
            cur.height === sz.h &&
            cur.x === pos.x &&
            cur.y === pos.y
          ) {
            return cur;
          }
          return { width: sz.w, height: sz.h, x: pos.x, y: pos.y };
        });
      } catch {
        // ignore — Wails runtime may not be ready briefly during startup
      }
    };
    const onResize = () => update();
    window.addEventListener("resize", onResize);
    const interval = window.setInterval(update, 2000);
    update();
    return () => {
      cancelled = true;
      window.removeEventListener("resize", onResize);
      window.clearInterval(interval);
    };
  }, []);

  // Persist to disk (debounced)
  useSessionSave({
    rootPath: tree.state.rootPath,
    leftPaneWidth: leftWidth,
    window: windowState,
    grid: viewer.grid,
  });

  const onMouseDown = useCallback(() => {
    draggingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const next = Math.min(Math.max(e.clientX - rect.left, 120), rect.width - 200);
      setLeftWidth(next);
    };
    const onUp = () => {
      draggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    const onResize = () => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      setLeftWidth((w) => Math.min(Math.max(w, 120), Math.max(rect.width - 200, 120)));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return (
    <div className="app" ref={containerRef}>
      <aside className="pane left" style={{ width: leftWidth }}>
        <FolderPanel onImageOpen={viewer.openInActive} />
      </aside>
      <div className="splitter" onMouseDown={onMouseDown} />
      <main className="pane right">
        <ViewerGrid
          grid={viewer.grid}
          onActivatePanel={viewer.setActivePanel}
          onSelectTab={viewer.setActiveTab}
          onCloseTab={viewer.closeTab}
          onUpdateTabState={viewer.updateTabState}
          onMoveTab={viewer.moveTab}
          onAddRow={viewer.addRow}
          onAddCol={viewer.addCol}
          onRemoveRow={viewer.removeRow}
          onRemoveCol={viewer.removeCol}
          onSetRowSizes={viewer.setRowSizes}
          onSetColSizes={viewer.setColSizes}
        />
      </main>
    </div>
  );
}

// Convert Wails-generated GridState (persisted shape) to the runtime Grid type.
// Tabs from disk are marked initialized=true so we use their saved zoom/pan
// directly. imageWidth/Height start at 0 and are filled by ImageView's first
// ReadImage; clampPan then runs to fix any out-of-range pan.
//
// If a saved zoom is non-positive (corruption), treat the tab as uninitialized
// so ImageView re-runs the initial fit.
function gridFromGridState(gs: state.GridState): Grid {
  return {
    size: { rows: gs.rows, cols: gs.cols },
    rowSizes: gs.rowSizes,
    colSizes: gs.colSizes,
    active: { row: gs.active.row, col: gs.active.col },
    panels: gs.panels.map((p: state.PanelState) => ({
      tabs: p.tabs.map((t: state.TabState) => ({
        path: t.path,
        zoom: t.zoom,
        panX: t.panX,
        panY: t.panY,
        initialized: t.zoom > 0,
        imageWidth: 0,
        imageHeight: 0,
      })),
      activeIndex: p.activeIndex,
    })),
  };
}

export default App;
