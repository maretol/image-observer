// High-level Layout operations: tab movement (move / reorder / append /
// close), split creation, leaf activation, and small per-tab/split state
// patches. All pure functions returning a new Layout (or SplitResult for
// operations that may refuse due to MAX_PANELS).

import type {
  Edge,
  Layout,
  LeafNode,
  SplitDirection,
  SplitNode,
} from "./types";
import { MAX_PANELS, newNodeId } from "./types";
import { newTab, type Tab } from "../useTabs";
import {
  collapseEmptyLeaf,
  countLeaves,
  enumerateLeaves,
  findLeaf,
  findNode,
  leafWithTab,
  replaceNode,
} from "./tree";
import { pickNewActiveId, recomputeActiveAfterClose } from "./active";
import { clampRatio } from "./validation";

export type SplitResult = { layout: Layout; ok: boolean; reason?: string };

// ─── Tab movement ────────────────────────────────────────────────────

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

// ─── Splits ──────────────────────────────────────────────────────────

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

// Split dstLeafId on the given edge and place a freshly-constructed tab in
// the new sibling leaf. Used by bulk "open as split" flows where the tab
// has not yet existed in any leaf. Returns ok:false if MAX_PANELS is hit.
export function splitWithNewLeaf(
  layout: Layout,
  dstLeafId: string,
  edge: Edge,
  tab: Tab,
): SplitResult {
  if (countLeaves(layout.root) >= MAX_PANELS) {
    return { layout, ok: false, reason: "panel limit reached" };
  }
  const dst = findLeaf(layout.root, dstLeafId);
  if (!dst) return { layout, ok: false, reason: "leaf not found" };

  const direction: SplitDirection =
    edge === "top" || edge === "bottom" ? "row" : "col";
  const newLeafFirst = edge === "top" || edge === "left";
  const newLeaf = leafWithTab({ ...tab });
  const newSplit: SplitNode = {
    kind: "split",
    id: newNodeId(),
    direction,
    ratio: 0.5,
    a: newLeafFirst ? newLeaf : dst,
    b: newLeafFirst ? dst : newLeaf,
  };
  const root = replaceNode(layout.root, dst.id, newSplit);
  return { layout: { root, activeId: newLeaf.id }, ok: true };
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

// ─── Close ───────────────────────────────────────────────────────────

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

// closeTabsForPathInLayout removes every tab whose `path === absPath`
// across all leaves. Used by the image-delete flow (#47) so that a freshly
// deleted file does not leave dangling tabs that would error on next open.
// Tabs are closed from highest tabIndex downward within each leaf so that
// earlier indices in the same leaf stay valid mid-iteration; that order
// also lets `closeTabInLeaf`'s "leaf became empty" collapse logic run
// naturally once the last matching tab is removed.
export function closeTabsForPathInLayout(
  layout: Layout,
  absPath: string,
): Layout {
  const matches: { leafId: string; tabIndex: number }[] = [];
  for (const leaf of enumerateLeaves(layout.root)) {
    leaf.tabs.forEach((t, i) => {
      if (t.path === absPath) {
        matches.push({ leafId: leaf.id, tabIndex: i });
      }
    });
  }
  if (matches.length === 0) return layout;
  // Higher tabIndex first so removing one doesn't shift the next within the
  // same leaf. Across leaves the order is irrelevant.
  matches.sort((a, b) => b.tabIndex - a.tabIndex);
  let next = layout;
  for (const m of matches) {
    next = closeTabInLeaf(next, m.leafId, m.tabIndex);
  }
  return next;
}

// ─── Per-leaf / per-tab / per-split patches ──────────────────────────

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

// ─── Append / focus ──────────────────────────────────────────────────

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
