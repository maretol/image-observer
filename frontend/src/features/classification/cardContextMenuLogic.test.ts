import { describe, expect, it } from "vitest";
import {
  SPLIT_OPEN_LIMIT,
  canBulkSplitOpen,
  computeCardContextMenuMode,
} from "./cardContextMenuLogic";

describe("computeCardContextMenuMode", () => {
  it("returns single when selection is empty", () => {
    expect(computeCardContextMenuMode([], "a.png")).toBe("single");
  });

  it("returns bulk when the right-clicked filename is in selection", () => {
    expect(computeCardContextMenuMode(["a.png", "b.png"], "a.png")).toBe(
      "bulk",
    );
  });

  it("returns single when selection has entries but right-clicked card is not in it (spec §11-D)", () => {
    expect(computeCardContextMenuMode(["a.png", "b.png"], "c.png")).toBe(
      "single",
    );
  });

  it("treats duplicate filenames in selection as a single membership check", () => {
    // selection is stored as a Set in useClassification so duplicates should
    // not occur; this is a defensive check on the readonly[] surface.
    expect(
      computeCardContextMenuMode(["a.png", "a.png", "b.png"], "a.png"),
    ).toBe("bulk");
  });
});

describe("canBulkSplitOpen", () => {
  it("rejects an empty selection", () => {
    expect(canBulkSplitOpen(0)).toBe(false);
  });

  it("allows 1 (smallest non-empty selection)", () => {
    expect(canBulkSplitOpen(1)).toBe(true);
  });

  it("allows exactly SPLIT_OPEN_LIMIT (8 by spec)", () => {
    expect(canBulkSplitOpen(SPLIT_OPEN_LIMIT)).toBe(true);
  });

  it("rejects SPLIT_OPEN_LIMIT + 1", () => {
    expect(canBulkSplitOpen(SPLIT_OPEN_LIMIT + 1)).toBe(false);
  });
});
