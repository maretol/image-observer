import { describe, expect, it } from "vitest";
import type { classification } from "../../../wailsjs/go/models";
import { reorderEntries } from "./reorderEntries";
import { canEnterReorderMode } from "./reorderMode";
import type { ListTabFilter } from "./filters";
import { SORT_MANUAL, SORT_NAME_ASC } from "./sortMode";

const entry = (filename: string): classification.Entry =>
  ({ filename, folder: "", confidence: "", note: "" }) as classification.Entry;

const names = (entries: classification.Entry[] | null) =>
  entries?.map((e) => e.filename) ?? null;

describe("reorderEntries", () => {
  const base = () => [
    entry("a.png"),
    entry("b.png"),
    entry("child/x.png"),
    entry("c.png"),
    entry("child/y.png"),
  ];

  it("moves within the root group without disturbing other groups", () => {
    // ルートグループは [a, b, c] (splice 位置 0..3)。c を先頭 (0) へ。
    const out = reorderEntries(base(), "c.png", ".", 0);
    expect(names(out)).toEqual([
      "c.png",
      "a.png",
      "b.png",
      "child/x.png",
      "child/y.png",
    ]);
  });

  it("moves forward within a group (insert index counted before removal)", () => {
    // a をグループ内位置 2 (= c の前) へ。挿入は anchor member (c) の直前なので、
    // グループ外 entry (child/x) は a より前に残る — グループ射影順 [b, a, c] が不変条件で、
    // グループ外との相対位置は表示に影響しない。
    const out = reorderEntries(base(), "a.png", ".", 2);
    expect(names(out)).toEqual([
      "b.png",
      "child/x.png",
      "a.png",
      "c.png",
      "child/y.png",
    ]);
  });

  it("moves to the group tail with insertIdx == group length", () => {
    const out = reorderEntries(base(), "a.png", ".", 3);
    // ルートグループ最終 member (c.png) の直後 = child/y.png の前。
    expect(names(out)).toEqual([
      "b.png",
      "child/x.png",
      "c.png",
      "a.png",
      "child/y.png",
    ]);
  });

  it("moves within a subdirectory group", () => {
    const out = reorderEntries(base(), "child/y.png", "child", 0);
    expect(names(out)).toEqual([
      "a.png",
      "b.png",
      "child/y.png",
      "child/x.png",
      "c.png",
    ]);
  });

  it("returns null for visual no-op slots (src position and src position + 1)", () => {
    expect(reorderEntries(base(), "b.png", ".", 1)).toBeNull();
    expect(reorderEntries(base(), "b.png", ".", 2)).toBeNull();
  });

  it("returns null for cross-group or unknown src", () => {
    expect(reorderEntries(base(), "a.png", "child", 0)).toBeNull();
    expect(reorderEntries(base(), "missing.png", ".", 0)).toBeNull();
    expect(reorderEntries(base(), "a.png", ".", -1)).toBeNull();
    expect(reorderEntries(base(), "a.png", ".", 4)).toBeNull();
  });

  it("does not mutate the input array", () => {
    const input = base();
    reorderEntries(input, "c.png", ".", 0);
    expect(names(input)).toEqual([
      "a.png",
      "b.png",
      "child/x.png",
      "c.png",
      "child/y.png",
    ]);
  });
});

describe("canEnterReorderMode", () => {
  const emptyFilter: ListTabFilter = {
    tags: [],
    untaggedOnly: false,
    confidence: "all",
    query: "",
  };

  it("allows manual sort with no filters", () => {
    expect(canEnterReorderMode(SORT_MANUAL, emptyFilter)).toBe(true);
  });

  it("rejects non-manual sort", () => {
    expect(canEnterReorderMode(SORT_NAME_ASC, emptyFilter)).toBe(false);
  });

  it("rejects any active filter axis", () => {
    expect(
      canEnterReorderMode(SORT_MANUAL, { ...emptyFilter, tags: ["iroha"] }),
    ).toBe(false);
    expect(
      canEnterReorderMode(SORT_MANUAL, { ...emptyFilter, untaggedOnly: true }),
    ).toBe(false);
    expect(
      canEnterReorderMode(SORT_MANUAL, { ...emptyFilter, confidence: "high" }),
    ).toBe(false);
    expect(
      canEnterReorderMode(SORT_MANUAL, { ...emptyFilter, query: "x" }),
    ).toBe(false);
  });
});
