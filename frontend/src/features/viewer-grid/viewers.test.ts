import { describe, expect, it } from "vitest";
import {
  appendOrFocusInActive,
  initialLayout,
  splitTabIntoEdge,
  type Layout,
} from "./layout";
import { newTab } from "./useTabs";
import {
  addViewer,
  closeViewer,
  cycleViewerId,
  initialViewerSet,
  MAX_VIEWERS,
  MAX_VIEWERS_HARD,
  MIN_VIEWERS,
  moveTabAcrossViewers,
  moveViewer,
  newViewer,
  openPathInViewer,
  renameViewer,
  sanitizeName,
  setActiveViewer,
  suggestViewerName,
  updateViewerLayout,
  type ViewerSet,
} from "./viewers";

// ─── builders ────────────────────────────────────────────────────────

function viewerWith(name: string, layout: Layout = initialLayout()) {
  return { ...newViewer(name), layout };
}

// build a ViewerSet with N empty viewers named "ビューア 1".."ビューア N";
// active = first.
function setN(n: number): ViewerSet {
  let s: ViewerSet = initialViewerSet();
  // initialViewerSet already creates 1; add n-1 more.
  for (let i = 1; i < n; i++) s = addViewer(s);
  // Reset active to first viewer for predictability.
  s = setActiveViewer(s, s.viewers[0].id);
  return s;
}

// ─── constants (AGENTS.md D-1 ドリフト検知) ─────────────────────────

// これらのリテラルは Go 側 `internal/settings.defaultMaxViewers` / `minMaxViewers` /
// `MaxViewersHardCap` (= `state.maxViewersHard`、TestMaxViewersHardMatchesSettings が pin)
// と二重管理 (#148)。片側だけ変えると、設定 UI の NumberInput 範囲と Go Validate の範囲が
// ズレて、UI が許した値を Save が弾き silent に既定 8 へ戻る (duplicateDetect.test.ts と
// 同じ役割)。
describe("viewer limit constants", () => {
  it("default / bounds match the Go side literals", () => {
    expect(MAX_VIEWERS).toBe(8);
    expect(MIN_VIEWERS).toBe(1);
    expect(MAX_VIEWERS_HARD).toBe(32);
  });
});

// ─── suggestViewerName ──────────────────────────────────────────────

describe("suggestViewerName", () => {
  it("starts at 1 with no existing names", () => {
    expect(suggestViewerName([])).toBe("ビューア 1");
  });
  it("picks the smallest unused integer", () => {
    expect(suggestViewerName(["ビューア 1", "ビューア 2"])).toBe("ビューア 3");
  });
  it("fills the smallest gap, not max+1", () => {
    expect(suggestViewerName(["ビューア 1", "ビューア 3"])).toBe("ビューア 2");
  });
  it("ignores names that don't match the auto pattern", () => {
    expect(
      suggestViewerName(["デザインレビュー", "ビューア 1", "ビューア_2"]),
    ).toBe("ビューア 2");
  });
});

// ─── sanitizeName ───────────────────────────────────────────────────

describe("sanitizeName", () => {
  it("trims surrounding whitespace", () => {
    expect(sanitizeName("  hello  ")).toBe("hello");
  });
  it("returns null for empty/whitespace-only input", () => {
    expect(sanitizeName("")).toBeNull();
    expect(sanitizeName("   ")).toBeNull();
    expect(sanitizeName("\t\n")).toBeNull();
  });
  it("strips ASCII control chars and DEL", () => {
    expect(sanitizeName("hi\nthere")).toBe("hithere");
    expect(sanitizeName("a\x01b\x7fc")).toBe("abc");
  });
  it("rune-truncates to 32 chars (Japanese counts as 1 rune each)", () => {
    const long = "あ".repeat(100);
    const out = sanitizeName(long)!;
    expect(Array.from(out).length).toBe(32);
  });
  it("preserves names within the limit", () => {
    expect(sanitizeName("ビューア 1")).toBe("ビューア 1");
    expect(sanitizeName("デザインレビュー")).toBe("デザインレビュー");
  });
});

