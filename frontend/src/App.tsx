import { useCallback, useEffect, useState } from "react";
import {
  WindowGetSize,
  WindowGetPosition,
} from "../wailsjs/runtime/runtime";
import { ClassificationView } from "./features/classification/ClassificationView";
import { useClassification } from "./features/classification/useClassification";
import { ViewerGrid } from "./features/viewer-grid/ViewerGrid";
import { useViewerGrid } from "./features/viewer-grid/useViewerGrid";
import {
  deserializeLayout,
  type Layout,
  type LayoutNodeState,
} from "./features/viewer-grid/layout";
import { useSessionLoad } from "./features/session/useSessionLoad";
import { useSessionSave } from "./features/session/useSessionSave";
import { SettingsDialog } from "./features/settings/SettingsDialog";
import { useSettings } from "./features/settings/useSettings";
import { useConfirm } from "./shared/components/ConfirmDialog";
import { ToastProvider } from "./shared/components/Toast";
import { SettingsIcon } from "./shared/icons/SettingsIcon";
import { installGlobalErrorHandlers, logger } from "./shared/utils/logger";
import {
  isEditableTarget,
  isPrimaryModifier,
  zoomCommandBus,
} from "./shared/utils/keybindings";
import { findLeaf } from "./features/viewer-grid/layout";
import { GetLogPath } from "../wailsjs/go/main/App";
import { state } from "../wailsjs/go/models";
import "./App.css";

// Hook into uncaught errors and rejections once, before React mounts.
installGlobalErrorHandlers();
logger.info("app", "frontend mount");

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
  const initLayout = initialState?.layout
    ? layoutFromState(initialState.layout)
    : undefined;

  const initTopTab: TopTab =
    initialState?.topTab === "viewer" ? "viewer" : "list";
  const [topTab, setTopTab] = useState<TopTab>(initTopTab);

  const settings = useSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [logPath, setLogPath] = useState("");
  useEffect(() => {
    GetLogPath()
      .then(setLogPath)
      .catch(() => setLogPath(""));
  }, []);

  const { confirm, dialog: confirmDialog } = useConfirm();
  const viewer = useViewerGrid({ initialLayout: initLayout, confirm });
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
    const POLL_INTERVAL_MS = 2000;
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
          const next = { width: sz.w, height: sz.h, x: pos.x, y: pos.y };
          logger.debug("session", "window pos/size changed", next);
          return next;
        });
      } catch {
        // ignore — Wails runtime may not be ready briefly during startup
      }
    };
    const onResize = () => update();
    window.addEventListener("resize", onResize);
    const interval = window.setInterval(update, POLL_INTERVAL_MS);
    logger.debug("session", "window pos/size polling started", {
      intervalMs: POLL_INTERVAL_MS,
    });
    update();
    return () => {
      cancelled = true;
      window.removeEventListener("resize", onResize);
      window.clearInterval(interval);
    };
  }, []);

  useSessionSave({
    window: windowState,
    layout: viewer.layout,
    topTab,
    list: classification.persistableState,
  });

  // Global keybindings (Phase H4). Active only on the viewer tab and when
  // the user is not typing in a form field / settings dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      if (settingsOpen) return; // dialog has its own Esc handler
      if (topTab !== "viewer") return;

      const layout = viewer.layout;
      const activeLeaf = findLeaf(layout.root, layout.activeId);
      if (!activeLeaf) return;

      if (!isPrimaryModifier(e)) return;

      // Ctrl+W: close active tab
      if ((e.key === "w" || e.key === "W") && !e.shiftKey) {
        e.preventDefault();
        if (activeLeaf.activeIndex >= 0) {
          viewer.closeTab(activeLeaf.id, activeLeaf.activeIndex);
        }
        return;
      }
      // Ctrl+Tab / Ctrl+Shift+Tab: cycle tabs in active panel
      if (e.key === "Tab") {
        e.preventDefault();
        const n = activeLeaf.tabs.length;
        if (n <= 1) return;
        const dir = e.shiftKey ? -1 : 1;
        const next = (((activeLeaf.activeIndex + dir) % n) + n) % n;
        viewer.setActiveTab(activeLeaf.id, next);
        return;
      }
      // Ctrl+0: fit to viewport
      if (e.key === "0") {
        e.preventDefault();
        zoomCommandBus.emit("fit");
        return;
      }
      // Ctrl+1: actual size (100%)
      if (e.key === "1") {
        e.preventDefault();
        zoomCommandBus.emit("actualSize");
        return;
      }
      // Ctrl+= / Ctrl++ : zoom in (also accept "+" shifted)
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        zoomCommandBus.emit("in");
        return;
      }
      // Ctrl+- : zoom out
      if (e.key === "-") {
        e.preventDefault();
        zoomCommandBus.emit("out");
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [topTab, settingsOpen, viewer]);

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

  // Bulk-open: append all selected images as new tabs in the active panel.
  const onOpenManyInTabs = useCallback(
    (filenames: string[]) => {
      const folder = classification.folderPath;
      if (!folder || filenames.length === 0) return;
      const paths = filenames.map((f) => `${folder}/${f}`);
      void viewer.openManyInActive(paths);
      setTopTab("viewer");
    },
    [classification.folderPath, viewer],
  );

  // Bulk-open: split the active panel for each selected image so each gets
  // its own panel. Skips oversized images and stops at MAX_PANELS.
  const onOpenManyAsSplit = useCallback(
    (filenames: string[]) => {
      const folder = classification.folderPath;
      if (!folder || filenames.length === 0) return;
      const paths = filenames.map((f) => `${folder}/${f}`);
      void viewer.openManyAsSplit(paths);
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
        <button
          type="button"
          className="top-tab-settings"
          onClick={() => setSettingsOpen(true)}
          title="設定"
          aria-label="設定を開く"
        >
          <SettingsIcon />
        </button>
      </nav>
      <div className="top-tab-content">
        {topTab === "list" ? (
          <ClassificationView
            state={classification}
            multiSelectMode={settings.data?.multiSelectMode}
            onOpenInViewer={onOpenInViewer}
            onOpenManyInTabs={onOpenManyInTabs}
            onOpenManyAsSplit={onOpenManyAsSplit}
          />
        ) : (
          <ViewerGrid
            layout={viewer.layout}
            wheelMode={settings.data?.wheelMode}
            onActivatePanel={viewer.setActivePanel}
            onSelectTab={viewer.setActiveTab}
            onCloseTab={viewer.closeTab}
            onUpdateTabState={viewer.updateTabState}
            onMoveTab={viewer.moveTab}
            onReorderTab={viewer.reorderTab}
            onSplitTab={viewer.splitTab}
            onSplitFromContext={viewer.splitFromContext}
            onSetSplitRatio={viewer.setSplitRatio}
          />
        )}
      </div>
      <SettingsDialog
        open={settingsOpen}
        data={settings.data}
        loading={settings.loading}
        error={settings.error}
        logPath={logPath}
        onChange={(patch) => void settings.update(patch)}
        onReset={() => void settings.reset()}
        onClose={() => setSettingsOpen(false)}
      />
      {confirmDialog}
    </div>
  );
}

// Convert Wails-generated LayoutState (persisted shape) to the runtime Layout.
// The Wails `state.LayoutState` shape matches our `LayoutNodeState`, so we
// can hand it straight to `deserializeLayout`.
function layoutFromState(ls: state.LayoutState): Layout {
  return deserializeLayout({
    root: ls.root as unknown as LayoutNodeState,
    activeId: ls.activeId,
  });
}

export default App;
