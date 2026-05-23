import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
  type Viewer,
  type ViewerSet,
} from "./features/viewer-grid/viewers";
import { useViewerRename } from "./features/viewer-grid/useViewerRename";
import {
  DATA_VIEWER_TAB,
  useViewerTabReorder,
} from "./features/viewer-grid/useViewerTabReorder";
import { useSessionLoad } from "./features/session/useSessionLoad";
import { useSessionSave } from "./features/session/useSessionSave";
import { useWindowGeometryPolling } from "./features/session/useWindowGeometryPolling";
import { SettingsDialog } from "./features/settings/SettingsDialog";
import { useSettings } from "./features/settings/useSettings";
import { useConfirm } from "./shared/components/ConfirmDialog";
import { ToastProvider } from "./shared/components/Toast";
import { CloseIcon } from "./shared/icons/CloseIcon";
import { PlusIcon } from "./shared/icons/PlusIcon";
import { SettingsIcon } from "./shared/icons/SettingsIcon";
import { installGlobalErrorHandlers, logger } from "./shared/utils/logger";
import { useGlobalKeybindings } from "./useGlobalKeybindings";
import type { TopTab } from "./topTab";
import { GetLogPath } from "../wailsjs/go/main/App";
import { state } from "../wailsjs/go/models";
import "./App.css";

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

  // ─── viewer add/close/rename ───────────────────────────────────────

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

  // ─── list → viewer wiring (single + bulk) ──────────────────────────

  // openInViewer: from SampleModal's viewer-picker. We switch top-tab and
  // active viewer to the chosen one before delegating the actual open.
  const onOpenInViewer = useCallback(
    (viewerId: string, filename: string) => {
      const folder = classification.folderPath;
      if (!folder) return;
      void viewer.openInViewer(viewerId, `${folder}/${filename}`);
      viewer.setActiveViewer(viewerId);
      setTopTab("viewer");
    },
    [classification.folderPath, viewer],
  );

  const onOpenManyInTabs = useCallback(
    (viewerId: string, filenames: string[]) => {
      const folder = classification.folderPath;
      if (!folder || filenames.length === 0) return;
      const paths = filenames.map((f) => `${folder}/${f}`);
      void viewer.openManyInViewer(viewerId, paths);
      viewer.setActiveViewer(viewerId);
      setTopTab("viewer");
    },
    [classification.folderPath, viewer],
  );

  const onOpenManyAsSplit = useCallback(
    (viewerId: string, filenames: string[]) => {
      const folder = classification.folderPath;
      if (!folder || filenames.length === 0) return;
      const paths = filenames.map((f) => `${folder}/${f}`);
      void viewer.openManyAsSplitInViewer(viewerId, paths);
      viewer.setActiveViewer(viewerId);
      setTopTab("viewer");
    },
    [classification.folderPath, viewer],
  );

  // UI scale (#10, #12, #39): expose the user's choice as a `--ui-scale` CSS
  // variable on <html>; App.css then applies `zoom: var(--ui-scale)` to
  // chrome containers only.
  useLayoutEffect(() => {
    const scale = (settings.data?.uiScalePercent ?? 100) / 100;
    document.documentElement.style.setProperty("--ui-scale", String(scale));
  }, [settings.data?.uiScalePercent]);

  // Top-tab viewer reorder DnD (#50, docs/spec-viewer-tab-reorder.md). The
  // hook owns pointer state + body-style stack; we just feed it the count
  // and a commit callback. `containerRef` is bound to .top-tabs-viewers so
  // the hook can collect tab rects via DATA_VIEWER_TAB.
  const tabReorder = useViewerTabReorder({
    count: viewer.viewers.length,
    onReorder: viewer.reorderViewer,
  });
  // Indicator and dragSource visibility key off the same state. Only show
  // them once the drag has crossed the threshold (active) so a normal click
  // doesn't briefly flash the indicator.
  const dragActive = tabReorder.state?.active ?? false;
  const dragSrcIdx = dragActive ? (tabReorder.state?.srcIdx ?? -1) : -1;
  const dragInsertIdx = dragActive ? (tabReorder.state?.insertIdx ?? -1) : -1;

  return (
    <div className="app-toplevel">
      <nav className="top-tabs" role="tablist" aria-label="トップレベルタブ">
        <button
          type="button"
          role="tab"
          aria-selected={topTab === "list"}
          className={`top-tab top-tab-list ${topTab === "list" ? "active" : ""}`}
          onClick={onSelectList}
        >
          一覧
        </button>
        <div
          className="top-tabs-viewers"
          role="group"
          aria-label="ビューア一覧"
          ref={tabReorder.containerRef}
        >
          {viewer.viewers.map((v, i) => (
            <Fragment key={v.id}>
              {dragInsertIdx === i && (
                <span className="viewer-tab-insert-indicator" aria-hidden="true" />
              )}
              <ViewerTab
                index={i}
                viewer={v}
                isActive={topTab === "viewer" && v.id === viewer.activeViewerId}
                isEditing={editingViewerId === v.id}
                // anyRenaming gates drag-start on *any* tab while a rename
                // session is open. Without it a pointerdown on a sibling tab
                // would start a drag (its own isEditing is false) while the
                // rename input keeps focus thanks to our preventDefault(),
                // letting the user reorder behind a still-open editor.
                anyRenaming={editingViewerId !== null}
                isDragSource={dragSrcIdx === i}
                canClose={viewer.viewers.length > 1}
                onActivate={() => onSelectViewer(v.id)}
                onStartRename={() => startRename(v.id)}
                onCommitRename={(name) => commitRename(v.id, name)}
                onCancelRename={stopRename}
                onClose={() => void closeViewerWithConfirm(v.id)}
                onStartDrag={tabReorder.startDrag}
                shouldSuppressClick={tabReorder.shouldSuppressClick}
              />
            </Fragment>
          ))}
          {dragInsertIdx === viewer.viewers.length && (
            <span className="viewer-tab-insert-indicator" aria-hidden="true" />
          )}
        </div>
        <button
          type="button"
          className="top-tab-add"
          onClick={onAddViewer}
          disabled={viewer.viewers.length >= MAX_VIEWERS}
          title={
            viewer.viewers.length >= MAX_VIEWERS
              ? `ビューア数の上限 (${MAX_VIEWERS}) に達しています`
              : "新しいビューアを追加"
          }
          aria-label="ビューアを追加"
        >
          <PlusIcon />
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

// ─── ViewerTab (top-tab UI per viewer) ───────────────────────────────

type ViewerTabProps = {
  // index is the position of this tab in viewer.viewers — passed to the
  // reorder hook so it can compute moveViewer's fromIdx (#50).
  index: number;
  viewer: Viewer;
  isActive: boolean;
  isEditing: boolean;
  // anyRenaming = true while *any* viewer tab has an open rename input.
  // We block drag-start on every tab in that state so a sibling drag can't
  // proceed while the rename editor is still focused (#50).
  anyRenaming: boolean;
  // isDragSource = true while this tab is being dragged. Used to dim the
  // source (.dragging className) so the user can tell where they grabbed
  // from while the indicator shows the drop position.
  isDragSource: boolean;
  canClose: boolean;
  onActivate: () => void;
  onStartRename: () => void;
  onCommitRename: (name: string) => void;
  onCancelRename: () => void;
  onClose: () => void;
  onStartDrag: (
    idx: number,
    ev: { clientX: number; clientY: number; pointerId: number },
  ) => void;
  shouldSuppressClick: () => boolean;
};

function ViewerTab({
  index,
  viewer,
  isActive,
  isEditing,
  anyRenaming,
  isDragSource,
  canClose,
  onActivate,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onClose,
  onStartDrag,
  shouldSuppressClick,
}: ViewerTabProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  // #53: wrapper の padding 領域クリックでも focus を一覧タブ (タブ全体が
  // <button>) と同じく「選択中のタブにフォーカスが乗る」状態に揃えるため、
  // wrapper onClick から内側 name button を focus する用の ref。
  const nameButtonRef = useRef<HTMLButtonElement>(null);
  // Esc cancellation suppresses the blur-commit that would otherwise fire
  // when isEditing flips false → the input unmounts while focused → React
  // dispatches blur synchronously on the unmounting node, calling
  // onCommitRename with the (unwanted) draft value. The flag is set in the
  // Esc keydown handler before we trigger the unmount path.
  const suppressBlurRef = useRef(false);

  // On entering edit mode, focus + select the input. Run on transitions only
  // (when isEditing flips true), which is what the dependency array gives us.
  useEffect(() => {
    if (isEditing) {
      suppressBlurRef.current = false; // reset for the new edit session
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  if (isEditing) {
    return (
      <span className={`top-tab top-tab-viewer ${isActive ? "active" : ""}`}>
        <input
          ref={inputRef}
          type="text"
          className="top-tab-rename-input"
          defaultValue={viewer.name}
          maxLength={32}
          onBlur={(e) => {
            if (suppressBlurRef.current) {
              // Esc-triggered teardown — keep the original name.
              suppressBlurRef.current = false;
              return;
            }
            onCommitRename(e.currentTarget.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onCommitRename((e.target as HTMLInputElement).value);
            } else if (e.key === "Escape") {
              e.preventDefault();
              suppressBlurRef.current = true;
              onCancelRename();
            }
          }}
          aria-label={`ビューア名を編集: ${viewer.name}`}
        />
      </span>
    );
  }

  // #53: 一覧タブはタブ全体が <button> なのでタブ chrome のどこでも反応するが、
  // ビューアタブは内側の name <button> だけがクリックターゲットなため、
  // wrapper の padding (上下 4px / 左 22px / 右 10px) や close ボタン非表示時の
  // 右側スペースをクリックしても無反応だった。wrapper 側で click / dblclick を
  // 受け、close ボタン由来のイベントだけ除外することで一覧タブと当たり判定を揃える。
  // close 内の CloseIcon は SVG 要素なので e.target は HTMLElement ではなく
  // SVGElement になり得る。closest() は Element の API なので instanceof Element
  // でガードしてから呼ぶ。
  const isFromClose = (e: { target: EventTarget | null }) =>
    e.target instanceof Element && e.target.closest(".top-tab-viewer-close") != null;

  return (
    <span
      className={`top-tab top-tab-viewer ${isActive ? "active" : ""} ${
        isDragSource ? "dragging" : ""
      }`}
      {...{ [DATA_VIEWER_TAB]: String(index) }}
      onPointerDown={(e) => {
        // Drag-start guards (spec §5.2). Anything that should fall through to
        // the existing click / dblclick / close paths is rejected here.
        if (e.button !== 0) return; // primary button only
        // isEditing here is technically subsumed by anyRenaming (own rename
        // implies any-rename) but kept for symmetry with the early-return
        // pair below: own-rename uses the alternate render path, sibling-
        // rename keeps this render path.
        if (isEditing) return;
        // Block drag while *any* tab is in rename mode. preventDefault on
        // this pointerdown would otherwise keep the rename input focused
        // and let the user reorder a sibling tab behind the open editor.
        if (anyRenaming) return;
        if (isFromClose(e)) return; // close button has its own onClick
        // Suppress text selection on the wrapper span. The wrapper isn't
        // focusable, so this is purely about clearing the I-beam cursor +
        // user-select side effects when the drag turns active.
        e.preventDefault();
        onStartDrag(index, {
          clientX: e.clientX,
          clientY: e.clientY,
          pointerId: e.pointerId,
        });
      }}
      onClick={(e) => {
        if (isFromClose(e)) return;
        // Drag commit/cancel fires a synthetic click right after pointerup
        // on most engines; suppress that one trailing click so the source
        // tab doesn't re-activate after a successful reorder (#50).
        if (shouldSuppressClick()) return;
        onActivate();
        // 一覧タブはタブ全体が <button> なので click で自動的にフォーカスが
        // 乗るが、ビューアタブの wrapper は <span> でフォーカス不可。padding
        // 領域クリック時に focus-visible リング含めて一覧タブと挙動を揃える
        // ため、内側 name button へ明示的に focus を寄せる。name button 上の
        // 直接クリックなら既に focus されているので呼んでも no-op。
        nameButtonRef.current?.focus();
      }}
      onDoubleClick={(e) => {
        if (isFromClose(e)) return;
        e.preventDefault();
        onStartRename();
      }}
    >
      <button
        ref={nameButtonRef}
        type="button"
        role="tab"
        aria-selected={isActive}
        className="top-tab-viewer-name"
        title={viewer.name}
      >
        {viewer.name}
      </button>
      {canClose ? (
        <button
          type="button"
          className="top-tab-viewer-close"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          title={`ビューア "${viewer.name}" を閉じる`}
          aria-label={`ビューア "${viewer.name}" を閉じる`}
          tabIndex={-1}
        >
          <CloseIcon size={14} />
        </button>
      ) : null}
    </span>
  );
}