// ─── addViewer ──────────────────────────────────────────────────────

describe("addViewer", () => {
  it("appends a new viewer and switches active to it", () => {
    const s0 = initialViewerSet();
    const s1 = addViewer(s0);
    expect(s1.viewers).toHaveLength(2);
    expect(s1.activeViewerId).toBe(s1.viewers[1].id);
    expect(s1.viewers[1].name).toBe("ビューア 2");
  });
  it("uses gap-filling auto-numbering", () => {
    let s = initialViewerSet(); // [ビューア 1]
    s = addViewer(s); // [ビューア 1, ビューア 2]
    s = addViewer(s); // [ビューア 1, ビューア 2, ビューア 3]
    s = closeViewer(s, s.viewers[1].id); // remove "ビューア 2"
    s = addViewer(s); // should backfill ビューア 2
    const names = s.viewers.map((v) => v.name);
    expect(names).toEqual(["ビューア 1", "ビューア 3", "ビューア 2"]);
  });
  it("refuses to exceed the default MAX_VIEWERS when max is omitted", () => {
    const full = setN(MAX_VIEWERS);
    expect(full.viewers).toHaveLength(MAX_VIEWERS);
    const next = addViewer(full);
    expect(next).toBe(full); // referential no-op
  });
  it("allows exceeding MAX_VIEWERS when a larger max is given (#148)", () => {
    const full = setN(MAX_VIEWERS);
    const next = addViewer(full, MAX_VIEWERS + 4);
    expect(next.viewers).toHaveLength(MAX_VIEWERS + 1);
  });
  it("refuses at a custom max below the default", () => {
    const s = setN(3);
    expect(addViewer(s, 3)).toBe(s);
  });
  it("refuses (without truncating) when the set already exceeds max", () => {
    // 上限を下げた後の状態 (#148 D2): 既存 viewer は削らず追加だけ拒否する。
    const s = setN(5);
    const next = addViewer(s, 3);
    expect(next).toBe(s);
    expect(next.viewers).toHaveLength(5);
  });
});

// ─── closeViewer ────────────────────────────────────────────────────

describe("closeViewer", () => {
  it("refuses to close the last viewer", () => {
    const s = initialViewerSet();
    expect(closeViewer(s, s.viewers[0].id)).toBe(s);
  });
  it("no-ops on unknown id", () => {
    const s = setN(2);
    expect(closeViewer(s, "missing-id")).toBe(s);
  });
  it("active falls forward to the same index in the new array", () => {
    const s = setN(3);
    const active = setActiveViewer(s, s.viewers[1].id); // active = idx 1
    const after = closeViewer(active, active.viewers[1].id); // remove idx 1
    expect(after.viewers).toHaveLength(2);
    // new viewer at idx 1 was the previous viewers[2].
    expect(after.activeViewerId).toBe(s.viewers[2].id);
  });
  it("active falls back to the previous index when removed at the tail", () => {
    const s = setN(3);
    const active = setActiveViewer(s, s.viewers[2].id); // active = last
    const after = closeViewer(active, active.viewers[2].id);
    expect(after.activeViewerId).toBe(s.viewers[1].id);
  });
  it("non-active close keeps active unchanged", () => {
    const s = setN(3);
    const before = setActiveViewer(s, s.viewers[0].id);
    const after = closeViewer(before, s.viewers[2].id);
    expect(after.activeViewerId).toBe(s.viewers[0].id);
  });
});

// ─── renameViewer ───────────────────────────────────────────────────

