// Multi-viewer pure-function layer (#11). A `ViewerSet` holds N viewers, each
// with its own BSP `Layout` (spec-viewer-flexlayout.md). All mutations here
// are pure: take a ViewerSet, return a new one. The React glue lives in
// useViewerSet.ts (which re-uses useViewerGrid's mutation set against the
// active viewer's layout).

import {
  appendOrFocusInActive,
  collapseEmptyLeaf,
  findLeaf,
  initialLayout,
  recomputeActiveAfterClose,
  replaceNode,
  type Layout,
  type LayoutNode,
  type LeafNode,
} from "./layout";
import { newTab, type Tab } from "./useTabs";

// ─── Constants ───────────────────────────────────────────────────────

// MAX_VIEWERS = 8 ties to the `Ctrl+Shift+2..9` keybinding range.
// MAX_NAME_LEN is rune-counted, not byte-counted (Japanese names get full
// 32-char latitude). DEFAULT_NAME_PREFIX trails with a space because the
// suggestion appends an integer ("ビューア 1").
export const MAX_VIEWERS = 8;
export const MAX_NAME_LEN = 32;
export const DEFAULT_NAME_PREFIX = "ビューア ";

// ─── Types ───────────────────────────────────────────────────────────

export type Viewer = {
  id: string; // crypto.randomUUID at construction
  name: string;
  layout: Layout;
};

export type ViewerSet = {
  viewers: Viewer[]; // length: 1..MAX_VIEWERS (invariant)
  activeViewerId: string; // must be one of viewers[*].id
};

// ─── ID generation ───────────────────────────────────────────────────

