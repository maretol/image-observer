// 高レベル Layout 操作: tab 移動 (move / reorder / append / close) / split 作成 / leaf
// アクティブ化 / tab・split の小さな patch。全て新 Layout を返す純関数 (MAX_PANELS で拒否
// しうる操作は SplitResult)。

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

// tab を別 leaf へ移動。src===dst なら reorderTabInLeaf に委譲。別 leaf で src が 1 tab だけ
// だった場合 collapse しうる。
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

  // dst 更新: path dedupe、無ければ挿入。
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

  // src 更新: tab を除去。
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

// dst leaf を分割し tab を新しい兄弟へ移す。src===dst かつ src が 1 tab だけなら no-op
// (空 src ができる)。countLeaves >= MAX_PANELS なら ok:false。
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

  // 移動 tab を持つ新 leaf を作る。
  const movedTab: Tab = { ...tab };
  const newLeaf: LeafNode = leafWithTab(movedTab);

  // 移動後の dst leaf を計算。same-leaf の場合 dst===src なので split 前に dst から tab を剥がす。
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

  // dst (または剥がし後) を新 split で置換。
  let root = replaceNode(layout.root, dst.id, newSplit);

  // 別 leaf の場合: src から tab を除去し、必要なら src を collapse。
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

// dstLeafId を edge で分割し、新しく作った tab を新兄弟 leaf に置く。bulk "open as split"
// (tab がまだどの leaf にも無い) で使う。MAX_PANELS 到達なら ok:false。
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

// "右に分割" / "下に分割" コンテキストメニュー: tab の元 leaf を分割。
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

  // 閉じた leaf が空になる場合、collapse の前に DFS index を取り、activeId を元の位置付近に置き直す。
  const prevLeaves = enumerateLeaves(layout.root);
  const prevIdx = prevLeaves.findIndex((l) => l.id === leafId);

  let root = replaceNode(layout.root, leaf.id, newLeaf);
  if (newLeaf.tabs.length === 0) root = collapseEmptyLeaf(root, newLeaf.id);

  // activeId 更新。
  let activeId = layout.activeId;
  if (newLeaf.tabs.length === 0 && layout.activeId === leafId) {
    activeId = pickNewActiveId(root, prevIdx);
  }
  return { root, activeId };
}

// 全 leaf から path === absPath の tab を全て除去する。画像削除フロー (#47) 用で、削除済み
// ファイルの dangling tab (次回 open でエラー) を残さない。各 leaf 内で tabIndex の高い方から
// 閉じ、iteration 中に前の index が有効に保たれる (最後の一致 tab 除去時に collapse も自然に走る)。
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
  // tabIndex の高い方から (同 leaf 内で除去が次をずらさないように)。leaf をまたぐ順序は無関係。
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

// active leaf に path を開く。active leaf 内でのみ dedupe、無ければ append。pixel-size /
// decode-error の pre-flight は呼び出し側 (useViewerGrid) の責任。
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