describe("renameViewer", () => {
  it("updates the targeted viewer's name", () => {
    const s = setN(2);
    const next = renameViewer(s, s.viewers[1].id, "  デザインレビュー  ");
    expect(next.viewers[1].name).toBe("デザインレビュー");
    expect(next.viewers[0].name).toBe("ビューア 1");
  });
  it("rejects empty/whitespace as no-op", () => {
    const s = setN(2);
    expect(renameViewer(s, s.viewers[1].id, "   ")).toBe(s);
    expect(renameViewer(s, s.viewers[1].id, "")).toBe(s);
  });
  it("rune-truncates to 32 chars", () => {
    const s = setN(1);
    const next = renameViewer(s, s.viewers[0].id, "あ".repeat(100));
    expect(Array.from(next.viewers[0].name).length).toBe(32);
  });
  it("allows duplicate names (internal id is the key)", () => {
    let s = setN(2);
    s = renameViewer(s, s.viewers[1].id, "ビューア 1");
    expect(s.viewers[0].name).toBe("ビューア 1");
    expect(s.viewers[1].name).toBe("ビューア 1");
  });
  it("no-ops on unknown id", () => {
    const s = setN(1);
    expect(renameViewer(s, "missing", "X")).toBe(s);
  });
});

// ─── setActiveViewer ────────────────────────────────────────────────

describe("moveViewer", () => {
  // Helper: snapshot the order of viewer names so test expectations stay
  // independent of generated ids.
  const names = (s: ViewerSet) => s.viewers.map((v) => v.name);

  // build a fresh 4-viewer set with predictable names A..D.
  function setABCD(): ViewerSet {
    let s = initialViewerSet();
    s = renameViewer(s, s.viewers[0].id, "A");
    for (const name of ["B", "C", "D"]) {
      s = addViewer(s);
      s = renameViewer(s, s.viewers[s.viewers.length - 1].id, name);
    }
    return s;
  }

  it("moves first viewer to the end (fromIdx=0, toIdx=4 for len=4)", () => {
    const s = setABCD();
    const next = moveViewer(s, 0, 4);
    expect(names(next)).toEqual(["B", "C", "D", "A"]);
  });
  it("moves last viewer to the head (fromIdx=3, toIdx=0)", () => {
    const s = setABCD();
    const next = moveViewer(s, 3, 0);
    expect(names(next)).toEqual(["D", "A", "B", "C"]);
  });
  it("no-ops when toIdx === fromIdx", () => {
    const s = setABCD();
    expect(moveViewer(s, 1, 1)).toBe(s);
  });
  it("no-ops when toIdx === fromIdx + 1 (visual position unchanged)", () => {
    const s = setABCD();
    expect(moveViewer(s, 1, 2)).toBe(s);
  });
  it("moves leftward by one (fromIdx=1, toIdx=0)", () => {
    const s = setABCD();
    const next = moveViewer(s, 1, 0);
    expect(names(next)).toEqual(["B", "A", "C", "D"]);
  });
  it("rejects out-of-range fromIdx (negative)", () => {
    const s = setABCD();
    expect(moveViewer(s, -1, 0)).toBe(s);
  });
  it("rejects out-of-range fromIdx (past end)", () => {
    const s = setABCD();
    expect(moveViewer(s, 5, 0)).toBe(s);
  });
  it("clamps too-large toIdx to len (= append)", () => {
    const s = setABCD();
    const next = moveViewer(s, 0, 99);
    expect(names(next)).toEqual(["B", "C", "D", "A"]);
  });
  it("clamps negative toIdx to 0 (= prepend)", () => {
    const s = setABCD();
    const next = moveViewer(s, 3, -5);
    expect(names(next)).toEqual(["D", "A", "B", "C"]);
  });
  it("no-ops when viewers.length === 1", () => {
    const s = initialViewerSet();
    expect(moveViewer(s, 0, 0)).toBe(s);
    expect(moveViewer(s, 0, 1)).toBe(s);
  });
  it("preserves activeViewerId across reorder", () => {
    // addViewer activates the added viewer, so setABCD() leaves active = D.
    // Pin active to A explicitly so the assertion below is unambiguous.
    let s = setABCD();
    s = setActiveViewer(s, s.viewers[0].id);
    const activeId = s.activeViewerId;
    const next = moveViewer(s, 0, 4);
    expect(next.activeViewerId).toBe(activeId);
    // A moved to the end; activeViewerId still points at A (now at index 3).
    expect(next.viewers[3].id).toBe(activeId);
  });
});

