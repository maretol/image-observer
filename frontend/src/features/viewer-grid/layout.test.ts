import { describe, expect, it } from "vitest";
import { newTab, type Tab } from "./useTabs";
import {
  appendOrFocusInActive,
  clampRatio,
  closeTabInLeaf,
  closeTabsForPathInLayout,
  collapseEmptyLeaf,
  countLeaves,
  deserializeLayout,
  deserializeNode,
  emptyLeaf,
  enumerateLeaves,
  findLeaf,
  findParent,
  initialLayout,
  leafWithTab,
  MAX_PANELS,
  MIN_RATIO,
  moveTabIntoLeaf,
  pickNewActiveId,
  recomputeActiveAfterClose,
  reorderTabInLeaf,
  replaceNode,
  serializeLayout,
  serializeNode,
  setActivePanel,
  setActiveTabInLeaf,
  setSplitRatio,
  splitFromContextMenu,
  splitTabIntoEdge,
  splitWithNewLeaf,
  updateLeaf,
  updateSplit,
  updateTabInLeaf,
  validateLayout,
  type Layout,
  type LayoutNode,
  type LeafNode,
  type SplitNode,
} from "./layout";

// ─── builders ────────────────────────────────────────────────────────

const t = (path: string, zoom = 1): Tab => ({
  path,
  zoom,
  panX: 0,
  panY: 0,
  initialized: zoom > 0,
  imageWidth: 0,
  imageHeight: 0,
});

function leafOf(id: string, tabs: Tab[], activeIndex = tabs.length === 0 ? -1 : 0): LeafNode {
  return { kind: "leaf", id, tabs, activeIndex };
}

function splitOf(
  id: string,
  direction: "row" | "col",
  a: LayoutNode,
  b: LayoutNode,
  ratio = 0.5,
): SplitNode {
  return { kind: "split", id, direction, ratio, a, b };
}

// ─── tree primitives ────────────────────────────────────────────────

describe("findLeaf / findParent / enumerateLeaves", () => {
  const l1 = leafOf("L1", [t("a")]);
  const l2 = leafOf("L2", [t("b")]);
  const l3 = leafOf("L3", [t("c")]);
  const inner = splitOf("S2", "row", l2, l3);
  const root = splitOf("S1", "col", l1, inner);

  it("finds leaves by id", () => {
    expect(findLeaf(root, "L1")?.id).toBe("L1");
    expect(findLeaf(root, "L3")?.id).toBe("L3");
    expect(findLeaf(root, "S1")).toBeNull();
    expect(findLeaf(root, "missing")).toBeNull();
  });

  it("finds parents", () => {
    expect(findParent(root, "L1")?.id).toBe("S1");
    expect(findParent(root, "L3")?.id).toBe("S2");
    expect(findParent(root, "S2")?.id).toBe("S1");
    expect(findParent(root, "S1")).toBeNull();
  });

  it("enumerates leaves in DFS order (a-first)", () => {
    expect(enumerateLeaves(root).map((l) => l.id)).toEqual(["L1", "L2", "L3"]);
    expect(countLeaves(root)).toBe(3);
  });
});

// ─── replaceNode / updateLeaf / updateSplit ─────────────────────────

describe("replaceNode", () => {
  it("replaces the root", () => {
    const r = leafOf("R", []);
    const rep = leafOf("X", []);
    expect(replaceNode(r, "R", rep)).toBe(rep);
  });

  it("replaces a deep leaf", () => {
    const root = splitOf("S1", "col", leafOf("L1", []), leafOf("L2", []));
    const out = replaceNode(root, "L2", leafOf("L2'", [t("x")])) as SplitNode;
    expect(out.a.id).toBe("L1");
    expect(out.b.id).toBe("L2'");
  });

  it("returns same root when target absent", () => {
    const root = splitOf("S1", "col", leafOf("L1", []), leafOf("L2", []));
    expect(replaceNode(root, "missing", leafOf("X", []))).toBe(root);
  });
});

