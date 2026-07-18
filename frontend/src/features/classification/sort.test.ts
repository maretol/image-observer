import { describe, expect, it } from "vitest";
import type { classification } from "../../../wailsjs/go/models";
import { groupByDirectory } from "./groups";
import { sortEntries } from "./sort";
import {
  SORT_MANUAL,
  SORT_MTIME_ASC,
  SORT_MTIME_DESC,
  SORT_NAME_ASC,
  SORT_NAME_DESC,
} from "./sortMode";

const entry = (filename: string): classification.Entry =>
  ({ filename, folder: "", confidence: "", note: "" }) as classification.Entry;

const names = (entries: classification.Entry[]) =>
  entries.map((e) => e.filename);

describe("sortEntries", () => {
  it("manual returns the input array identity (no copy, no reorder)", () => {
    const input = [entry("b.png"), entry("a.png")];
    const out = sortEntries(input, SORT_MANUAL, {});
    expect(out).toBe(input);
    expect(names(out)).toEqual(["b.png", "a.png"]);
  });

  it("does not mutate the input array (non-manual modes copy)", () => {
    const input = [entry("b.png"), entry("a.png")];
    sortEntries(input, SORT_NAME_ASC, {});
    expect(names(input)).toEqual(["b.png", "a.png"]);
  });

  it("nameAsc sorts by code unit, case-sensitive, digits before letters", () => {
    const input = [entry("b.png"), entry("A.png"), entry("1.png"), entry("a.png")];
    expect(names(sortEntries(input, SORT_NAME_ASC, {}))).toEqual([
      "1.png",
      "A.png",
      "a.png",
      "b.png",
    ]);
  });

  it("nameDesc is the exact reverse of nameAsc", () => {
    const input = [entry("b.png"), entry("A.png"), entry("1.png"), entry("a.png")];
    expect(names(sortEntries(input, SORT_NAME_DESC, {}))).toEqual([
      "b.png",
      "a.png",
      "A.png",
      "1.png",
    ]);
  });

  it("mtimeAsc orders by fileTimes ascending", () => {
    const input = [entry("new.png"), entry("old.png"), entry("mid.png")];
    const times = { "new.png": 300, "old.png": 100, "mid.png": 200 };
    expect(names(sortEntries(input, SORT_MTIME_ASC, times))).toEqual([
      "old.png",
      "mid.png",
      "new.png",
    ]);
  });

  it("mtimeDesc orders by fileTimes descending", () => {
    const input = [entry("old.png"), entry("new.png"), entry("mid.png")];
    const times = { "new.png": 300, "old.png": 100, "mid.png": 200 };
    expect(names(sortEntries(input, SORT_MTIME_DESC, times))).toEqual([
      "new.png",
      "mid.png",
      "old.png",
    ]);
  });

  it("missing fileTimes rows go last in both mtime directions, name tiebreak", () => {
    const input = [
      entry("z-missing.png"),
      entry("a-missing.png"),
      entry("known.png"),
    ];
    const times = { "known.png": 100 };
    const wantTail = ["known.png", "a-missing.png", "z-missing.png"];
    expect(names(sortEntries(input, SORT_MTIME_ASC, times))).toEqual(wantTail);
    expect(names(sortEntries(input, SORT_MTIME_DESC, times))).toEqual(wantTail);
  });

  it("mtime tie falls back to name ascending in both directions", () => {
    const input = [entry("b.png"), entry("a.png")];
    const times = { "a.png": 100, "b.png": 100 };
    expect(names(sortEntries(input, SORT_MTIME_ASC, times))).toEqual([
      "a.png",
      "b.png",
    ]);
    expect(names(sortEntries(input, SORT_MTIME_DESC, times))).toEqual([
      "a.png",
      "b.png",
    ]);
  });

  it("tolerates undefined fileTimes (all rows missing → name order)", () => {
    const input = [entry("b.png"), entry("a.png")];
    expect(names(sortEntries(input, SORT_MTIME_ASC, undefined))).toEqual([
      "a.png",
      "b.png",
    ]);
  });
});

describe("sortEntries → groupByDirectory composition", () => {
  it("sorts within each group while group order stays root-first then key-asc", () => {
    const input = [
      entry("child/z.png"),
      entry("b.png"),
      entry("child/a.png"),
      entry("a.png"),
    ];
    const groups = groupByDirectory(sortEntries(input, SORT_NAME_ASC, {}));
    expect(groups.map((g) => g.key)).toEqual([".", "child"]);
    expect(names(groups[0].entries)).toEqual(["a.png", "b.png"]);
    expect(names(groups[1].entries)).toEqual(["child/a.png", "child/z.png"]);
  });

  it("manual keeps sidecar array order within groups", () => {
    const input = [
      entry("child/z.png"),
      entry("b.png"),
      entry("child/a.png"),
      entry("a.png"),
    ];
    const groups = groupByDirectory(sortEntries(input, SORT_MANUAL, {}));
    expect(names(groups[0].entries)).toEqual(["b.png", "a.png"]);
    expect(names(groups[1].entries)).toEqual(["child/z.png", "child/a.png"]);
  });
});