describe("setActiveViewer", () => {
  it("switches active when target exists", () => {
    const s = setN(3);
    const next = setActiveViewer(s, s.viewers[2].id);
    expect(next.activeViewerId).toBe(s.viewers[2].id);
  });
  it("no-ops when target is already active", () => {
    const s = setN(2);
    expect(setActiveViewer(s, s.activeViewerId)).toBe(s);
  });
  it("no-ops on unknown id", () => {
    const s = setN(1);
    expect(setActiveViewer(s, "missing")).toBe(s);
  });
});

// ─── cycleViewerId (#149) ───────────────────────────────────────────

describe("cycleViewerId", () => {
  const viewers = [{ id: "a" }, { id: "b" }, { id: "c" }];
  it("next は次の viewer、末尾からは先頭へ wrap する", () => {
    expect(cycleViewerId(viewers, "a", "next")).toBe("b");
    expect(cycleViewerId(viewers, "c", "next")).toBe("a");
  });
  it("prev は前の viewer、先頭からは末尾へ wrap する", () => {
    expect(cycleViewerId(viewers, "b", "prev")).toBe("a");
    expect(cycleViewerId(viewers, "a", "prev")).toBe("c");
  });
  it("viewer 1 個は同じ id を返す (呼び出し側の same-id guard で no-op)", () => {
    expect(cycleViewerId([{ id: "only" }], "only", "next")).toBe("only");
    expect(cycleViewerId([{ id: "only" }], "only", "prev")).toBe("only");
  });
  it("activeViewerId 不明は先頭へ fallback、空配列は null", () => {
    expect(cycleViewerId(viewers, "missing", "next")).toBe("a");
    expect(cycleViewerId([], "a", "next")).toBeNull();
  });
});

// ─── moveTabAcrossViewers ───────────────────────────────────────────

