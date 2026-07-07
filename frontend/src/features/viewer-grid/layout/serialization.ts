// 永続化: BSP tree を Wails 生成の state 形 (state.LayoutState) と相互変換する。

import type { state } from "../../../../wailsjs/go/models";
import type { Tab } from "../useTabs";
import type {
  Layout,
  LayoutNode,
  LayoutNodeState,
  LayoutState,
} from "./types";
import { emptyLeaf, enumerateLeaves } from "./tree";
import { clampRatio } from "./validation";

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

// Wails 生成の永続形 (state.LayoutState) から Layout を復元する。生成 TS 型は domain 型より
// 広い (kind / direction が narrow union でなく string、activeIndex が必須、tabs が class instance)。
// 実行時の値は 1:1 一致するので、下の再帰は境界ごとの as unknown as cast なしで TS-narrow な値を作るためにある。
export function layoutFromPersisted(ls: state.LayoutState): Layout {
  return deserializeLayout({
    root: narrowPersistedNode(ls.root),
    activeId: ls.activeId,
  });
}

function narrowPersistedNode(n: state.LayoutNodeState): LayoutNodeState {
  return {
    kind: n.kind === "split" ? "split" : "leaf",
    id: n.id,
    direction:
      n.direction === "row" || n.direction === "col" ? n.direction : undefined,
    ratio: n.ratio,
    a: n.a ? narrowPersistedNode(n.a) : undefined,
    b: n.b ? narrowPersistedNode(n.b) : undefined,
    tabs: n.tabs?.map((t) => ({
      path: t.path,
      zoom: t.zoom,
      panX: t.panX,
      panY: t.panY,
    })),
    activeIndex: n.activeIndex,
  };
}

export function deserializeLayout(state: LayoutState): Layout {
  const root = deserializeNode(state.root);
  // activeId を解決。無効なら DFS 順の先頭 leaf に fallback。
  const leaves = enumerateLeaves(root);
  if (leaves.length === 0) {
    // 起きない想定 (root は leaf か leaf を持つ split) だが安全策。
    const blank = emptyLeaf();
    return { root: blank, activeId: blank.id };
  }
  const valid = leaves.some((l) => l.id === state.activeId);
  return { root, activeId: valid ? state.activeId : leaves[0].id };
}
