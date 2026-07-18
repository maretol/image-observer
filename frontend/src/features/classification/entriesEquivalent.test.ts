import { describe, expect, it } from "vitest";
import type { classification } from "../../../wailsjs/go/models";
import { fileTimesEquivalent } from "./entriesEquivalent";

const entry = (filename: string): classification.Entry =>
  ({ filename, folder: "", confidence: "", note: "" }) as classification.Entry;

// watcher no-op gate の fileTimes 比較 (#144)。entriesEquivalent 本体は watcher 経由の
// 既存挙動で担保済みのため、ここでは新設の fileTimesEquivalent だけを pin する。
describe("fileTimesEquivalent", () => {
  it("returns true when all entry rows match", () => {
    const entries = [entry("a.png"), entry("b.png")];
    const times = { "a.png": 100, "b.png": 200 };
    expect(fileTimesEquivalent(entries, times, { ...times })).toBe(true);
  });

  it("returns false when a displayed file's mtime changed (same-name overwrite)", () => {
    const entries = [entry("a.png"), entry("b.png")];
    expect(
      fileTimesEquivalent(
        entries,
        { "a.png": 100, "b.png": 200 },
        { "a.png": 100, "b.png": 999 },
      ),
    ).toBe(false);
  });

  it("ignores rows for filenames outside entries (in-flight delete leftovers)", () => {
    const entries = [entry("a.png")];
    expect(
      fileTimesEquivalent(
        entries,
        { "a.png": 100, "deleted.png": 50 },
        { "a.png": 100 },
      ),
    ).toBe(true);
  });

  it("treats missing-on-both-sides as equal, missing-on-one-side as different", () => {
    const entries = [entry("a.png")];
    expect(fileTimesEquivalent(entries, {}, {})).toBe(true);
    expect(fileTimesEquivalent(entries, { "a.png": 100 }, {})).toBe(false);
    expect(fileTimesEquivalent(entries, {}, { "a.png": 100 })).toBe(false);
  });

  it("tolerates undefined/null maps", () => {
    const entries = [entry("a.png")];
    expect(fileTimesEquivalent(entries, undefined, undefined)).toBe(true);
    expect(fileTimesEquivalent(entries, null, undefined)).toBe(true);
    expect(fileTimesEquivalent(entries, undefined, { "a.png": 1 })).toBe(false);
    expect(fileTimesEquivalent([], undefined, { "a.png": 1 })).toBe(true);
  });
});
