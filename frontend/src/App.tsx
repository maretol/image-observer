import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ClassificationView } from "./features/classification/ClassificationView";
import { setKnownTagColors } from "./features/classification/colors";
import { useClassification } from "./features/classification/useClassification";
import { setThumbnailParams } from "./features/classification/useGridThumbnail";
import { ViewerGrid } from "./features/viewer-grid/ViewerGrid";
import {
  DEFAULT_MAX_PIXELS,
  MAX_VIEWERS,
  useViewerSet,
} from "./features/viewer-grid/useViewerSet";
import {
  countLeafTabs,
  hydrateInitialViewerSet,
  type ViewerSet,
} from "./features/viewer-grid/viewers";
import { useViewerRename } from "./features/viewer-grid/useViewerRename";
import { useListToViewerHandlers } from "./features/viewer-grid/useListToViewerHandlers";
import { useViewerTabReorder } from "./features/viewer-grid/useViewerTabReorder";
import { useSessionLoad } from "./features/session/useSessionLoad";
import { useSessionSave } from "./features/session/useSessionSave";
import { useWindowGeometryPolling } from "./features/session/useWindowGeometryPolling";
import { SettingsDialog } from "./features/settings/SettingsDialog";
import { useSettings } from "./features/settings/useSettings";
import { useConfirm } from "./shared/components/ConfirmDialog";
import { ToastProvider } from "./shared/components/Toast";
import { installGlobalErrorHandlers, logger } from "./shared/utils/logger";
import { TopTabsBar } from "./TopTabsBar";
import { useGlobalKeybindings } from "./useGlobalKeybindings";
import type { TopTab } from "./topTab";
import { GetLogPath } from "../wailsjs/go/main/App";
import type { state } from "../wailsjs/go/models";
import "./App.css";

// App.tsx — top-level orchestrator. Hydrates persisted state, owns the cross-
// feature state hubs (topTab / viewer / classification / settings / confirm /
// window geometry), wires them into the child hooks (useGlobalKeybindings /
// useWindowGeometryPolling / useViewerRename / useListToViewerHandlers /
// useViewerTabReorder / useSessionSave) and the child UI (TopTabsBar /
// ClassificationView / ViewerGrid / SettingsDialog).
//
// Inline side-effect hooks kept here (settings → tag colors / thumbnail
// params / --ui-scale, GetLogPath fetch) are <= 5 lines each — abstracting
// them into a hook would cost more in indirection than it would save.

