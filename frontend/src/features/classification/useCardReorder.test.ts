import { describe, expect, it } from "vitest";
import { computeGridInsertIdx, type GridRectLike } from "./useCardReorder";

// 2 列 × 2 行の row-major grid (各セル 100×100、gap 10)。
//   [0] (0,0)    [1] (110,0)
//   [2] (0,110)  [3] (110,110)
const grid: GridRectLike[] = [
  { left: 0, top: 0, width: 100, height: 100 },
  { left: 110, top: 0, width: 100, height: 100 },
  { left: 0, top: 110, width: 100, height: 100 },
  { left: 110, top: 110, width: 100, height: 100 },
];

describe("computeGridInsertIdx", () => {
  it("inserts before a card when x is left of its midpoint in the row band", () => {
    expect(computeGridInsertIdx(grid, 10, 50)).toBe(0);
    expect(computeGridInsertIdx(grid, 120, 50)).toBe(1);
    expect(computeGridInsertIdx(grid, 10, 160)).toBe(2);
  });

  it("inserts after a card when x is right of its midpoint", () => {
    // row 0 の card[0] 中点 (50) より右、card[1] 中点 (160) より左 → 1 (card[1] の前)。
    expect(computeGridInsertIdx(grid, 100, 50)).toBe(1);
    // row 0 の右端を越えた → 行帯を抜けて card[2] (次行先頭) = 行末 append と同義。
    expect(computeGridInsertIdx(grid, 200, 50)).toBe(2);
  });

  it("treats pointer above the first row as index 0", () => {
    expect(computeGridInsertIdx(grid, 150, -20)).toBe(0);
  });

  it("treats pointer below the last row as append", () => {
    expect(computeGridInsertIdx(grid, 50, 300)).toBe(4);
  });

  it("row gap belongs to the next row (y between rows → first card of next row)", () => {
    expect(computeGridInsertIdx(grid, 50, 105)).toBe(2);
  });

  it("returns 0 for an empty grid", () => {
    expect(computeGridInsertIdx([], 10, 10)).toBe(0);
  });
});
