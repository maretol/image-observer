// Pure-function tests for the reorder hook (#50). The hook itself is not
// exercised here — that would require a DOM test rig the project hasn't
// adopted (context.md §5). The splice-index math is the only piece that has
// real branching, so we isolate it into computeInsertIdxFromRects and test
// that against RectLike fixtures.

import { describe, expect, it } from "vitest";
import {
  computeInsertIdxFromRects,
  type RectLike,
} from "./useViewerTabReorder";

// Tab rects shaped like a typical top-tab row: 80px wide each, starting at
// x=100 with no gaps. Index `i` covers [100 + 80i, 100 + 80(i+1)) → midpoint
// at 140 + 80i.
function row(n: number): RectLike[] {
  return Array.from({ length: n }, (_, i) => ({
    left: 100 + 80 * i,
    width: 80,
  }));
}

describe("computeInsertIdxFromRects", () => {
  it("returns 0 when x is well left of the first tab", () => {
    expect(computeInsertIdxFromRects(row(3), 0)).toBe(0);
  });
  it("returns 0 on the left half of the first tab", () => {
    // Tab 0: [100, 180). Midpoint = 140. x=120 is left half → before tab 0.
    expect(computeInsertIdxFromRects(row(3), 120)).toBe(0);
  });
  it("returns 1 on the right half of the first tab", () => {
    // Tab 0 right half [140, 180) → after tab 0 (= before tab 1).
    expect(computeInsertIdxFromRects(row(3), 160)).toBe(1);
  });
  it("returns the index of the tab whose midpoint is just past x", () => {
    // Tab 1: [180, 260). Midpoint = 220. x=200 < 220 → before tab 1.
    expect(computeInsertIdxFromRects(row(3), 200)).toBe(1);
    // x=240 > 220 → after tab 1.
    expect(computeInsertIdxFromRects(row(3), 240)).toBe(2);
  });
  it("returns rects.length when x is past every tab's midpoint", () => {
    // Tab 2: [260, 340). Midpoint = 300. x=999 → append.
    expect(computeInsertIdxFromRects(row(3), 999)).toBe(3);
  });
  it("handles a 1-tab row (only 0 or 1 possible)", () => {
    expect(computeInsertIdxFromRects(row(1), 120)).toBe(0); // left half
    expect(computeInsertIdxFromRects(row(1), 160)).toBe(1); // right half / past
  });
  it("returns 0 for an empty row (no tabs to insert before)", () => {
    expect(computeInsertIdxFromRects([], 100)).toBe(0);
  });
  it("treats x exactly at a midpoint as the right half (>=)", () => {
    // x === midpoint of tab 0 (=140): `x < left + width/2` is false → next tab.
    expect(computeInsertIdxFromRects(row(2), 140)).toBe(1);
  });
});
