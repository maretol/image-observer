import { describe, expect, it } from "vitest";
import { arrowDirection, pickGridNeighbor, type CardRect } from "./gridNav";

// Build a `cols`-wide grid of `count` unit cards (100x100, no gap) in reading
// order. Index i sits at row = floor(i/cols), col = i%cols. The last row may
// be partial — exactly the layout the list produces for an odd card count.
function grid(count: number, cols: number): CardRect[] {
  const rects: CardRect[] = [];
  for (let i = 0; i < count; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    rects.push({
      left: c * 100,
      right: c * 100 + 100,
      top: r * 100,
      bottom: r * 100 + 100,
    });
  }
  return rects;
}

describe("arrowDirection", () => {
  it("maps the four arrow keys", () => {
    expect(arrowDirection("ArrowLeft")).toBe("left");
    expect(arrowDirection("ArrowRight")).toBe("right");
    expect(arrowDirection("ArrowUp")).toBe("up");
    expect(arrowDirection("ArrowDown")).toBe("down");
  });
  it("returns null for non-arrow keys", () => {
    expect(arrowDirection("Enter")).toBeNull();
    expect(arrowDirection("a")).toBeNull();
    expect(arrowDirection(" ")).toBeNull();
  });
});

describe("pickGridNeighbor", () => {
  // 4-column grid, 10 cards (last row partial: indices 8,9). Mirrors the
  // issue #115 example: focus on card index 5 ("6"), → 6, ← 4, ↑ 1, ↓ 9.
  // left/right pass only the count (no rects — proving horizontal moves never
  // need geometry); up/down pass the rects as the 4th arg.
  const g = grid(10, 4);

  it("moves left/right in reading order (no rects needed)", () => {
    expect(pickGridNeighbor(g.length, 5, "right")).toBe(6);
    expect(pickGridNeighbor(g.length, 5, "left")).toBe(4);
  });

  it("moves up/down to the same column in the adjacent row", () => {
    expect(pickGridNeighbor(g.length, 5, "up", g)).toBe(1);
    expect(pickGridNeighbor(g.length, 5, "down", g)).toBe(9);
  });

  it("down from a full row lands on the closest column of a partial row", () => {
    // index 6 (col 2, cx=250); partial last row has cols 0 (cx=50) and 1
    // (cx=150). 150 is closest to 250, so card 9.
    expect(pickGridNeighbor(g.length, 6, "down", g)).toBe(9);
  });

  it("returns null at the edges", () => {
    expect(pickGridNeighbor(g.length, 0, "left")).toBeNull();
    expect(pickGridNeighbor(g.length, 9, "right")).toBeNull();
    expect(pickGridNeighbor(g.length, 1, "up", g)).toBeNull(); // top row
    expect(pickGridNeighbor(g.length, 9, "down", g)).toBeNull(); // bottom row
  });

  it("crosses rows when moving right past the end of a row", () => {
    // index 3 is the last card of row 0; right goes to index 4 (row 1, col 0).
    expect(pickGridNeighbor(g.length, 3, "right")).toBe(4);
  });

  it("up/down are null in a single-row grid", () => {
    const oneRow = grid(3, 4);
    expect(pickGridNeighbor(oneRow.length, 1, "up", oneRow)).toBeNull();
    expect(pickGridNeighbor(oneRow.length, 1, "down", oneRow)).toBeNull();
  });

  it("picks the nearest row, not a farther aligned one", () => {
    // 3 rows, current at bottom (index 8, col 0). Up must pick row 1 (index 4),
    // not the perfectly-aligned card two rows up (index 0).
    expect(pickGridNeighbor(g.length, 8, "up", g)).toBe(4);
  });

  it("returns null for up/down when rects are omitted", () => {
    // The caller skips the getBoundingClientRect sweep on horizontal moves, so
    // a vertical move without rects has no geometry to work with.
    expect(pickGridNeighbor(g.length, 5, "up")).toBeNull();
    expect(pickGridNeighbor(g.length, 5, "down")).toBeNull();
  });

  it("returns null for an out-of-range index", () => {
    expect(pickGridNeighbor(g.length, -1, "right")).toBeNull();
    expect(pickGridNeighbor(g.length, 99, "up", g)).toBeNull();
  });
});
