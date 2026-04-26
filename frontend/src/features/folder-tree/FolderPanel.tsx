import type { useTree } from "./useTree";
import { useThumbnail } from "./useThumbnail";
import { TreeNode } from "./TreeNode";
import { ThumbnailPopup } from "./ThumbnailPopup";

export type TreeApi = ReturnType<typeof useTree>;

type Props = {
  tree: TreeApi;
  onImageOpen: (path: string) => void;
};

export function FolderPanel({ tree, onImageOpen }: Props) {
  const { state, pickRoot, toggle, retry } = tree;
  const { rootPath, childrenByPath, expanded, loading, errors, noPermission } =
    state;

  const thumb = useThumbnail(256, "letterbox");

  const rootNode = rootPath
    ? {
        path: rootPath,
        name: basename(rootPath),
        kind: "dir",
        mtime: 0,
        size: 0,
      }
    : null;

  const thumbHandlers = { onEnter: thumb.onEnter, onLeave: thumb.onLeave };

  return (
    <div className="folder-panel">
      <div className="folder-panel-header">
        <button className="folder-pick-button" onClick={pickRoot}>
          フォルダを選択
        </button>
        {rootPath && (
          <div className="folder-panel-path" title={rootPath}>
            {rootPath}
          </div>
        )}
      </div>
      <div className="folder-panel-tree">
        {rootNode ? (
          <TreeNode
            node={rootNode as any}
            depth={0}
            expanded={expanded.has(rootNode.path)}
            loading={loading.has(rootNode.path)}
            error={errors.get(rootNode.path)}
            noPermission={noPermission.has(rootNode.path)}
            children={childrenByPath.get(rootNode.path)}
            childrenByPath={childrenByPath}
            expandedSet={expanded}
            loadingSet={loading}
            errors={errors}
            noPermissionSet={noPermission}
            onToggle={toggle}
            onRetry={retry}
            thumb={thumbHandlers}
            onImageOpen={onImageOpen}
          />
        ) : (
          <div className="folder-panel-empty">
            上のボタンからフォルダを選択してください
          </div>
        )}
      </div>
      <ThumbnailPopup
        visible={thumb.popupVisible}
        anchor={thumb.popupAnchor}
        entry={thumb.entry}
        size={thumb.displaySize}
      />
    </div>
  );
}

function basename(p: string): string {
  const norm = p.replace(/[\\/]+$/, "");
  const idx = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}