describe("updateLeaf / updateSplit", () => {
  it("updateLeaf transforms only the named leaf", () => {
    const root = splitOf("S1", "col", leafOf("L1", []), leafOf("L2", [t("a")]));
    const out = updateLeaf(root, "L2", (l) => ({ ...l, tabs: [...l.tabs, t("b")] }));
    expect(findLeaf(out, "L2")?.tabs.length).toBe(2);
    expect(findLeaf(out, "L1")?.tabs.length).toBe(0);
  });

  it("updateSplit transforms only split nodes", () => {
    const root = splitOf("S1", "col", leafOf("L1", []), leafOf("L2", []));
    const out = updateSplit(root, "S1", (s) => ({ ...s, ratio: 0.7 }));
    expect((out as SplitNode).ratio).toBe(0.7);
    // updateSplit on a leaf id is a no-op.
    expect(updateSplit(root, "L1", (s) => ({ ...s, ratio: 0 }))).toBe(root);
  });
});

// ─── collapseEmptyLeaf ──────────────────────────────────────────────

describe("collapseEmptyLeaf", () => {
  it("preserves the root leaf even when empty", () => {
    const r = leafOf("R", []);
    expect(collapseEmptyLeaf(r, "R")).toBe(r);
  });

  it("promotes the sibling leaf when a child collapses", () => {
    const root = splitOf("S1", "col", leafOf("L1", []), leafOf("L2", [t("a")]));
    const out = collapseEmptyLeaf(root, "L1");
    expect(out.kind).toBe("leaf");
    expect((out as LeafNode).id).toBe("L2");
  });

  it("promotes a deeper sibling subtree intact", () => {
    const inner = splitOf("S2", "row", leafOf("L3", [t("c")]), leafOf("L4", [t("d")]));
    const root = splitOf("S1", "col", leafOf("L1", []), inner);
    const out = collapseEmptyLeaf(root, "L1");
    expect(out.kind).toBe("split");
    expect((out as SplitNode).id).toBe("S2");
    expect(enumerateLeaves(out).map((l) => l.id)).toEqual(["L3", "L4"]);
  });

  it("does nothing if the leaf still has tabs", () => {
    const root = splitOf("S1", "col", leafOf("L1", [t("a")]), leafOf("L2", []));
    expect(collapseEmptyLeaf(root, "L1")).toBe(root);
  });
});

// ─── validateLayout ────────────────────────────────────────────────

describe("validateLayout", () => {
  it("accepts a valid tree", () => {
    const root = splitOf("S1", "col", leafOf("L1", [t("a")]), leafOf("L2", []));
    expect(validateLayout(root)).toBeNull();
  });

  it("rejects ratio out of range", () => {
    const bad = splitOf("S1", "col", leafOf("L1", []), leafOf("L2", []), 0);
    expect(validateLayout(bad)).toMatch(/ratio/);
  });

  it("rejects duplicate ids", () => {
    const root = splitOf("S1", "col", leafOf("X", []), leafOf("X", []));
    expect(validateLayout(root)).toMatch(/duplicate/);
  });

  it("rejects mismatched activeIndex on populated leaf", () => {
    const bad: LeafNode = { kind: "leaf", id: "L", tabs: [t("a")], activeIndex: 5 };
    expect(validateLayout(bad)).toMatch(/activeIndex/);
  });

  it("rejects empty leaf with activeIndex !== -1", () => {
    const bad: LeafNode = { kind: "leaf", id: "L", tabs: [], activeIndex: 0 };
    expect(validateLayout(bad)).toMatch(/empty leaf/);
  });
});

// ─── clampRatio ────────────────────────────────────────────────────

describe("clampRatio", () => {
  it("clamps to [MIN_RATIO, 1 - MIN_RATIO]", () => {
    expect(clampRatio(0)).toBe(MIN_RATIO);
    expect(clampRatio(1)).toBe(1 - MIN_RATIO);
    expect(clampRatio(0.5)).toBe(0.5);
    expect(clampRatio(NaN)).toBe(0.5);
  });
});

// ─── recomputeActiveAfterClose ─────────────────────────────────────

describe("recomputeActiveAfterClose", () => {
  it("returns -1 when no tabs remain", () => {
    expect(recomputeActiveAfterClose(0, 0, 0)).toBe(-1);
  });
  it("clamps when closing the active tab", () => {
    expect(recomputeActiveAfterClose(2, 2, 2)).toBe(1);
    expect(recomputeActiveAfterClose(0, 0, 1)).toBe(0);
  });
  it("decrements active index when a left-side tab is closed", () => {
    expect(recomputeActiveAfterClose(2, 0, 2)).toBe(1);
  });
  it("leaves active alone when a right-side tab is closed", () => {
    expect(recomputeActiveAfterClose(0, 1, 1)).toBe(0);
  });
});

