import { useCallback, useEffect, useState, type CSSProperties } from "react";
import {
  WindowGetSize,
  WindowGetPosition,
} from "../wailsjs/runtime/runtime";
import { ClassificationView } from "./features/classification/ClassificationView";
import { setKnownTagColors } from "./features/classification/colors";
import { useClassification } from "./features/classification/useClassification";
import { setThumbnailParams } from "./features/classification/useGridThumbnail";
import { ViewerGrid } from "./features/viewer-grid/ViewerGrid";
import {
  DEFAULT_MAX_PIXELS,
  useViewerGrid,
} from "./features/viewer-grid/useViewerGrid";
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
  // Apply tag-color and thumbnail params from settings as soon as they load.
  // These are module-level setters (not hook state) because the underlying
  // helpers — tagColor() / GetThumbnail() in useGridThumbnail's load() — are
  // called from leaf components and a context provider just to thread one
  // map / two scalars would be more noise than insight.
  useEffect(() => {
    if (!settings.data) return;
    setKnownTagColors(settings.data.tagColors);
    setThumbnailParams(settings.data.thumbnailSize, settings.data.thumbnailMode);
  }, [settings.data]);

  // maxImagePixelsMP is stored as MP (200 = 200_000_000 px). Convert once and
  // hand the raw pixel count to useViewerGrid, which clamps via a ref so
  // settings updates take effect on the next image open. Falls back to
  // DEFAULT_MAX_PIXELS (the canonical constant) during the brief settings-
  // loading window — keeping the fallback wired to a single source avoids
  // drift against useViewerGrid / Go's defaultMaxImagePixelsMP.
  const maxImagePixels =
    settings.data?.maxImagePixelsMP != null
      ? settings.data.maxImagePixelsMP * 1_000_000
      : DEFAULT_MAX_PIXELS;

  const viewer = useViewerGrid({
    initialLayout: initLayout,
    confirm,
    maxImagePixels,
  });
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

  // Global keybindings (Phase H4 + #7). Some are global (top-tab switch),
  // others are viewer-only. We bail early for editable targets / settings
  // dialog regardless of scope.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      if (settingsOpen) return; // dialog has its own Esc handler

      // Global top-tab switching (#7): Ctrl+Shift+1 → list, Ctrl+Shift+2 → viewer.
      // Works regardless of which tab is active so the user can return to either.
      // Picked Ctrl+Shift+<digit> to avoid colliding with Ctrl+0/1 (zoom) and
      // browser-instinct Ctrl+Tab (in-viewer tab cycling).
      //
      // We match on `e.code` (layout-independent physical key) rather than
      // `e.key` because Shift modifies the latter to the shifted character
      // ("!" / "@" on US, "!" / "\"" on JIS), so `e.key === "1"` would never
      // fire here.
      if (isPrimaryModifier(e) && e.shiftKey) {
        if (e.code === "Digit1") {
          e.preventDefault();
          setTopTab("list");
          return;
        }
        if (e.code === "Digit2") {
          e.preventDefault();
          setTopTab("viewer");
          return;
        }
      }

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

  // UI scale (#10 + #12): apply as CSS `zoom` on the app root so font, button,
  // and input sizes scale uniformly. `zoom` is non-standard but supported in
  // both WebView2 (Windows release target) and WebKitGTK (dev).
  //
  // Note: `zoom` cascades to ALL descendants, including the <img> inside
  // ImageView — viewer zoom and UI scale multiply. That is intentional for
  // v1 (a uniform "make everything larger" knob); if we ever want UI-only
  // scaling we'd need to move the zoom down to chrome-only containers
  // (top-tabs / settings dialog / classification view) and leave ViewerGrid
  // at zoom: 1.
  //
  // During the brief settings-loading window the zoom stays at 1.0 (rather
  // than flickering) — once settings.data resolves the value snaps to user
  // choice.
  const uiZoom =
    settings.data?.uiScalePercent != null
      ? settings.data.uiScalePercent / 100
      : 1;

  return (
    <div
      className="app-toplevel"
      style={{ zoom: uiZoom } as CSSProperties}
    >
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
