// Persistence: serialize / deserialize the BSP tree to / from the Wails-
// generated state shape (state.LayoutState).

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

// Hydrate Layout from the Wails-generated persistence shape (state.LayoutState).
// The generated TS types are wider than our domain types — `kind` and
// `direction` are `string` instead of narrow unions, `activeIndex` is required
// instead of optional, and tabs are TabState class instances rather than
// plain objects. Runtime fields match 1:1 (Go only writes "split"/"leaf" and
// "row"/"col"); the recursion below exists to produce TS-narrow values
// without a blanket `as unknown as` cast at every boundary.
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