// ─── serialize / deserialize round-trip ────────────────────────────

describe("serialize / deserialize", () => {
  it("round-trips a leaf node", () => {
    const leaf = leafOf("L", [t("a", 1.5), t("b", 0.5)], 1);
    const s = serializeNode(leaf);
    expect(s).toMatchObject({
      kind: "leaf",
      id: "L",
      activeIndex: 1,
      tabs: [
        { path: "a", zoom: 1.5, panX: 0, panY: 0 },
        { path: "b", zoom: 0.5, panX: 0, panY: 0 },
      ],
    });
    const back = deserializeNode(s) as LeafNode;
    expect(back.tabs.map((t) => t.path)).toEqual(["a", "b"]);
    expect(back.activeIndex).toBe(1);
    // Runtime-only fields are reset.
    expect(back.tabs[0].imageWidth).toBe(0);
    expect(back.tabs[0].initialized).toBe(true); // zoom > 0
  });

  it("round-trips a tree", () => {
    const root = splitOf(
      "S1",
      "col",
      leafOf("L1", [t("a")], 0),
      splitOf("S2", "row", leafOf("L2", [t("b")]), leafOf("L3", [])),
      0.4,
    );
    const layout = { root, activeId: "L2" };
    const back = deserializeLayout(serializeLayout(layout));
    expect(validateLayout(back.root)).toBeNull();
    expect(back.activeId).toBe("L2");
    expect(enumerateLeaves(back.root).map((l) => l.id)).toEqual([
      "L1",
      "L2",
      "L3",
    ]);
  });

  it("falls back to first leaf when activeId is missing on deserialize", () => {
    const root = splitOf("S1", "col", leafOf("L1", []), leafOf("L2", []));
    const layout = { root, activeId: "missing" };
    const back = deserializeLayout(serializeLayout(layout));
    expect(back.activeId).toBe("L1");
  });

  it("clamps a ratio out of range during deserialize", () => {
    const back = deserializeNode({
      kind: "split",
      id: "S",
      direction: "col",
      ratio: 0,
      a: { kind: "leaf", id: "A", tabs: [], activeIndex: -1 },
      b: { kind: "leaf", id: "B", tabs: [], activeIndex: -1 },
    }) as SplitNode;
    expect(back.ratio).toBe(MIN_RATIO);
  });
});

// ─── high-level operations ─────────────────────────────────────────

