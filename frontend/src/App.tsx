import { useCallback, useEffect, useState } from "react";
import {
  WindowGetSize,
  WindowGetPosition,
} from "../wailsjs/runtime/runtime";
import { ClassificationView } from "./features/classification/ClassificationView";
import { useClassification } from "./features/classification/useClassification";
import { ViewerGrid } from "./features/viewer-grid/ViewerGrid";
import { useViewerGrid, type Grid } from "./features/viewer-grid/useViewerGrid";
import { useSessionLoad } from "./features/session/useSessionLoad";
import { useSessionSave } from "./features/session/useSessionSave";
import { useConfirm } from "./shared/components/ConfirmDialog";
import { ToastProvider } from "./shared/components/Toast";
import { state } from "../wailsjs/go/models";
import "./App.css";

type TopTab = "list" | "viewer";

function App() {
  const { loaded, initialState } = useSessionLoad();
  if (!loaded) return null;
  return (
    <ToastProvider>
      <AppInner initialState={initialState} />
    </ToastProvider>
  );
}

type AppInnerProps = {
  initialState: state.StateData | null;
};

function AppInner({ initialState }: AppInnerProps) {
  const initGrid = initialState?.grid
    ? gridFromGridState(initialState.grid)
    : undefined;

  const initTopTab: TopTab =
    initialState?.topTab === "viewer" ? "viewer" : "list";
  const [topTab, setTopTab] = useState<TopTab>(initTopTab);

  const { confirm, dialog: confirmDialog } = useConfirm();
  const viewer = useViewerGrid({ initialGrid: initGrid, confirm });
  const classification = useClassification({
    initialList: initialState?.list ?? null,
    confirm,
  });

  // Window dimensions/position polling (Wails has no window-move event).
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

  useSessionSave({
    window: windowState,
    grid: viewer.grid,
    topTab,
    list: classification.persistableState,
  });

  const onSelectList = useCallback(() => setTopTab("list"), []);
  const onSelectViewer = useCallback(() => setTopTab("viewer"), []);

  // Open a list-tab image in the viewer's active panel and switch tabs.
  // The list view stays scrolled where it was so the user can come back.
  const onOpenInViewer = useCallback(
    (filename: string) => {
      const folder = classification.folderPath;
      if (!folder) return;
      void viewer.openInActive(`${folder}/${filename}`);
      setTopTab("viewer");
    },
    [classification.folderPath, viewer],
  );

  return (
    <div className="app-toplevel">
      <nav className="top-tabs" role="tablist" aria-label="トップレベルタブ">
        <button
          type="button"
          role="tab"
          aria-selected={topTab === "list"}
          className={`top-tab ${topTab === "list" ? "active" : ""}`}
          onClick={onSelectList}
        >
          一覧
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={topTab === "viewer"}
          className={`top-tab ${topTab === "viewer" ? "active" : ""}`}
          onClick={onSelectViewer}
        >
          ビューア
        </button>
      </nav>
      <div className="top-tab-content">
        {topTab === "list" ? (
          <ClassificationView
            state={classification}
            onOpenInViewer={onOpenInViewer}
          />
        ) : (
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
        )}
      </div>
      {confirmDialog}
    </div>
  );
}

// Convert Wails-generated GridState (persisted shape) to the runtime Grid type.
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
