// Barrel for the viewer flex-layout primitives (Phase 5 /
// spec-viewer-flexlayout.md). Importers should keep using `./layout` —
// internals are organized into per-concern modules under this directory.

export type {
  Edge,
  Layout,
  LayoutNode,
  LayoutNodeState,
  LayoutState,
  LeafNode,
  SplitDirection,
  SplitNode,
} from "./types";
export { MAX_PANELS, MIN_RATIO, newNodeId } from "./types";

export {
  collapseEmptyLeaf,
  countLeaves,
  emptyLeaf,
  enumerateLeaves,
  findLeaf,
  findNode,
  findParent,
  initialLayout,
  leafWithTab,
  replaceNode,
  updateLeaf,
  updateSplit,
} from "./tree";

export { clampRatio, validateLayout } from "./validation";

export {
  deserializeLayout,
  deserializeNode,
  layoutFromPersisted,
  serializeLayout,
  serializeNode,
} from "./serialization";

export { pickNewActiveId, recomputeActiveAfterClose } from "./active";

export type { SplitResult } from "./operations";
export {
  appendOrFocusInActive,
  closeTabInLeaf,
  closeTabsForPathInLayout,
  moveTabIntoLeaf,
  reorderTabInLeaf,
  setActivePanel,
  setActiveTabInLeaf,
  setSplitRatio,
  splitFromContextMenu,
  splitTabIntoEdge,
  splitWithNewLeaf,
  updateTabInLeaf,
} from "./operations";
