// Viewer flex-layout core types and constants (Phase 5 / spec-viewer-flexlayout.md).
//
// The viewer area is a binary space partitioning (BSP) tree. Each internal
// node (`SplitNode`) splits its area in two with a ratio. Each leaf
// (`LeafNode`) is one panel with its own tab list.

import type { Tab } from "../useTabs";

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

export const MIN_RATIO = 0.05;
export const MAX_PANELS = 16;

export function newNodeId(): string {
  // crypto.randomUUID is available in modern Chromium (Wails uses webview).
  // Fall back for unit tests that may run without a global crypto.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `n-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}