describe("moveTabAcrossViewers", () => {
  // Helper: build a 2-viewer set with one tab in each viewer's only leaf.
  function setupTwoViewers() {
    let s = initialViewerSet();
    s = addViewer(s); // adds viewer 2, activates it
    // Put "/a.jpg" in viewer 1's leaf
    const v1 = s.viewers[0];
    const layout1 = appendOrFocusInActive(v1.layout, "/a.jpg");
    s = updateViewerLayout(s, v1.id, layout1);
    // Put "/b.jpg" in viewer 2's leaf
    const v2 = s.viewers[1];
    const layout2 = appendOrFocusInActive(v2.layout, "/b.jpg");
    s = updateViewerLayout(s, v2.id, layout2);
    return s;
  }

  it("moves tab from src to dst's active leaf", () => {
    const s = setupTwoViewers();
    const v1 = s.viewers[0];
    const v2 = s.viewers[1];
    const srcLeaf = v1.layout.root;
    expect(srcLeaf.kind).toBe("leaf");
    const next = moveTabAcrossViewers(s, v1.id, srcLeaf.id, 0, v2.id);
    const newV1 = next.viewers[0];
    const newV2 = next.viewers[1];
    expect(newV1.layout.root.kind === "leaf" && newV1.layout.root.tabs).toEqual(
      [],
    );
    if (newV2.layout.root.kind !== "leaf") throw new Error("dst not leaf");
    expect(newV2.layout.root.tabs.map((t) => t.path)).toEqual([
      "/b.jpg",
      "/a.jpg",
    ]);
    expect(newV2.layout.root.activeIndex).toBe(1); // moved tab is the new active
  });

  it("leaves activeViewerId unchanged after move", () => {
    const s = setupTwoViewers();
    const sActive = setActiveViewer(s, s.viewers[0].id);
    const srcLeaf = sActive.viewers[0].layout.root;
    const next = moveTabAcrossViewers(
      sActive,
      sActive.viewers[0].id,
      srcLeaf.id,
      0,
      sActive.viewers[1].id,
    );
    expect(next.activeViewerId).toBe(sActive.viewers[0].id);
  });

  it("dedupes by path: focuses existing tab, src tab still removed", () => {
    let s = setupTwoViewers();
    // Add "/shared.jpg" to BOTH viewers.
    const v1 = s.viewers[0];
    s = updateViewerLayout(
      s,
      v1.id,
      appendOrFocusInActive(s.viewers[0].layout, "/shared.jpg"),
    );
    const v2 = s.viewers[1];
    s = updateViewerLayout(
      s,
      v2.id,
      appendOrFocusInActive(s.viewers[1].layout, "/shared.jpg"),
    );
    // Now v1 has [/a.jpg, /shared.jpg], v2 has [/b.jpg, /shared.jpg].
    const srcLeaf = s.viewers[0].layout.root;
    if (srcLeaf.kind !== "leaf") throw new Error("src not leaf");
    const sharedIdx = srcLeaf.tabs.findIndex((t) => t.path === "/shared.jpg");
    const next = moveTabAcrossViewers(
      s,
      s.viewers[0].id,
      srcLeaf.id,
      sharedIdx,
      s.viewers[1].id,
    );
    const newV1 = next.viewers[0];
    const newV2 = next.viewers[1];
    if (newV1.layout.root.kind !== "leaf") throw new Error();
    if (newV2.layout.root.kind !== "leaf") throw new Error();
    // src loses /shared.jpg
    expect(newV1.layout.root.tabs.map((t) => t.path)).toEqual(["/a.jpg"]);
    // dst keeps its existing /shared.jpg without duplicate, focus moves to it
    expect(newV2.layout.root.tabs.map((t) => t.path)).toEqual([
      "/b.jpg",
      "/shared.jpg",
    ]);
    expect(newV2.layout.root.activeIndex).toBe(1);
  });

  it("preserves zoom/pan/initialized fields on the moved tab", () => {
    let s = setupTwoViewers();
    // Mutate tab state in v1
    const v1 = s.viewers[0];
    if (v1.layout.root.kind !== "leaf") throw new Error();
    const tab = v1.layout.root.tabs[0];
    const fancyTab = { ...tab, zoom: 2.5, panX: 50, panY: -30, initialized: true, imageWidth: 800, imageHeight: 600 };
    const newRoot = { ...v1.layout.root, tabs: [fancyTab], activeIndex: 0 };
    s = updateViewerLayout(s, v1.id, { ...v1.layout, root: newRoot });
    const next = moveTabAcrossViewers(
      s,
      s.viewers[0].id,
      newRoot.id,
      0,
      s.viewers[1].id,
    );
    const newV2 = next.viewers[1];
    if (newV2.layout.root.kind !== "leaf") throw new Error();
    const moved = newV2.layout.root.tabs.find((t) => t.path === "/a.jpg")!;
    expect(moved.zoom).toBe(2.5);
    expect(moved.panX).toBe(50);
    expect(moved.panY).toBe(-30);
    expect(moved.initialized).toBe(true);
    expect(moved.imageWidth).toBe(800);
  });

  it("collapses src leaf when the move empties it (split tree)", () => {
    let s = setupTwoViewers();
    // Make v1's layout a split: [tab /a.jpg | empty leaf]
    const v1 = s.viewers[0];
    const r = splitTabIntoEdge(v1.layout, v1.layout.activeId, 0, v1.layout.activeId, "right");
    expect(r.ok).toBe(false); // single-tab leaf can't split via this path
    // Use a different approach: add a 2nd tab to src, split the tab to a sibling, then move the original.
    let layout1 = appendOrFocusInActive(v1.layout, "/c.jpg");
    s = updateViewerLayout(s, v1.id, layout1);
    const v1WithTwo = s.viewers[0];
    if (v1WithTwo.layout.root.kind !== "leaf") throw new Error();
    const splitRes = splitTabIntoEdge(
      v1WithTwo.layout,
      v1WithTwo.layout.activeId,
      0, // /a.jpg
      v1WithTwo.layout.activeId,
      "right",
    );
    expect(splitRes.ok).toBe(true);
    s = updateViewerLayout(s, v1WithTwo.id, splitRes.layout);
    // Now v1 root is a split with two leaves; one holding /c.jpg, the other /a.jpg.
    // Find the /a.jpg leaf.
    const v1Split = s.viewers[0];
    function findLeafWithPath(node: typeof v1Split.layout.root, path: string): { id: string; tabIdx: number } | null {
      if (node.kind === "leaf") {
        const idx = node.tabs.findIndex((t) => t.path === path);
        return idx >= 0 ? { id: node.id, tabIdx: idx } : null;
      }
      return findLeafWithPath(node.a, path) ?? findLeafWithPath(node.b, path);
    }
    const target = findLeafWithPath(v1Split.layout.root, "/a.jpg");
    expect(target).not.toBeNull();
    const next = moveTabAcrossViewers(
      s,
      v1Split.id,
      target!.id,
      target!.tabIdx,
      s.viewers[1].id,
    );
    // Now v1's split should have collapsed: the surviving leaf with /c.jpg becomes root.
    const finalV1 = next.viewers[0];
    expect(finalV1.layout.root.kind).toBe("leaf");
    if (finalV1.layout.root.kind === "leaf") {
      expect(finalV1.layout.root.tabs.map((t) => t.path)).toEqual(["/c.jpg"]);
    }
    // v1 active resolves to the surviving leaf.
    expect(finalV1.layout.activeId).toBe(finalV1.layout.root.id);
  });

  it("no-ops when src == dst", () => {
    const s = setupTwoViewers();
    const v1 = s.viewers[0];
    const next = moveTabAcrossViewers(s, v1.id, v1.layout.root.id, 0, v1.id);
    expect(next).toBe(s);
  });

  it("no-ops on unknown viewer id", () => {
    const s = setupTwoViewers();
    expect(
      moveTabAcrossViewers(s, "missing", s.viewers[0].layout.root.id, 0, s.viewers[1].id),
    ).toBe(s);
    expect(
      moveTabAcrossViewers(s, s.viewers[0].id, s.viewers[0].layout.root.id, 0, "missing"),
    ).toBe(s);
  });

  it("no-ops on out-of-range src tab index", () => {
    const s = setupTwoViewers();
    const v1 = s.viewers[0];
    expect(moveTabAcrossViewers(s, v1.id, v1.layout.root.id, 99, s.viewers[1].id)).toBe(s);
  });
});

