// viewer flex-layout のコア型・定数 (Phase 5 / spec-viewer-flexlayout.md)。
// viewer 領域は BSP tree: 内部ノード (SplitNode) が領域を ratio で 2 分割し、leaf
// (LeafNode) が独自 tab list を持つ 1 パネル。

import type { Tab } from "../useTabs";

export type SplitDirection = "row" | "col";
// "row" = 横分割 (a が上、b が下、splitter は水平)。"col" = 縦分割 (a が左、b が右)。

export type Edge = "top" | "bottom" | "left" | "right";

export type SplitNode = {
  kind: "split";
  id: string;
  direction: SplitDirection;
  ratio: number; // a の取り分、(MIN_RATIO, 1 - MIN_RATIO)
  a: LayoutNode;
  b: LayoutNode;
};

export type LeafNode = {
  kind: "leaf";
  id: string;
  tabs: Tab[];
  activeIndex: number; // tabs.length === 0 のときだけ -1
};

export type LayoutNode = SplitNode | LeafNode;

export type Layout = {
  root: LayoutNode;
  activeId: string;
};

// 永続化形 (Go state.LayoutNodeState のミラー)。
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
  // crypto.randomUUID は modern Chromium (Wails webview) にある。global crypto 無しの
  // unit test 用に fallback。
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `n-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}