describe("moveTabIntoLeaf", () => {
  it("moves a tab into a different leaf at the end", () => {
    const root = splitOf(
      "S1",
      "col",
      leafOf("L1", [t("a"), t("b")], 0),
      leafOf("L2", [t("c")], 0),
    );
    const layout = { root, activeId: "L1" };
    const out = moveTabIntoLeaf(layout, "L1", 0, "L2");
    expect(findLeaf(out.root, "L1")?.tabs.map((tt) => tt.path)).toEqual(["b"]);
    expect(findLeaf(out.root, "L2")?.tabs.map((tt) => tt.path)).toEqual([
      "c",
      "a",
    ]);
    expect(findLeaf(out.root, "L2")?.activeIndex).toBe(1);
    expect(out.activeId).toBe("L2");
  });

  it("collapses src when its last tab moves out", () => {
    const root = splitOf(
      "S1",
      "col",
      leafOf("L1", [t("a")], 0),
      leafOf("L2", [t("c")], 0),
    );
    const layout = { root, activeId: "L1" };
    const out = moveTabIntoLeaf(layout, "L1", 0, "L2");
    expect(out.root.kind).toBe("leaf");
    expect((out.root as LeafNode).id).toBe("L2");
    expect((out.root as LeafNode).tabs.map((tt) => tt.path)).toEqual(["c", "a"]);
  });

  it("dedupes when the same path already exists in dst", () => {
    const root = splitOf(
      "S1",
      "col",
      leafOf("L1", [t("a")], 0),
      leafOf("L2", [t("a"), t("b")], 1),
    );
    const layout = { root, activeId: "L1" };
    const out = moveTabIntoLeaf(layout, "L1", 0, "L2");
    expect(findLeaf(out.root, "L2")?.tabs.map((tt) => tt.path)).toEqual([
      "a",
      "b",
    ]);
    // dst's existing 'a' tab gets focus.
    expect(findLeaf(out.root, "L2")?.activeIndex).toBe(0);
    // src is collapsed.
    expect(out.root.kind).toBe("leaf");
  });

  it("delegates to reorder when src===dst", () => {
    const layout = {
      root: leafOf("L", [t("a"), t("b"), t("c")], 0),
      activeId: "L",
    };
    const out = moveTabIntoLeaf(layout, "L", 0, "L");
    // moving 'a' to end → reorders to [b, c, a]
    expect((out.root as LeafNode).tabs.map((tt) => tt.path)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("inserts at a specific index when dstIdx is given", () => {
    const root = splitOf(
      "S1",
      "col",
      leafOf("L1", [t("a")], 0),
      leafOf("L2", [t("c"), t("d")], 0),
    );
    const layout = { root, activeId: "L1" };
    const out = moveTabIntoLeaf(layout, "L1", 0, "L2", 1);
    expect(findLeaf(out.root, "L2")?.tabs.map((tt) => tt.path)).toEqual([
      "c",
      "a",
      "d",
    ]);
    expect(findLeaf(out.root, "L2")?.activeIndex).toBe(1);
  });
});

describe("reorderTabInLeaf", () => {
  it("moves to the end", () => {
    const layout = {
      root: leafOf("L", [t("a"), t("b"), t("c")], 1),
      activeId: "L",
    };
    const out = reorderTabInLeaf(layout, "L", 0, 3);
    expect((out.root as LeafNode).tabs.map((tt) => tt.path)).toEqual([
      "b",
      "c",
      "a",
    ]);
    expect((out.root as LeafNode).activeIndex).toBe(2);
  });

  it("moves backwards", () => {
    const layout = {
      root: leafOf("L", [t("a"), t("b"), t("c")], 0),
      activeId: "L",
    };
    const out = reorderTabInLeaf(layout, "L", 2, 0);
    expect((out.root as LeafNode).tabs.map((tt) => tt.path)).toEqual([
      "c",
      "a",
      "b",
    ]);
    expect((out.root as LeafNode).activeIndex).toBe(0);
  });

  it("no-ops on srcIdx === dstIdx", () => {
    const layout = { root: leafOf("L", [t("a"), t("b")], 0), activeId: "L" };
    expect(reorderTabInLeaf(layout, "L", 1, 1)).toBe(layout);
  });
});

describe("splitTabIntoEdge", () => {
  it("creates a 'row' split with new leaf on top for edge='top'", () => {
    const layout = {
      root: leafOf("L", [t("a"), t("b")], 0),
      activeId: "L",
    };
    const r = splitTabIntoEdge(layout, "L", 0, "L", "top");
    expect(r.ok).toBe(true);
    expect(r.layout.root.kind).toBe("split");
    const split = r.layout.root as SplitNode;
    expect(split.direction).toBe("row");
    // a (top) is the NEW leaf with the moved tab; b (bottom) is the original.
    expect((split.a as LeafNode).tabs.map((tt) => tt.path)).toEqual(["a"]);
    expect((split.b as LeafNode).tabs.map((tt) => tt.path)).toEqual(["b"]);
    expect(r.layout.activeId).toBe(split.a.id);
  });

  it("creates a 'col' split with new leaf on right for edge='right'", () => {
    const layout = {
      root: leafOf("L", [t("a"), t("b")], 0),
      activeId: "L",
    };
    const r = splitTabIntoEdge(layout, "L", 0, "L", "right");
    expect(r.ok).toBe(true);
    const split = r.layout.root as SplitNode;
    expect(split.direction).toBe("col");
    // a (left) is the original; b (right) is the new leaf.
    expect((split.a as LeafNode).tabs.map((tt) => tt.path)).toEqual(["b"]);
    expect((split.b as LeafNode).tabs.map((tt) => tt.path)).toEqual(["a"]);
  });

  it("refuses to split a single-tab panel into itself", () => {
    const layout = { root: leafOf("L", [t("only")], 0), activeId: "L" };
    const r = splitTabIntoEdge(layout, "L", 0, "L", "right");
    expect(r.ok).toBe(false);
    expect(r.layout).toBe(layout);
  });

  it("collapses src when src!==dst and src had only one tab", () => {
    const root = splitOf(
      "S1",
      "col",
      leafOf("L1", [t("a")], 0),
      leafOf("L2", [t("c")], 0),
    );
    const layout = { root, activeId: "L1" };
    const r = splitTabIntoEdge(layout, "L1", 0, "L2", "right");
    expect(r.ok).toBe(true);
    // After: L1 is gone; root used to be a split S1 between L1 and L2; now S1
    // is replaced by L2 (collapse), but L2 itself just became a split. So root
    // must be the new col split that was put in L2's place.
    expect(r.layout.root.kind).toBe("split");
    expect(countLeaves(r.layout.root)).toBe(2);
  });

  it("returns ok:false when panel limit is reached", () => {
    let layout = initialLayout();
    // Pre-load 2 tabs so the first split is allowed (single-tab self-split refuses).
    layout = appendOrFocusInActive(layout, "/p0");
    layout = appendOrFocusInActive(layout, "/p1");
    let counter = 2;
    while (countLeaves(layout.root) < MAX_PANELS) {
      const active = findLeaf(layout.root, layout.activeId)!;
      // Ensure the active leaf has 2+ tabs so we can self-split off.
      if (active.tabs.length < 2) {
        layout = appendOrFocusInActive(layout, `/p${counter++}`);
      }
      const r = splitTabIntoEdge(
        layout,
        layout.activeId,
        findLeaf(layout.root, layout.activeId)!.tabs.length - 1,
        layout.activeId,
        "right",
      );
      expect(r.ok).toBe(true);
      layout = r.layout;
    }
    expect(countLeaves(layout.root)).toBe(MAX_PANELS);
    // One more should fail.
    const active = findLeaf(layout.root, layout.activeId)!;
    if (active.tabs.length < 2) {
      layout = appendOrFocusInActive(layout, "/extra");
    }
    const overflow = splitTabIntoEdge(
      layout,
      layout.activeId,
      findLeaf(layout.root, layout.activeId)!.tabs.length - 1,
      layout.activeId,
      "right",
    );
    expect(overflow.ok).toBe(false);
    expect(overflow.layout).toBe(layout);
  });
});

describe("splitWithNewLeaf", () => {
  it("splits dst with a fresh tab on the right", () => {
    const layout = { root: leafOf("L", [t("a")], 0), activeId: "L" };
    const r = splitWithNewLeaf(layout, "L", "right", t("/img/x.png"));
    expect(r.ok).toBe(true);
    const split = r.layout.root as SplitNode;
    expect(split.direction).toBe("col");
    expect((split.a as LeafNode).tabs[0].path).toBe("a");
    expect((split.b as LeafNode).tabs[0].path).toBe("/img/x.png");
    expect(r.layout.activeId).toBe(split.b.id);
  });

  it("places the new leaf above for edge='top'", () => {
    const layout = { root: leafOf("L", [t("a")], 0), activeId: "L" };
    const r = splitWithNewLeaf(layout, "L", "top", t("/img/y.png"));
    expect(r.ok).toBe(true);
    const split = r.layout.root as SplitNode;
    expect(split.direction).toBe("row");
    expect((split.a as LeafNode).tabs[0].path).toBe("/img/y.png");
    expect((split.b as LeafNode).tabs[0].path).toBe("a");
  });

  it("returns ok:false when panel limit is reached", () => {
    let layout = initialLayout();
    layout = appendOrFocusInActive(layout, "/p0");
    layout = appendOrFocusInActive(layout, "/p1");
    while (countLeaves(layout.root) < MAX_PANELS) {
      const r = splitWithNewLeaf(layout, layout.activeId, "right", t("/x"));
      if (!r.ok) break;
      layout = r.layout;
    }
    expect(countLeaves(layout.root)).toBe(MAX_PANELS);
    const overflow = splitWithNewLeaf(layout, layout.activeId, "right", t("/y"));
    expect(overflow.ok).toBe(false);
    expect(overflow.layout).toBe(layout);
  });
});

describe("splitFromContextMenu", () => {
  it("'col' direction → split right", () => {
    const layout = { root: leafOf("L", [t("a"), t("b")], 0), activeId: "L" };
    const r = splitFromContextMenu(layout, "L", 0, "col");
    expect(r.ok).toBe(true);
    const split = r.layout.root as SplitNode;
    expect(split.direction).toBe("col");
    expect((split.b as LeafNode).tabs[0].path).toBe("a");
  });

  it("'row' direction → split below", () => {
    const layout = { root: leafOf("L", [t("a"), t("b")], 0), activeId: "L" };
    const r = splitFromContextMenu(layout, "L", 1, "row");
    expect(r.ok).toBe(true);
    const split = r.layout.root as SplitNode;
    expect(split.direction).toBe("row");
    expect((split.b as LeafNode).tabs[0].path).toBe("b");
  });
});

describe("closeTabInLeaf", () => {
  it("removes a tab and adjusts activeIndex", () => {
    const layout = {
      root: leafOf("L", [t("a"), t("b"), t("c")], 1),
      activeId: "L",
    };
    const out = closeTabInLeaf(layout, "L", 1);
    expect((out.root as LeafNode).tabs.map((tt) => tt.path)).toEqual(["a", "c"]);
    // activeIndex was 1 (closed); clamp to 1 (now 'c').
    expect((out.root as LeafNode).activeIndex).toBe(1);
  });

  it("collapses the leaf if its last tab was closed", () => {
    const root = splitOf(
      "S1",
      "col",
      leafOf("L1", [t("a")], 0),
      leafOf("L2", [t("b")], 0),
    );
    const layout = { root, activeId: "L1" };
    const out = closeTabInLeaf(layout, "L1", 0);
    expect(out.root.kind).toBe("leaf");
    expect((out.root as LeafNode).id).toBe("L2");
    // Active panel migrates to the surviving leaf.
    expect(out.activeId).toBe("L2");
  });

  it("preserves an empty root leaf", () => {
    const layout = { root: leafOf("R", [t("a")], 0), activeId: "R" };
    const out = closeTabInLeaf(layout, "R", 0);
    expect(out.root.kind).toBe("leaf");
    expect((out.root as LeafNode).id).toBe("R");
    expect((out.root as LeafNode).tabs.length).toBe(0);
    expect(out.activeId).toBe("R");
  });
});

describe("setActiveTabInLeaf / setActivePanel / updateTabInLeaf / setSplitRatio", () => {
  it("setActiveTabInLeaf updates activeIndex and activeId", () => {
    const root = splitOf(
      "S1",
      "col",
      leafOf("L1", [t("a"), t("b")], 0),
      leafOf("L2", [t("c")], 0),
    );
    const layout = { root, activeId: "L2" };
    const out = setActiveTabInLeaf(layout, "L1", 1);
    expect(findLeaf(out.root, "L1")?.activeIndex).toBe(1);
    expect(out.activeId).toBe("L1");
  });

  it("setActivePanel only changes activeId", () => {
    const root = splitOf("S1", "col", leafOf("L1", []), leafOf("L2", []));
    const layout = { root, activeId: "L1" };
    const out = setActivePanel(layout, "L2");
    expect(out.activeId).toBe("L2");
    expect(out.root).toBe(root);
  });

  it("updateTabInLeaf patches a single tab", () => {
    const layout = {
      root: leafOf("L", [t("a", 1), t("b", 2)], 0),
      activeId: "L",
    };
    const out = updateTabInLeaf(layout, "L", 1, { zoom: 4 });
    expect((out.root as LeafNode).tabs[1].zoom).toBe(4);
    expect((out.root as LeafNode).tabs[0].zoom).toBe(1);
  });

  it("setSplitRatio clamps and updates", () => {
    const root = splitOf("S", "col", leafOf("L1", []), leafOf("L2", []), 0.5);
    const layout = { root, activeId: "L1" };
    expect((setSplitRatio(layout, "S", 0).root as SplitNode).ratio).toBe(
      MIN_RATIO,
    );
    expect((setSplitRatio(layout, "S", 0.7).root as SplitNode).ratio).toBe(0.7);
  });
});

describe("appendOrFocusInActive", () => {
  it("appends a new tab to the active leaf", () => {
    const layout = initialLayout();
    const out = appendOrFocusInActive(layout, "/img/a.png");
    expect((out.root as LeafNode).tabs.map((t) => t.path)).toEqual([
      "/img/a.png",
    ]);
    expect((out.root as LeafNode).activeIndex).toBe(0);
  });

  it("focuses an existing tab in the active leaf", () => {
    let layout = initialLayout();
    layout = appendOrFocusInActive(layout, "/a");
    layout = appendOrFocusInActive(layout, "/b");
    expect((layout.root as LeafNode).activeIndex).toBe(1);
    layout = appendOrFocusInActive(layout, "/a");
    expect((layout.root as LeafNode).activeIndex).toBe(0);
    expect((layout.root as LeafNode).tabs.length).toBe(2);
  });
});

describe("pickNewActiveId", () => {
  it("picks the leaf at the same DFS index", () => {
    const root = splitOf(
      "S1",
      "col",
      leafOf("L1", []),
      splitOf("S2", "row", leafOf("L2", []), leafOf("L3", [])),
    );
    expect(pickNewActiveId(root, 1)).toBe("L2");
  });
  it("falls back to prevIndex - 1", () => {
    const root = leafOf("L1", []);
    expect(pickNewActiveId(root, 5)).toBe("L1");
  });
});

// ─── helpers ────────────────────────────────────────────────────────

// ─── closeTabsForPathInLayout (#47 image delete) ───────────────────

describe("closeTabsForPathInLayout", () => {
  function build(tabs: Tab[][], activeLeafIdx = 0): Layout {
    // Build a flat chain of leaves split right-to-left so the BSP tree has
    // realistic shape. For tabs.length <= 1 we return a single leaf.
    if (tabs.length === 1) {
      const leaf = leafOf(`L0`, tabs[0]);
      return { root: leaf, activeId: leaf.id };
    }
    const leaves: LeafNode[] = tabs.map((ts, i) => leafOf(`L${i}`, ts));
    let acc: LayoutNode = leaves[leaves.length - 1];
    for (let i = leaves.length - 2; i >= 0; i--) {
      acc = splitOf(`S${i}`, "col", leaves[i], acc);
    }
    return { root: acc, activeId: leaves[activeLeafIdx].id };
  }

  it("returns the same layout when no tab matches", () => {
    const layout = build([[t("/a"), t("/b")]]);
    const next = closeTabsForPathInLayout(layout, "/never-opened");
    expect(next).toBe(layout);
  });

  it("removes a matching tab in a single leaf", () => {
    const layout = build([[t("/a"), t("/victim"), t("/c")]]);
    const next = closeTabsForPathInLayout(layout, "/victim");
    const leaf = next.root as LeafNode;
    expect(leaf.tabs.map((tab) => tab.path)).toEqual(["/a", "/c"]);
  });

  it("removes the same path from multiple leaves", () => {
    const layout = build([
      [t("/a"), t("/victim")],
      [t("/victim"), t("/d")],
    ]);
    const next = closeTabsForPathInLayout(layout, "/victim");
    const leaves = enumerateLeaves(next.root);
    expect(leaves.flatMap((l) => l.tabs.map((tab) => tab.path))).toEqual([
      "/a",
      "/d",
    ]);
  });

  it("removes duplicates within one leaf (highest tabIndex first)", () => {
    // Two tabs in the same leaf both point at /dup. Naively iterating from
    // low → high index would shift the second match. The implementation
    // sorts high → low so both are dropped intact.
    const layout = build([[t("/dup"), t("/a"), t("/dup"), t("/b")]]);
    const next = closeTabsForPathInLayout(layout, "/dup");
    const leaf = next.root as LeafNode;
    expect(leaf.tabs.map((tab) => tab.path)).toEqual(["/a", "/b"]);
  });

  it("collapses the parent split if a leaf becomes empty", () => {
    const layout = build([[t("/a")], [t("/victim")]]);
    expect(layout.root.kind).toBe("split");
    const next = closeTabsForPathInLayout(layout, "/victim");
    // Single survivor → root should now be the surviving leaf, not a split.
    expect(next.root.kind).toBe("leaf");
    const leaf = next.root as LeafNode;
    expect(leaf.tabs.map((tab) => tab.path)).toEqual(["/a"]);
  });
});

describe("emptyLeaf / leafWithTab / initialLayout", () => {
  it("emptyLeaf has -1 activeIndex", () => {
    const l = emptyLeaf();
    expect(l.activeIndex).toBe(-1);
    expect(l.tabs.length).toBe(0);
  });
  it("leafWithTab seeds activeIndex=0", () => {
    const l = leafWithTab(newTab("/x"));
    expect(l.activeIndex).toBe(0);
    expect(l.tabs[0].path).toBe("/x");
  });
  it("initialLayout root is a leaf with the same id as activeId", () => {
    const layout = initialLayout();
    expect(layout.root.kind).toBe("leaf");
    expect(layout.activeId).toBe(layout.root.id);
  });
});
