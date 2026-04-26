import { ChevronIcon } from "../../shared/icons/ChevronIcon";
import { FolderIcon } from "../../shared/icons/FolderIcon";
import { ImageIcon } from "../../shared/icons/ImageIcon";
import { SpinnerIcon } from "../../shared/icons/SpinnerIcon";
import type { Node } from "./useTree";

export type ThumbHandlers = {
  onEnter: (path: string, rect: DOMRect) => void;
  onLeave: () => void;
};

type Props = {
  node: Node;
  depth: number;
  expanded: boolean;
  loading: boolean;
  error?: string;
  children?: Node[];
  childrenByPath: Map<string, Node[]>;
  expandedSet: Set<string>;
  loadingSet: Set<string>;
  errors: Map<string, string>;
  onToggle: (path: string) => void;
  onRetry: (path: string) => void;
  thumb: ThumbHandlers;
  onImageOpen: (path: string) => void;
};

export function TreeNode(props: Props) {
  const {
    node,
    depth,
    expanded,
    loading,
    error,
    children,
    childrenByPath,
    expandedSet,
    loadingSet,
    errors,
    onToggle,
    onRetry,
    thumb,
    onImageOpen,
  } = props;

  const isDir = node.kind === "dir";
  const isImage = node.kind === "image";

  const handleClick = () => {
    if (isDir) onToggle(node.path);
    else if (isImage) onImageOpen(node.path);
  };

  const handleEnter = isImage
    ? (e: React.MouseEvent<HTMLDivElement>) => {
        thumb.onEnter(node.path, e.currentTarget.getBoundingClientRect());
      }
    : undefined;

  const handleLeave = isImage ? () => thumb.onLeave() : undefined;

  return (
    <div className="tree-node">
      <div
        className="tree-row"
        style={{ paddingLeft: depth * 16 + 4 }}
        onClick={handleClick}
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
        role={isDir ? "button" : undefined}
      >
        <span className="tree-arrow">
          {loading ? (
            <SpinnerIcon />
          ) : isDir ? (
            <ChevronIcon open={expanded} />
          ) : null}
        </span>
        <span className="tree-icon">{isDir ? <FolderIcon /> : <ImageIcon />}</span>
        <span className="tree-name">{node.name}</span>
      </div>

      {expanded && error && (
        <div className="tree-error" style={{ paddingLeft: (depth + 1) * 16 + 4 }}>
          <span>読み込み失敗: {error}</span>
          <button
            className="tree-retry"
            onClick={(e) => {
              e.stopPropagation();
              onRetry(node.path);
            }}
          >
            再試行
          </button>
        </div>
      )}

      {expanded && !error && children && children.length === 0 && !loading && (
        <div className="tree-empty" style={{ paddingLeft: (depth + 1) * 16 + 4 }}>
          (空)
        </div>
      )}

      {expanded && children && children.length > 0 && (
        <div className="tree-children">
          {children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expandedSet.has(child.path)}
              loading={loadingSet.has(child.path)}
              error={errors.get(child.path)}
              children={childrenByPath.get(child.path)}
              childrenByPath={childrenByPath}
              expandedSet={expandedSet}
              loadingSet={loadingSet}
              errors={errors}
              onToggle={onToggle}
              onRetry={onRetry}
              thumb={thumb}
              onImageOpen={onImageOpen}
            />
          ))}
        </div>
      )}
    </div>
  );
}