// ─── openPathInViewer ───────────────────────────────────────────────

describe("openPathInViewer", () => {
  it("opens path in target viewer's active leaf without changing active", () => {
    const s = setN(2);
    const before = setActiveViewer(s, s.viewers[0].id);
    const next = openPathInViewer(before, before.viewers[1].id, "/a.jpg");
    expect(next.activeViewerId).toBe(before.viewers[0].id);
    if (next.viewers[1].layout.root.kind !== "leaf") throw new Error();
    expect(next.viewers[1].layout.root.tabs.map((t) => t.path)).toEqual([
      "/a.jpg",
    ]);
  });
  it("no-ops on unknown viewer", () => {
    const s = setN(1);
    expect(openPathInViewer(s, "missing", "/a.jpg")).toBe(s);
  });
});

// ─── updateViewerLayout (referential identity) ──────────────────────

describe("updateViewerLayout", () => {
  it("returns same set when layout reference is unchanged", () => {
    const s = setN(2);
    const same = updateViewerLayout(s, s.viewers[0].id, s.viewers[0].layout);
    expect(same).toBe(s);
  });
  it("no-ops on unknown viewer", () => {
    const s = setN(1);
    expect(updateViewerLayout(s, "missing", initialLayout())).toBe(s);
  });
});

// ─── housekeeping ────────────────────────────────────────────────────

describe("viewerWith helper unused export check", () => {
  it("composes builders correctly", () => {
    // Smoke check so the helper isn't dead code.
    const v = viewerWith("X");
    expect(v.name).toBe("X");
    expect(v.layout.root.kind).toBe("leaf");
  });
});

describe("newTab availability", () => {
  // makeNewTab forwards to layout's newTab; this test asserts the import path.
  it("is invocable", () => {
    const t = newTab("/x.jpg");
    expect(t.path).toBe("/x.jpg");
    expect(t.zoom).toBe(0);
  });
});
