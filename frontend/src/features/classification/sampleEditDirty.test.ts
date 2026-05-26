import { describe, expect, it } from "vitest";
import { classification } from "../../../wailsjs/go/models";
import { computeEditDirty } from "./sampleEditDirty";

function makeEntry(overrides: Partial<classification.Entry> = {}) {
  return classification.Entry.createFrom({
    filename: "img.png",
    folder: "alice,bob",
    confidence: "high",
    note: "hello",
    ...overrides,
  });
}

describe("computeEditDirty", () => {
  it("returns false when entry is null", () => {
    expect(computeEditDirty(null, ["alice"], "high", "x")).toBe(false);
  });

  it("returns false when tags / confidence / note match the entry baseline (canonical format)", () => {
    const entry = makeEntry({ folder: "alice, bob" });
    expect(computeEditDirty(entry, ["alice", "bob"], "high", "hello")).toBe(
      false,
    );
  });

  it("treats legacy `tag,tag` (no-space) sidecars as not-dirty against canonical serialize", () => {
    // Legacy saves used "alice,bob"; the canonical format from #8 is
    // "alice, bob". Opening a legacy entry through extractTags →
    // serializeTags would otherwise flag dirty=true the moment the user
    // opens the modal, which would block prev/next nav (spec §5.4) with
    // no user-visible reason. We normalize both sides through
    // extractTags + serializeTags to absorb the discrepancy.
    const entry = makeEntry({ folder: "alice,bob" });
    expect(computeEditDirty(entry, ["alice", "bob"], "high", "hello")).toBe(
      false,
    );
  });

  it("treats legacy parens form `head (sub + sub)` as not-dirty against the extracted list", () => {
    const entry = makeEntry({ folder: "shugo (iroha + kaguya)" });
    expect(
      computeEditDirty(entry, ["shugo", "iroha", "kaguya"], "high", "hello"),
    ).toBe(false);
  });

  it("returns true when tags differ", () => {
    const entry = makeEntry();
    expect(computeEditDirty(entry, ["alice"], "high", "hello")).toBe(true);
    expect(
      computeEditDirty(entry, ["alice", "bob", "carol"], "high", "hello"),
    ).toBe(true);
  });

  it("returns true when confidence differs", () => {
    const entry = makeEntry();
    expect(computeEditDirty(entry, ["alice", "bob"], "mid", "hello")).toBe(
      true,
    );
    expect(computeEditDirty(entry, ["alice", "bob"], "", "hello")).toBe(true);
  });

  it("returns true when note differs", () => {
    const entry = makeEntry();
    expect(computeEditDirty(entry, ["alice", "bob"], "high", "world")).toBe(
      true,
    );
    expect(computeEditDirty(entry, ["alice", "bob"], "high", "")).toBe(true);
  });

  it("returns true when all three fields differ", () => {
    const entry = makeEntry();
    expect(computeEditDirty(entry, ["x"], "low", "z")).toBe(true);
  });
});
