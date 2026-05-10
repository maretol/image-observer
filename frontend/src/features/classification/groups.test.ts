import { describe, expect, it } from "vitest";
import type { classification } from "../../../wailsjs/go/models";
import {
  ROOT_GROUP_KEY,
  ROOT_GROUP_LABEL,
  groupByDirectory,
  groupKeyOf,
} from "./groups";

const entry = (filename: string): classification.Entry =>
  ({ filename, folder: "", confidence: "", note: "" }) as classification.Entry;

describe("groupKeyOf", () => {
  it("returns ROOT_GROUP_KEY for files with no slash", () => {
    expect(groupKeyOf("a.jpg")).toBe(ROOT_GROUP_KEY);
  });

  it("returns the directory portion for one-level files", () => {
    expect(groupKeyOf("child1/x.png")).toBe("child1");
  });

  it("preserves nested directory paths", () => {
    expect(groupKeyOf("child1/sub/y.gif")).toBe("child1/sub");
  });
});

describe("groupByDirectory", () => {
  it("places root entries first, then sorts subgroups alphabetically", () => {
    const groups = groupByDirectory([
      entry("zebra.jpg"),
      entry("child2/d.png"),
      entry("child1/a.png"),
      entry("alpha.jpg"),
    ]);
    expect(groups.map((g) => g.key)).toEqual([
      ROOT_GROUP_KEY,
      "child1",
      "child2",
    ]);
    expect(groups[0].entries.map((e) => e.filename)).toEqual([
      "zebra.jpg",
      "alpha.jpg",
    ]);
  });

  it("uses the friendly label for the root group", () => {
    const groups = groupByDirectory([entry("a.jpg")]);
    expect(groups[0].label).toBe(ROOT_GROUP_LABEL);
  });

  it("uses the directory key as the label for subgroups", () => {
    const groups = groupByDirectory([entry("child1/x.png")]);
    expect(groups[0].label).toBe("child1");
  });

  it("returns an empty array for no entries", () => {
    expect(groupByDirectory([])).toEqual([]);
  });

  it("preserves intra-group ordering of original entries (no shuffling)", () => {
    const groups = groupByDirectory([
      entry("child1/c.png"),
      entry("child1/a.png"),
      entry("child1/b.png"),
    ]);
    expect(groups[0].entries.map((e) => e.filename)).toEqual([
      "child1/c.png",
      "child1/a.png",
      "child1/b.png",
    ]);
  });

  it("groups deeply nested files under their full directory path", () => {
    const groups = groupByDirectory([
      entry("a/b/c/x.png"),
      entry("a/b/y.png"),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["a/b", "a/b/c"]);
  });
});