// Hook into uncaught errors and rejections once, before React mounts.
installGlobalErrorHandlers();
logger.info("app", "frontend mount");

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
  const initialSet = useMemo<ViewerSet>(
    () => hydrateInitialViewerSet(initialState),
    [initialState],
  );

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
  // hand the raw pixel count to useViewerSet, which clamps via a ref so
  // settings updates take effect on the next image open. Falls back to
  // DEFAULT_MAX_PIXELS during the brief settings-loading window.
  const maxImagePixels =
    settings.data?.maxImagePixelsMP != null
      ? settings.data.maxImagePixelsMP * 1_000_000
      : DEFAULT_MAX_PIXELS;

  const viewer = useViewerSet({
    initialSet,
    maxImagePixels,
  });
  const classification = useClassification({
    initialList: initialState?.list ?? null,
    confirm,
    watchMode: settings.data?.watchMode,
  });

  // List-tab scroll position (#40). Owned here so it survives the
  // ClassificationView unmount that happens when the top tab switches to
  // "viewer". ClassificationView restores from this on mount and writes back
  // on scroll; folder changes inside ClassificationView reset it to 0.
  // Intentionally not persisted to settings/state.json.
  const listScrollTopRef = useRef(0);

  const windowState = useWindowGeometryPolling({ initial: initialState?.window });

  useSessionSave({
    window: windowState,
    viewers: viewer.viewers,
    activeViewerId: viewer.activeViewerId,
    topTab,
    list: classification.persistableState,
  });

  useGlobalKeybindings({ topTab, setTopTab, viewer, settingsOpen });

  const onSelectList = useCallback(() => setTopTab("list"), []);
  const onSelectViewer = useCallback(
    (viewerId: string) => {
      viewer.setActiveViewer(viewerId);
      setTopTab("viewer");
    },
    [viewer],
  );

  // Stable id+name list for child props. `viewer.viewers` gets a fresh array
  // identity on every layout-only mutation (updateViewerLayout maps over the
  // array even when only one viewer's layout changed), so memoizing on its
  // reference would recompute every render and hand a new list to children.
  // Memo on a primitive content signature instead so the result is stable
  // across pure layout changes — picked up automatically by any future
  // React.memo-wrapped consumer.
  const viewerSig = viewer.viewers.map((v) => `${v.id}:${v.name}`).join("|");
  const viewerList = useMemo(
    () => viewer.viewers.map((v) => ({ id: v.id, name: v.name })),
    // viewerSig is recomputed every render but cheap (≤8 viewers). useMemo
    // sees the same string and reuses the cached array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewerSig],
  );

  const onAddViewer = useCallback(() => {
    viewer.addViewer();
    setTopTab("viewer");
  }, [viewer]);

  // closeViewerWithConfirm gates the close on a user confirm dialog when the
  // viewer has any image tabs. Empty viewers (root leaf with 0 tabs) close
  // immediately. Always refuses the last-remaining viewer.
  const closeViewerWithConfirm = useCallback(
    async (viewerId: string) => {
      if (viewer.viewers.length <= 1) return;
      const target = viewer.viewers.find((v) => v.id === viewerId);
      if (!target) return;
      const tabCount = countLeafTabs(target);
      if (tabCount > 0) {
        const ok = await confirm(
          `ビューア "${target.name}" を閉じますか?\n${tabCount} 個のタブが破棄されます。`,
        );
        if (!ok) return;
      }
      viewer.closeViewer(viewerId);
    },
    [confirm, viewer],
  );

  const { editingViewerId, startRename, stopRename, commitRename } =
    useViewerRename({ renameViewer: viewer.renameViewer });

  const { onOpenInViewer, onOpenManyInTabs, onOpenManyAsSplit } =
    useListToViewerHandlers({
      folderPath: classification.folderPath,
      viewer,
      setTopTab,
    });

  // UI scale (#10, #12, #39): expose the user's choice as a `--ui-scale` CSS
  // variable on <html>; App.css then applies `zoom: var(--ui-scale)` to
  // chrome containers only.
  useLayoutEffect(() => {
    const scale = (settings.data?.uiScalePercent ?? 100) / 100;
    document.documentElement.style.setProperty("--ui-scale", String(scale));
  }, [settings.data?.uiScalePercent]);

  // Top-tab viewer reorder DnD (#50, docs/spec-viewer-tab-reorder.md). The
  // hook owns pointer state + body-style stack; we hand it down to TopTabsBar
  // which binds containerRef + reads `state` for the indicator / source-tab
  // dimming. Calling the hook here (not inside TopTabsBar) keeps it tied to
  // the viewer-set lifecycle so the count / onReorder closure stay live.
  const tabReorder = useViewerTabReorder({
    count: viewer.viewers.length,
    onReorder: viewer.reorderViewer,
  });

  return (
    <div className="app-toplevel">
      <TopTabsBar
        topTab={topTab}
        onSelectList={onSelectList}
        viewers={viewer.viewers}
        activeViewerId={viewer.activeViewerId}
        editingViewerId={editingViewerId}
        onSelectViewer={onSelectViewer}
        onStartRename={startRename}
        onCommitRename={commitRename}
        onCancelRename={stopRename}
        onCloseViewer={(viewerId) => void closeViewerWithConfirm(viewerId)}
        reorder={tabReorder}
        onAddViewer={onAddViewer}
        onOpenSettings={() => setSettingsOpen(true)}
        maxViewers={MAX_VIEWERS}
      />
      <div className="top-tab-content">
        {topTab === "list" ? (
          <ClassificationView
            state={classification}
            multiSelectMode={settings.data?.multiSelectMode}
            scrollTopRef={listScrollTopRef}
            viewers={viewerList}
            activeViewerId={viewer.activeViewerId}
            onOpenInViewer={onOpenInViewer}
            onOpenManyInTabs={onOpenManyInTabs}
            onOpenManyAsSplit={onOpenManyAsSplit}
            onAfterDelete={viewer.closeTabsForPath}
          />
        ) : (
          <ViewerGrid
            // The key forces unmount/remount when the active viewer
            // changes, which gives ImageView's effect cleanup a chance to
            // de-register from zoomCommandBus and clears any per-panel
            // local state. Keeps the listener takeover deterministic
            // (spec-multi-viewer.md §6.2).
            key={viewer.activeViewerId}
            layout={viewer.layout}
            wheelMode={settings.data?.wheelMode}
            viewers={viewerList}
            currentViewerId={viewer.activeViewerId}
            onActivatePanel={viewer.setActivePanel}
            onSelectTab={viewer.setActiveTab}
            onCloseTab={viewer.closeTab}
            onUpdateTabState={viewer.updateTabState}
            onMoveTab={viewer.moveTab}
            onReorderTab={viewer.reorderTab}
            onSplitTab={viewer.splitTab}
            onSplitFromContext={viewer.splitFromContext}
            onSetSplitRatio={viewer.setSplitRatio}
            onMoveTabToViewer={viewer.moveTabToViewer}
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

export default App;
