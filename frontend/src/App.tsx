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
import { useTaskbarViewerSwitch } from "./useTaskbarViewerSwitch";
import type { TopTab } from "./topTab";
import { GetLogPath } from "../wailsjs/go/main/App";
import type { state } from "../wailsjs/go/models";
import "./App.css";

// トップレベルのオーケストレータ。state hub を持ち子フック / 子 UI に配線する。
// インライン副作用フック (settings → タグ色 / サムネイル / --ui-scale 等) を残して
// いるのは、各 5 行以下でフック化すると間接コストのほうが大きいため。

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
  // module レベル setter なのは、下請け (tagColor / GetThumbnail) が leaf から
  // 呼ばれるためで、map 1 つ / scalar 2 つのために context provider を挟むより軽い。
  useEffect(() => {
    if (!settings.data) return;
    setKnownTagColors(settings.data.tagColors);
    setThumbnailParams(settings.data.thumbnailSize, settings.data.thumbnailMode);
  }, [settings.data]);

  // MP 単位で保存 (200 = 200_000_000 px)。ref 経由で clamp するので設定変更は次の
  // 画像オープンから効く。ロード中の一瞬は DEFAULT_MAX_PIXELS。
  const maxImagePixels =
    settings.data?.maxImagePixelsMP != null
      ? settings.data.maxImagePixelsMP * 1_000_000
      : DEFAULT_MAX_PIXELS;

  // タブ追加上限 (#148)。ロード中の一瞬は既定 MAX_VIEWERS。追加時 gate のみなので、
  // 上限超の復元 session でも viewer は閉じられない (spec-viewer-max-count.md D2)。
  const maxViewers = settings.data?.maxViewers ?? MAX_VIEWERS;

  const viewer = useViewerSet({
    initialSet,
    maxImagePixels,
    maxViewers,
  });
  const classification = useClassification({
    initialList: initialState?.list ?? null,
    confirm,
    watchMode: settings.data?.watchMode,
    duplicateDetectMode: settings.data?.duplicateDetectMode,
    duplicateThreshold: settings.data?.duplicateThreshold,
  });

  // 一覧タブのスクロール位置 (#40)。"viewer" 切替で ClassificationView が unmount
  // されてもまたいで保持するためここが持つ。state.json には永続化しない。
  const listScrollTopRef = useRef(0);

  const windowState = useWindowGeometryPolling({ initial: initialState?.window });

  useSessionSave({
    window: windowState,
    viewers: viewer.viewers,
    activeViewerId: viewer.activeViewerId,
    topTab,
    list: classification.persistableState,
  });

  useGlobalKeybindings({
    topTab,
    setTopTab,
    viewer,
    settingsOpen,
    listReorderMode: classification.reorderMode,
  });

  // タスクバーサムネイルツールバーの ◀▶ (#149)。非 Windows では Go 側がイベントを
  // emit しないだけでリスナ登録自体は無害。gate はキーバインドのタブ切替と同一。
  useTaskbarViewerSwitch({
    topTab,
    setTopTab,
    viewer,
    settingsOpen,
    listReorderMode: classification.reorderMode,
  });

  const onSelectList = useCallback(() => setTopTab("list"), []);
  const onSelectViewer = useCallback(
    (viewerId: string) => {
      viewer.setActiveViewer(viewerId);
      setTopTab("viewer");
    },
    [viewer],
  );

  // viewer.viewers は layout 変更だけでも新しい配列 identity になるため、参照でメモ
  // 化すると毎 render で子へ新リストを渡してしまう。内容シグネチャ (id:name) でメモ
  // 化して純粋な layout 変更をまたいで安定させる。
  const viewerSig = viewer.viewers.map((v) => `${v.id}:${v.name}`).join("|");
  const viewerList = useMemo(
    () => viewer.viewers.map((v) => ({ id: v.id, name: v.name })),
    // viewerSig は毎 render 再計算するが安価 (≤8)。同じ文字列なら useMemo が再利用。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewerSig],
  );

  const onAddViewer = useCallback(() => {
    viewer.addViewer();
    setTopTab("viewer");
  }, [viewer]);

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

  // UI スケール (#10, #12, #39)。--ui-scale を <html> に公開し、App.css が chrome
  // コンテナにだけ zoom を適用する。
  useLayoutEffect(() => {
    const scale = (settings.data?.uiScalePercent ?? 100) / 100;
    document.documentElement.style.setProperty("--ui-scale", String(scale));
  }, [settings.data?.uiScalePercent]);

  // トップタブのビューア並べ替え DnD (#50, docs/spec-viewer-tab-reorder.md)。
  // TopTabsBar 内でなくここでフックを呼ぶのは、count / onReorder クロージャを
  // ビューアセットのライフサイクルに繋いで生かすため。
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
        maxViewers={maxViewers}
        interactionDisabled={classification.reorderMode}
      />
      <div className="top-tab-content">
        {topTab === "list" ? (
          <ClassificationView
            state={classification}
            multiSelectMode={settings.data?.multiSelectMode}
            editAutoSave={settings.data?.editAutoSave}
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
            // key でビューア変更時に remount を強制し、ImageView cleanup が
            // zoomCommandBus から de-register する機会を作る。リスナ引き継ぎを
            // 決定的に保つ (spec-multi-viewer.md §6.2)。
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
