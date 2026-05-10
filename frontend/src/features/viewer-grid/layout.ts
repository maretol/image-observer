// Viewer flex-layout primitives (Phase 5 / spec-viewer-flexlayout.md).
//
// The viewer area is a binary space partitioning (BSP) tree. Each internal
// node (`SplitNode`) splits its area in two with a ratio. Each leaf
// (`LeafNode`) is one panel with its own tab list. All structural mutations
// (split / move / collapse / reorder) are pure functions over the tree;
// `useViewerGrid` does the React glue.

import { newTab, type Tab } from "./useTabs";

// ─── Types ───────────────────────────────────────────────────────────

export type SplitDirection = "row" | "col";
// "row" = horizontal split (a stacked above b). Splitter runs horizontally.
// "col" = vertical split (a left of b).         Splitter runs vertically.

export type Edge = "top" | "bottom" | "left" | "right";

export type SplitNode = {
  kind: "split";
  id: string;
  direction: SplitDirection;
  ratio: number; // a's share, in (MIN_RATIO, 1 - MIN_RATIO).
  a: LayoutNode;
  b: LayoutNode;
};

export type LeafNode = {
  kind: "leaf";
  id: string;
  tabs: Tab[];
  activeIndex: number; // -1 only when tabs.length === 0
};

export type LayoutNode = SplitNode | LeafNode;

export type Layout = {
  root: LayoutNode;
  activeId: string;
};

// Persistence shape (mirrors Go state.LayoutNodeState).
export type LayoutNodeState = {
  kind: "split" | "leaf";
  id: string;
  direction?: SplitDirection;
  ratio?: number;
  a?: LayoutNodeState;
  b?: LayoutNodeState;
  tabs?: { path: string; zoom: number; panX: number; panY: number }[];
  activeIndex?: number;
};

export type LayoutState = {
  root: LayoutNodeState;
  activeId: string;
};

// ─── Constants ───────────────────────────────────────────────────────

export const MIN_RATIO = 0.05;
export const MAX_PANELS = 16;

// ─── ID generation ───────────────────────────────────────────────────

