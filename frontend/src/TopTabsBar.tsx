import { Fragment } from "react";
import { ViewerTab } from "./features/viewer-grid/ViewerTab";
import type { useViewerTabReorder } from "./features/viewer-grid/useViewerTabReorder";
import type { Viewer } from "./features/viewer-grid/viewers";
import { PlusIcon } from "./shared/icons/PlusIcon";
import { SettingsIcon } from "./shared/icons/SettingsIcon";
import type { TopTab } from "./topTab";

// TopTabsBar — the top-level tab strip across the window header. Renders one
// "一覧" tab + N viewer tabs (with inline rename + #50 reorder DnD indicator)
// + the "add viewer" button + the "settings" button. The dragActive /
// dragSrcIdx / dragInsertIdx values that gate the indicator and the source-
// tab dimming are derived locally from `reorder.state`; the orchestrator
// just hands the reorder hook through.

export type TopTabsBarProps = {
  topTab: TopTab;
  onSelectList: () => void;
  viewers: Viewer[];
  activeViewerId: string;
  editingViewerId: string | null;
  onSelectViewer: (viewerId: string) => void;
  onStartRename: (viewerId: string) => void;
  onCommitRename: (viewerId: string, name: string) => void;
  onCancelRename: () => void;
  onCloseViewer: (viewerId: string) => void;
  reorder: ReturnType<typeof useViewerTabReorder>;
  onAddViewer: () => void;
  onOpenSettings: () => void;
  maxViewers: number;
};

export function TopTabsBar({
  topTab,
  onSelectList,
  viewers,
  activeViewerId,
  editingViewerId,
  onSelectViewer,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onCloseViewer,
  reorder,
  onAddViewer,
  onOpenSettings,
  maxViewers,
}: TopTabsBarProps) {
  // Indicator and dragSource visibility key off the same state. Only show
  // them once the drag has crossed the threshold (active) so a normal click
  // doesn't briefly flash the indicator.
  const dragActive = reorder.state?.active ?? false;
  const dragSrcIdx = dragActive ? (reorder.state?.srcIdx ?? -1) : -1;
  const dragInsertIdx = dragActive ? (reorder.state?.insertIdx ?? -1) : -1;

  return (
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
        ref={reorder.containerRef}
      >
        {viewers.map((v, i) => (
          <Fragment key={v.id}>
            {dragInsertIdx === i && (
              <span className="viewer-tab-insert-indicator" aria-hidden="true" />
            )}
            <ViewerTab
              index={i}
              viewer={v}
              isActive={topTab === "viewer" && v.id === activeViewerId}
              isEditing={editingViewerId === v.id}
              // anyRenaming gates drag-start on *any* tab while a rename
              // session is open. Without it a pointerdown on a sibling tab
              // would start a drag (its own isEditing is false) while the
              // rename input keeps focus thanks to our preventDefault(),
              // letting the user reorder behind a still-open editor.
              anyRenaming={editingViewerId !== null}
              isDragSource={dragSrcIdx === i}
              canClose={viewers.length > 1}
              onActivate={() => onSelectViewer(v.id)}
              onStartRename={() => onStartRename(v.id)}
              onCommitRename={(name) => onCommitRename(v.id, name)}
              onCancelRename={onCancelRename}
              onClose={() => onCloseViewer(v.id)}
              onStartDrag={reorder.startDrag}
              shouldSuppressClick={reorder.shouldSuppressClick}
            />
          </Fragment>
        ))}
        {dragInsertIdx === viewers.length && (
          <span className="viewer-tab-insert-indicator" aria-hidden="true" />
        )}
      </div>
      <button
        type="button"
        className="top-tab-add"
        onClick={onAddViewer}
        disabled={viewers.length >= maxViewers}
        title={
          viewers.length >= maxViewers
            ? `ビューア数の上限 (${maxViewers}) に達しています`
            : "新しいビューアを追加"
        }
        aria-label="ビューアを追加"
      >
        <PlusIcon />
      </button>
      <button
        type="button"
        className="top-tab-settings"
        onClick={onOpenSettings}
        title="設定"
        aria-label="設定を開く"
      >
        <SettingsIcon />
      </button>
    </nav>
  );
}