export function newViewerId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Test environments without globalThis.crypto fall through to a non-RFC
  // but unique-enough id. Real browsers always take the crypto branch.
  return `vt-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

// ─── Constructors ────────────────────────────────────────────────────

export function newViewer(name: string): Viewer {
  return { id: newViewerId(), name, layout: initialLayout() };
}

export function initialViewerSet(): ViewerSet {
  const v = newViewer(`${DEFAULT_NAME_PREFIX}1`);
  return { viewers: [v], activeViewerId: v.id };
}

// ─── Helpers ─────────────────────────────────────────────────────────

export function findViewer(set: ViewerSet, id: string): Viewer | null {
  return set.viewers.find((v) => v.id === id) ?? null;
}

export function activeViewer(set: ViewerSet): Viewer {
  // Invariant guarantees 1+ viewers and a valid activeViewerId. Fall through
  // to viewers[0] only as a last-resort guard so callers never get null.
  return findViewer(set, set.activeViewerId) ?? set.viewers[0];
}

// suggestViewerName picks the smallest positive integer N not currently used
// in any name matching `${DEFAULT_NAME_PREFIX}<digits>$` and returns
// `${DEFAULT_NAME_PREFIX}${N}`. Custom user names are ignored — they don't
// occupy a slot in the auto-numbering sequence.
export function suggestViewerName(existingNames: string[]): string {
  const pattern = new RegExp(
    `^${DEFAULT_NAME_PREFIX.replace(/\s/g, "\\s")}(\\d+)$`,
  );
  const used = new Set<number>();
  for (const name of existingNames) {
    const m = name.match(pattern);
    if (!m) continue;
    used.add(Number(m[1]));
  }
  let n = 1;
  while (used.has(n)) n++;
  return `${DEFAULT_NAME_PREFIX}${n}`;
}

// sanitizeName trims, drops control chars, and rune-truncates to MAX_NAME_LEN.
// Returns null when the result would be empty (caller decides whether to
// reject or fall back).
export function sanitizeName(raw: string): string | null {
  const trimmed = raw.trim();
  // Drop ASCII control + DEL — viewer names are single-line.
  // eslint-disable-next-line no-control-regex
  const cleaned = trimmed.replace(/[\x00-\x1f\x7f]/g, "");
  if (cleaned === "") return null;
  const runes = Array.from(cleaned);
  if (runes.length > MAX_NAME_LEN) return runes.slice(0, MAX_NAME_LEN).join("");
  return cleaned;
}

// ─── Mutations (pure) ────────────────────────────────────────────────

// addViewer creates a fresh viewer (auto-named via suggestViewerName) and
// switches active to it. Returns the same set when at MAX_VIEWERS — caller
// is responsible for surfacing the limit (toast/log).
export function addViewer(set: ViewerSet): ViewerSet {
  if (set.viewers.length >= MAX_VIEWERS) return set;
  const name = suggestViewerName(set.viewers.map((v) => v.name));
  const v = newViewer(name);
  return {
    viewers: [...set.viewers, v],
    activeViewerId: v.id,
  };
}

// closeViewer removes a viewer and re-resolves activeViewerId by:
//  1. the viewer at the same index in the new array (= "the next viewer")
//  2. else the previous index
//  3. else the first viewer
// Refuses to close the last remaining viewer.
export function closeViewer(set: ViewerSet, id: string): ViewerSet {
  if (set.viewers.length <= 1) return set;
  const idx = set.viewers.findIndex((v) => v.id === id);
  if (idx < 0) return set;

  const next = [...set.viewers.slice(0, idx), ...set.viewers.slice(idx + 1)];
  let activeId = set.activeViewerId;
  if (set.activeViewerId === id) {
    if (idx < next.length) {
      activeId = next[idx].id;
    } else if (idx - 1 >= 0 && idx - 1 < next.length) {
      activeId = next[idx - 1].id;
    } else {
      activeId = next[0].id;
    }
  }
  return { viewers: next, activeViewerId: activeId };
}

// renameViewer applies sanitizeName. Empty-after-trim → no-op (caller shows
// validation feedback). activeViewerId is never touched.
export function renameViewer(
  set: ViewerSet,
  id: string,
  newName: string,
): ViewerSet {
  const sanitized = sanitizeName(newName);
  if (sanitized === null) return set;
  const idx = set.viewers.findIndex((v) => v.id === id);
  if (idx < 0) return set;
  if (set.viewers[idx].name === sanitized) return set;
  const next = set.viewers.map((v, i) =>
    i === idx ? { ...v, name: sanitized } : v,
  );
  return { ...set, viewers: next };
}

export function setActiveViewer(set: ViewerSet, id: string): ViewerSet {
  if (set.activeViewerId === id) return set;
  if (!set.viewers.some((v) => v.id === id)) return set;
  return { ...set, activeViewerId: id };
}

// updateViewerLayout swaps in a new Layout for a single viewer. This is the
// generic bridge used by useViewerSet to apply existing `layout.ts` mutations
// (split/move/reorder/etc.) to one viewer at a time.
export function updateViewerLayout(
  set: ViewerSet,
  id: string,
  next: Layout,
): ViewerSet {
  const idx = set.viewers.findIndex((v) => v.id === id);
  if (idx < 0) return set;
  if (set.viewers[idx].layout === next) return set;
  const viewers = set.viewers.map((v, i) =>
    i === idx ? { ...v, layout: next } : v,
  );
  return { ...set, viewers };
}

// ─── Cross-viewer tab move (§4.6 of spec) ────────────────────────────

// moveTabAcrossViewers transplants one tab from src viewer's specified leaf
// into dst viewer's currently-active leaf. State preserved: zoom / pan /
// initialized / imageWidth / imageHeight (just the Tab object passed by
// reference). Behavior:
//
//   - src/dst must both exist; same-viewer move is a no-op (use the
//     in-viewer move helpers instead).
//   - dst leaf dedupes by path: if the path already exists, focus moves to
//     the existing tab and src's tab is still removed.
//   - src leaf may collapse (sibling promotion) when the move empties it.
//   - activeViewerId is NOT changed — the user keeps working in src.
//
// Caller (useViewerSet) is responsible for the post-move toast + logging.
export function moveTabAcrossViewers(
  set: ViewerSet,
  srcViewerId: string,
  srcLeafId: string,
  srcIdx: number,
  dstViewerId: string,
): ViewerSet {
  if (srcViewerId === dstViewerId) return set;
  const srcViewer = findViewer(set, srcViewerId);
  const dstViewer = findViewer(set, dstViewerId);
  if (!srcViewer || !dstViewer) return set;

  const srcLeaf = findLeaf(srcViewer.layout.root, srcLeafId);
  if (!srcLeaf) return set;
  if (srcIdx < 0 || srcIdx >= srcLeaf.tabs.length) return set;
  const tab: Tab = srcLeaf.tabs[srcIdx];

  const dstLeaf = findLeaf(dstViewer.layout.root, dstViewer.layout.activeId);
  if (!dstLeaf) return set;

  // Build new dst leaf: dedupe-by-path or append.
  let nextDstLeaf: LeafNode;
  const existing = dstLeaf.tabs.findIndex((t) => t.path === tab.path);
  if (existing >= 0) {
    nextDstLeaf = { ...dstLeaf, activeIndex: existing };
  } else {
    const newTabs = [...dstLeaf.tabs, tab];
    nextDstLeaf = {
      ...dstLeaf,
      tabs: newTabs,
      activeIndex: newTabs.length - 1,
    };
  }
  const dstRoot = replaceNode(dstViewer.layout.root, dstLeaf.id, nextDstLeaf);
  const nextDstLayout: Layout = { root: dstRoot, activeId: dstLeaf.id };

  // Build new src leaf: tab removed; possibly collapse if empty.
  const srcTabs = srcLeaf.tabs.filter((_, i) => i !== srcIdx);
  const nextSrcLeaf: LeafNode = {
    ...srcLeaf,
    tabs: srcTabs,
    activeIndex: recomputeActiveAfterClose(
      srcLeaf.activeIndex,
      srcIdx,
      srcTabs.length,
    ),
  };
  let srcRoot = replaceNode(srcViewer.layout.root, srcLeaf.id, nextSrcLeaf);
  if (nextSrcLeaf.tabs.length === 0) {
    srcRoot = collapseEmptyLeaf(srcRoot, nextSrcLeaf.id);
  }
  // Resolve src's activeId: if it pointed at the now-empty leaf and the leaf
  // got collapsed (or merged), fall back to the first remaining leaf.
  let srcActiveId = srcViewer.layout.activeId;
  if (
    nextSrcLeaf.tabs.length === 0 &&
    srcViewer.layout.activeId === srcLeaf.id &&
    !findLeaf(srcRoot, srcLeaf.id)
  ) {
    // findLeaf returns null when the leaf was collapsed away; pick first leaf.
    const firstLeaf = pickFirstLeafId(srcRoot);
    if (firstLeaf) srcActiveId = firstLeaf;
  }
  const nextSrcLayout: Layout = { root: srcRoot, activeId: srcActiveId };

  // Patch both viewers in one pass.
  const viewers = set.viewers.map((v) => {
    if (v.id === srcViewerId) return { ...v, layout: nextSrcLayout };
    if (v.id === dstViewerId) return { ...v, layout: nextDstLayout };
    return v;
  });
  return { ...set, viewers };
}

// pickFirstLeafId — local helper for activeId fallback after a collapse.
// Avoids importing enumerateLeaves from layout.ts (which would allocate
// the full leaf list when we only need the first one).
function pickFirstLeafId(node: LayoutNode): string | null {
  if (node.kind === "leaf") return node.id;
  return pickFirstLeafId(node.a) ?? pickFirstLeafId(node.b);
}

// ─── Open-in-specific-viewer thin wrappers ───────────────────────────

// These compose with appendOrFocusInActive so the existing (single-viewer)
// open path is reused unchanged. Caller (useViewerSet) is expected to wrap
// these with pre-flight checks (dimensions, error toasts) — they only do
// the layout transform.

export function openPathInViewer(
  set: ViewerSet,
  viewerId: string,
  path: string,
): ViewerSet {
  const v = findViewer(set, viewerId);
  if (!v) return set;
  const next = appendOrFocusInActive(v.layout, path);
  return updateViewerLayout(set, viewerId, next);
}

// makeNewTab is exported so useViewerSet can construct Tab objects for bulk
// open-as-split flows (which need a fresh Tab to feed splitWithNewLeaf).
export function makeNewTab(path: string): Tab {
  return newTab(path);
}