export function newNodeId(): string {
  // crypto.randomUUID is available in modern Chromium (Wails uses webview).
  // Fall back for unit tests that may run without a global crypto.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `n-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

// ─── Constructors ────────────────────────────────────────────────────

export function emptyLeaf(): LeafNode {
  return { kind: "leaf", id: newNodeId(), tabs: [], activeIndex: -1 };
}

export function leafWithTab(tab: Tab): LeafNode {
  return { kind: "leaf", id: newNodeId(), tabs: [tab], activeIndex: 0 };
}

export function initialLayout(): Layout {
  const root = emptyLeaf();
  return { root, activeId: root.id };
}

// ─── Tree traversal primitives ───────────────────────────────────────

export function findNode(root: LayoutNode, id: string): LayoutNode | null {
  if (root.id === id) return root;
  if (root.kind === "leaf") return null;
  return findNode(root.a, id) ?? findNode(root.b, id);
}

export function findLeaf(root: LayoutNode, id: string): LeafNode | null {
  const n = findNode(root, id);
  return n && n.kind === "leaf" ? n : null;
}

export function findParent(root: LayoutNode, childId: string): SplitNode | null {
  if (root.kind === "leaf") return null;
  if (root.a.id === childId || root.b.id === childId) return root;
  return findParent(root.a, childId) ?? findParent(root.b, childId);
}

export function enumerateLeaves(root: LayoutNode): LeafNode[] {
  if (root.kind === "leaf") return [root];
  return [...enumerateLeaves(root.a), ...enumerateLeaves(root.b)];
}

export function countLeaves(root: LayoutNode): number {
  return enumerateLeaves(root).length;
}

// ─── Functional updates ──────────────────────────────────────────────

export function replaceNode(
  root: LayoutNode,
  targetId: string,
  replacement: LayoutNode,
): LayoutNode {
  if (root.id === targetId) return replacement;
  if (root.kind === "leaf") return root;
  const newA = replaceNode(root.a, targetId, replacement);
  const newB = replaceNode(root.b, targetId, replacement);
  if (newA === root.a && newB === root.b) return root;
  return { ...root, a: newA, b: newB };
}

export function updateLeaf(
  root: LayoutNode,
  id: string,
  fn: (leaf: LeafNode) => LeafNode,
): LayoutNode {
  const leaf = findLeaf(root, id);
  if (!leaf) return root;
  return replaceNode(root, id, fn(leaf));
}

export function updateSplit(
  root: LayoutNode,
  id: string,
  fn: (split: SplitNode) => SplitNode,
): LayoutNode {
  const node = findNode(root, id);
  if (!node || node.kind !== "split") return root;
  return replaceNode(root, id, fn(node));
}

// Collapse a leaf with zero tabs by promoting its sibling. The root leaf is
// preserved (an empty viewer is a valid state).
export function collapseEmptyLeaf(
  root: LayoutNode,
  leafId: string,
): LayoutNode {
  const leaf = findLeaf(root, leafId);
  if (!leaf || leaf.tabs.length !== 0) return root;
  if (root.id === leafId) return root; // root leaf stays
  const parent = findParent(root, leafId);
  if (!parent) return root;
  const sibling = parent.a.id === leafId ? parent.b : parent.a;
  return replaceNode(root, parent.id, sibling);
}

// ─── Validation ──────────────────────────────────────────────────────

// Returns null when valid; otherwise an explanation string.
export function validateLayout(root: LayoutNode): string | null {
  const seen = new Set<string>();
  function walk(node: LayoutNode): string | null {
    if (!node.id) return "missing id";
    if (seen.has(node.id)) return `duplicate id: ${node.id}`;
    seen.add(node.id);
    if (node.kind === "split") {
      if (node.direction !== "row" && node.direction !== "col")
        return `invalid direction: ${node.direction}`;
      if (
        typeof node.ratio !== "number" ||
        Number.isNaN(node.ratio) ||
        node.ratio <= 0 ||
        node.ratio >= 1
      )
        return `ratio out of range: ${node.ratio}`;
      if (!node.a || !node.b) return "split missing children";
      return walk(node.a) ?? walk(node.b);
    }
    // leaf
    if (!Array.isArray(node.tabs)) return "leaf missing tabs";
    if (node.tabs.length === 0) {
      if (node.activeIndex !== -1)
        return `empty leaf has activeIndex !== -1: ${node.activeIndex}`;
    } else if (node.activeIndex < 0 || node.activeIndex >= node.tabs.length) {
      return `leaf activeIndex out of range: ${node.activeIndex}`;
    }
    return null;
  }
  return walk(root);
}

export function clampRatio(ratio: number): number {
  if (Number.isNaN(ratio)) return 0.5;
  if (ratio < MIN_RATIO) return MIN_RATIO;
  if (ratio > 1 - MIN_RATIO) return 1 - MIN_RATIO;
  return ratio;
}

// ─── Serialization ───────────────────────────────────────────────────

export function serializeNode(node: LayoutNode): LayoutNodeState {
  if (node.kind === "split") {
    return {
      kind: "split",
      id: node.id,
      direction: node.direction,
      ratio: node.ratio,
      a: serializeNode(node.a),
      b: serializeNode(node.b),
    };
  }
  return {
    kind: "leaf",
    id: node.id,
    tabs: node.tabs.map((t) => ({
      path: t.path,
      zoom: t.zoom,
      panX: t.panX,
      panY: t.panY,
    })),
    activeIndex: node.activeIndex,
  };
}

export function deserializeNode(state: LayoutNodeState): LayoutNode {
  if (state.kind === "split") {
    if (!state.a || !state.b)
      throw new Error("split state missing a/b children");
    return {
      kind: "split",
      id: state.id,
      direction: state.direction ?? "col",
      ratio: clampRatio(state.ratio ?? 0.5),
      a: deserializeNode(state.a),
      b: deserializeNode(state.b),
    };
  }
  const tabs: Tab[] = (state.tabs ?? []).map((t) => ({
    path: t.path,
    zoom: t.zoom,
    panX: t.panX,
    panY: t.panY,
    initialized: t.zoom > 0,
    imageWidth: 0,
    imageHeight: 0,
  }));
  const activeIndex =
    tabs.length === 0
      ? -1
      : Math.max(0, Math.min(tabs.length - 1, state.activeIndex ?? 0));
  return { kind: "leaf", id: state.id, tabs, activeIndex };
}

export function serializeLayout(layout: Layout): LayoutState {
  return {
    root: serializeNode(layout.root),
    activeId: layout.activeId,
  };
}

export function deserializeLayout(state: LayoutState): Layout {
  const root = deserializeNode(state.root);
  // Resolve activeId; fall back to first leaf in DFS order.
  const leaves = enumerateLeaves(root);
  if (leaves.length === 0) {
    // Shouldn't happen (root is a leaf or a split with leaves), but be safe.
    const blank = emptyLeaf();
    return { root: blank, activeId: blank.id };
  }
  const valid = leaves.some((l) => l.id === state.activeId);
  return { root, activeId: valid ? state.activeId : leaves[0].id };
}

// ─── activeId resolution after a leaf disappears ─────────────────────

// Given the leaf order BEFORE the mutation, the index of the now-missing
// active leaf, and the new root, pick a sensible new activeId:
//   - leaf at the same DFS index in the new tree (= the leaf that "took the
//     active panel's place")
//   - else leaf at index -1 (the one just before)
//   - else first leaf in the new tree
export function pickNewActiveId(
  newRoot: LayoutNode,
  prevIndex: number,
): string {
  const leaves = enumerateLeaves(newRoot);
  if (leaves.length === 0) return newRoot.id; // root leaf
  if (prevIndex >= 0 && prevIndex < leaves.length) return leaves[prevIndex].id;
  if (prevIndex - 1 >= 0 && prevIndex - 1 < leaves.length)
    return leaves[prevIndex - 1].id;
  return leaves[0].id;
}

// ─── Tab helpers ─────────────────────────────────────────────────────

// Mirror of Phase 3a recomputeActiveAfterClose; lifted here for tests.
export function recomputeActiveAfterClose(
  curActive: number,
  closedIndex: number,
  newLen: number,
): number {
  if (newLen === 0) return -1;
  if (curActive === closedIndex) return Math.min(closedIndex, newLen - 1);
  if (curActive > closedIndex) return curActive - 1;
  return curActive;
}

// ─── High-level Layout operations ────────────────────────────────────

export type SplitResult = { layout: Layout; ok: boolean; reason?: string };

// Move a tab into another leaf. If srcLeafId === dstLeafId we delegate to
// reorderTabInLeaf. Otherwise the src leaf may collapse if it had only one tab.
export function moveTabIntoLeaf(
  layout: Layout,
  srcLeafId: string,
  srcIdx: number,
  dstLeafId: string,
  dstIdx?: number,
): Layout {
  if (srcLeafId === dstLeafId) {
    const dst = findLeaf(layout.root, dstLeafId);
    if (!dst) return layout;
    const target = dstIdx ?? dst.tabs.length;
    return reorderTabInLeaf(layout, srcLeafId, srcIdx, target);
  }
  const src = findLeaf(layout.root, srcLeafId);
  const dst = findLeaf(layout.root, dstLeafId);
  if (!src || !dst) return layout;
  if (srcIdx < 0 || srcIdx >= src.tabs.length) return layout;

  const tab = src.tabs[srcIdx];

  // Update dst: dedupe by path, otherwise insert.
  const existing = dst.tabs.findIndex((t) => t.path === tab.path);
  let newDst: LeafNode;
  if (existing >= 0) {
    newDst = { ...dst, activeIndex: existing };
  } else {
    const insertAt = clampInsertIndex(dstIdx ?? dst.tabs.length, dst.tabs.length);
    const newTabs = [...dst.tabs];
    newTabs.splice(insertAt, 0, tab);
    newDst = { ...dst, tabs: newTabs, activeIndex: insertAt };
  }

  // Update src: remove the tab.
  const newSrcTabs = src.tabs.filter((_, i) => i !== srcIdx);
  const newSrc: LeafNode = {
    ...src,
    tabs: newSrcTabs,
    activeIndex: recomputeActiveAfterClose(
      src.activeIndex,
      srcIdx,
      newSrcTabs.length,
    ),
  };

  let root = replaceNode(layout.root, dst.id, newDst);
  root = replaceNode(root, src.id, newSrc);
  if (newSrc.tabs.length === 0) root = collapseEmptyLeaf(root, newSrc.id);

  return { root, activeId: newDst.id };
}

export function reorderTabInLeaf(
  layout: Layout,
  leafId: string,
  srcIdx: number,
  dstIdx: number,
): Layout {
  const leaf = findLeaf(layout.root, leafId);
  if (!leaf) return layout;
  if (srcIdx < 0 || srcIdx >= leaf.tabs.length) return layout;
  if (srcIdx === dstIdx) return layout;

  const tabs = [...leaf.tabs];
  const [tab] = tabs.splice(srcIdx, 1);
  const insertAt = clampInsertIndex(
    dstIdx > srcIdx ? dstIdx - 1 : dstIdx,
    tabs.length,
  );
  tabs.splice(insertAt, 0, tab);
  const newLeaf: LeafNode = { ...leaf, tabs, activeIndex: insertAt };
  return {
    root: replaceNode(layout.root, leaf.id, newLeaf),
    activeId: leafId,
  };
}

// Split a destination leaf and move a tab into the new sibling. If src and
// dst are the same leaf and src has only one tab, the operation is a no-op
// (would create an empty src). If countLeaves >= MAX_PANELS, returns ok:false.
export function splitTabIntoEdge(
  layout: Layout,
  srcLeafId: string,
  srcIdx: number,
  dstLeafId: string,
  edge: Edge,
): SplitResult {
  if (countLeaves(layout.root) >= MAX_PANELS) {
    return { layout, ok: false, reason: "panel limit reached" };
  }

  const src = findLeaf(layout.root, srcLeafId);
  const dst = findLeaf(layout.root, dstLeafId);
  if (!src || !dst) return { layout, ok: false, reason: "leaf not found" };
  if (srcIdx < 0 || srcIdx >= src.tabs.length)
    return { layout, ok: false, reason: "tab index out of range" };

  if (srcLeafId === dstLeafId && src.tabs.length <= 1) {
    return { layout, ok: false, reason: "cannot split a single-tab panel into itself" };
  }

  const tab = src.tabs[srcIdx];
  const direction: SplitDirection =
    edge === "top" || edge === "bottom" ? "row" : "col";
  const newLeafFirst = edge === "top" || edge === "left";

  // Build the new leaf carrying the moved tab.
  const movedTab: Tab = { ...tab };
  const newLeaf: LeafNode = leafWithTab(movedTab);

  // Compute the post-move dst leaf (after src may have lost the tab).
  // Same-leaf case: dst === src; we strip the tab from dst before splitting.
  let newDstLeaf: LeafNode = dst;
  if (srcLeafId === dstLeafId) {
    const newTabs = dst.tabs.filter((_, i) => i !== srcIdx);
    newDstLeaf = {
      ...dst,
      tabs: newTabs,
      activeIndex: recomputeActiveAfterClose(
        dst.activeIndex,
        srcIdx,
        newTabs.length,
      ),
    };
  }

  const newSplit: SplitNode = {
    kind: "split",
    id: newNodeId(),
    direction,
    ratio: 0.5,
    a: newLeafFirst ? newLeaf : newDstLeaf,
    b: newLeafFirst ? newDstLeaf : newLeaf,
  };

  // Replace dst (or its post-strip version) with the new split.
  let root = replaceNode(layout.root, dst.id, newSplit);

  // Different-leaf case: we still need to remove the tab from src and
  // possibly collapse src.
  if (srcLeafId !== dstLeafId) {
    const newSrcTabs = src.tabs.filter((_, i) => i !== srcIdx);
    const newSrc: LeafNode = {
      ...src,
      tabs: newSrcTabs,
      activeIndex: recomputeActiveAfterClose(
        src.activeIndex,
        srcIdx,
        newSrcTabs.length,
      ),
    };
    root = replaceNode(root, src.id, newSrc);
    if (newSrc.tabs.length === 0) root = collapseEmptyLeaf(root, newSrc.id);
  }

  return {
    layout: { root, activeId: newLeaf.id },
    ok: true,
  };
}

// "右に分割" / "下に分割" context menu: split the leaf the tab came from.
export function splitFromContextMenu(
  layout: Layout,
  leafId: string,
  tabIdx: number,
  direction: SplitDirection,
): SplitResult {
  const edge: Edge = direction === "col" ? "right" : "bottom";
  return splitTabIntoEdge(layout, leafId, tabIdx, leafId, edge);
}

export function closeTabInLeaf(
  layout: Layout,
  leafId: string,
  tabIdx: number,
): Layout {
  const leaf = findLeaf(layout.root, leafId);
  if (!leaf) return layout;
  if (tabIdx < 0 || tabIdx >= leaf.tabs.length) return layout;
  const newTabs = leaf.tabs.filter((_, i) => i !== tabIdx);
  const newLeaf: LeafNode = {
    ...leaf,
    tabs: newTabs,
    activeIndex: recomputeActiveAfterClose(
      leaf.activeIndex,
      tabIdx,
      newTabs.length,
    ),
  };

  // If the closed leaf becomes empty, find its DFS index BEFORE the collapse so
  // we can reposition activeId near where it was.
  const prevLeaves = enumerateLeaves(layout.root);
  const prevIdx = prevLeaves.findIndex((l) => l.id === leafId);

  let root = replaceNode(layout.root, leaf.id, newLeaf);
  if (newLeaf.tabs.length === 0) root = collapseEmptyLeaf(root, newLeaf.id);

  // activeId update.
  let activeId = layout.activeId;
  if (newLeaf.tabs.length === 0 && layout.activeId === leafId) {
    activeId = pickNewActiveId(root, prevIdx);
  }
  return { root, activeId };
}

export function setActiveTabInLeaf(
  layout: Layout,
  leafId: string,
  tabIdx: number,
): Layout {
  const leaf = findLeaf(layout.root, leafId);
  if (!leaf) return layout;
  if (tabIdx < 0 || tabIdx >= leaf.tabs.length) return layout;
  if (leaf.activeIndex === tabIdx && layout.activeId === leafId) return layout;
  const newLeaf: LeafNode = { ...leaf, activeIndex: tabIdx };
  return {
    root: replaceNode(layout.root, leaf.id, newLeaf),
    activeId: leafId,
  };
}

export function setActivePanel(layout: Layout, leafId: string): Layout {
  if (layout.activeId === leafId) return layout;
  if (!findLeaf(layout.root, leafId)) return layout;
  return { ...layout, activeId: leafId };
}

export function updateTabInLeaf(
  layout: Layout,
  leafId: string,
  tabIdx: number,
  patch: Partial<Tab>,
): Layout {
  const leaf = findLeaf(layout.root, leafId);
  if (!leaf) return layout;
  if (tabIdx < 0 || tabIdx >= leaf.tabs.length) return layout;
  const newTabs = leaf.tabs.map((t, i) => (i === tabIdx ? { ...t, ...patch } : t));
  const newLeaf: LeafNode = { ...leaf, tabs: newTabs };
  return {
    ...layout,
    root: replaceNode(layout.root, leaf.id, newLeaf),
  };
}

export function setSplitRatio(
  layout: Layout,
  splitId: string,
  ratio: number,
): Layout {
  const node = findNode(layout.root, splitId);
  if (!node || node.kind !== "split") return layout;
  const r = clampRatio(ratio);
  if (Math.abs(node.ratio - r) < 1e-9) return layout;
  return {
    ...layout,
    root: replaceNode(layout.root, splitId, { ...node, ratio: r }),
  };
}

// Open a path in the active leaf. Mirrors Phase 3b openInActive semantics:
// dedupe within the active leaf only, append otherwise. The caller owns the
// pixel-size / decode-error pre-flight (kept in useViewerGrid as before).
export function appendOrFocusInActive(
  layout: Layout,
  path: string,
): Layout {
  const active = findLeaf(layout.root, layout.activeId);
  if (!active) return layout;
  const existing = active.tabs.findIndex((t) => t.path === path);
  if (existing >= 0) {
    if (active.activeIndex === existing) return layout;
    return setActiveTabInLeaf(layout, active.id, existing);
  }
  const tab = newTab(path);
  const newTabs = [...active.tabs, tab];
  const newLeaf: LeafNode = {
    ...active,
    tabs: newTabs,
    activeIndex: newTabs.length - 1,
  };
  return {
    root: replaceNode(layout.root, active.id, newLeaf),
    activeId: active.id,
  };
}

// ─── helpers ────────────────────────────────────────────────────────

function clampInsertIndex(idx: number, len: number): number {
  if (idx < 0) return 0;
  if (idx > len) return len;
  return idx;
}
