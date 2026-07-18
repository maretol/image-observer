import { Fragment } from "react";
import { ViewerTab } from "./features/viewer-grid/ViewerTab";
import type { useViewerTabReorder } from "./features/viewer-grid/useViewerTabReorder";
import type { Viewer } from "./features/viewer-grid/viewers";
import { PlusIcon } from "./shared/icons/PlusIcon";
import { SettingsIcon } from "./shared/icons/SettingsIcon";
import type { TopTab } from "./topTab";

// ウィンドウヘッダのトップレベルタブ列 ("一覧" + ビューアタブ + 追加 / 設定ボタン)。

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
  // 一覧タブの並べ替えモード中 true (#144 Phase 2)。バー全体を inert にして、ビューアタブ
  // への移動 / 追加 / 設定を pointer + キーボードの両方から塞ぐ (spec-image-sort §5.2)。
  interactionDisabled?: boolean;
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
  interactionDisabled = false,
}: TopTabsBarProps) {
  // 閾値を越えて active になってから出す (通常クリックでインジケータが一瞬光らないよう)。
  const dragActive = reorder.state?.active ?? false;
  const dragSrcIdx = dragActive ? (reorder.state?.srcIdx ?? -1) : -1;
  const dragInsertIdx = dragActive ? (reorder.state?.insertIdx ?? -1) : -1;

  return (
    <nav
      className="top-tabs"
      role="tablist"
      aria-label="トップレベルタブ"
      inert={interactionDisabled || undefined}
    >
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
              // rename 中に *どの* タブでもドラッグ開始を抑止する。これがないと兄弟
              // タブの pointerdown が (isEditing=false なので) ドラッグを始め、rename
              // 入力はフォーカスを保ったまま裏で並べ替えできてしまうため。
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
