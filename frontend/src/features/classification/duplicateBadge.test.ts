import { describe, expect, it } from "vitest";
import { imghash } from "../../../wailsjs/go/models";
import { duplicateFileSet, pairsForFile, removePair } from "./duplicateBadge";

function pair(a: string, b: string, distance = 0): imghash.DuplicatePair {
  return imghash.DuplicatePair.createFrom({ fileA: a, fileB: b, distance });
}

describe("duplicateFileSet", () => {
  it("returns empty set for no pairs", () => {
    expect(duplicateFileSet([]).size).toBe(0);
  });

  it("collects both files of every pair", () => {
    const set = duplicateFileSet([pair("a.png", "b.png"), pair("b.png", "c.png")]);
    expect(set).toEqual(new Set(["a.png", "b.png", "c.png"]));
  });
});

describe("pairsForFile", () => {
  const pairs = [
    pair("a.png", "b.png", 1),
    pair("b.png", "c.png", 2),
    pair("c.png", "d.png", 3),
  ];

  it("returns pairs containing the file on either side", () => {
    expect(pairsForFile(pairs, "b.png")).toEqual([pairs[0], pairs[1]]);
  });

  it("returns empty for an uninvolved file", () => {
    expect(pairsForFile(pairs, "z.png")).toEqual([]);
  });
});

describe("removePair", () => {
  const pairs = [pair("a.png", "b.png"), pair("b.png", "c.png")];

  it("removes the matching pair regardless of argument order", () => {
    expect(removePair(pairs, "b.png", "a.png")).toEqual([pairs[1]]);
    expect(removePair(pairs, "a.png", "b.png")).toEqual([pairs[1]]);
  });

  it("keeps unrelated pairs and does not mutate the input", () => {
    const out = removePair(pairs, "x.png", "y.png");
    expect(out).toEqual(pairs);
    expect(pairs).toHaveLength(2);
  });
});
