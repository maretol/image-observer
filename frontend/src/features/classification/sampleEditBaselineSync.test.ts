import { describe, expect, it } from "vitest";
import { classification } from "../../../wailsjs/go/models";
import {
  baselineOf,
  computeBaselineSync,
  EMPTY_BASELINE,
  type Baseline,
  type Touched,
} from "./sampleEditBaselineSync";

function makeEntry(overrides: Partial<classification.Entry> = {}) {
  return classification.Entry.createFrom({
    filename: "img.png",
    folder: "alice",
    confidence: "high",
    note: "hello",
    ...overrides,
  });
}

function makeBaseline(overrides: Partial<Baseline> = {}): Baseline {
  return { filename: "img.png", folder: "alice", confidence: "high", note: "hello", ...overrides };
}

const UNTOUCHED: Touched = { tags: false, confidence: false, note: false };

describe("baselineOf / EMPTY_BASELINE", () => {
  it("baselineOf mirrors the entry's four baseline fields", () => {
    const entry = makeEntry({ folder: "x, y", confidence: "low", note: "n" });
    expect(baselineOf(entry)).toEqual({
      filename: "img.png",
      folder: "x, y",
      confidence: "low",
      note: "n",
    });
  });

  it("EMPTY_BASELINE has a null filename (no active entry)", () => {
    expect(EMPTY_BASELINE.filename).toBeNull();
  });
});

describe("computeBaselineSync — resetAll", () => {
  it("returns resetAll when the filename differs (prev/next nav to another entry)", () => {
    const prev = makeBaseline({ filename: "other.png" });
    const entry = makeEntry({ filename: "img.png" });
    expect(
      computeBaselineSync(prev, entry, { tags: ["zoe"], confidence: "low", note: "draft" }, UNTOUCHED),
    ).toEqual({ kind: "resetAll" });
  });

  it("treats the initial EMPTY_BASELINE (null filename) as resetAll on first observation", () => {
    const entry = makeEntry();
    expect(
      computeBaselineSync(EMPTY_BASELINE, entry, { tags: [], confidence: "", note: "" }, UNTOUCHED),
    ).toEqual({ kind: "resetAll" });
  });
});

describe("computeBaselineSync — perField (same filename, baseline patched)", () => {
  it("syncs nothing when no baseline field changed", () => {
    const prev = makeBaseline();
    const entry = makeEntry();
    expect(
      computeBaselineSync(prev, entry, { tags: ["alice"], confidence: "high", note: "hello" }, UNTOUCHED),
    ).toEqual({ kind: "perField", syncTags: false, syncConfidence: false, syncNote: false });
  });

  // round 2 happy path: a partial auto-save / external edit changed a field the
  // user was NOT editing → adopt the new disk truth.
  it("syncs a field the user has not touched whose local value still matches the old baseline", () => {
    const prev = makeBaseline({ folder: "alice", confidence: "high", note: "hello" });
    const entry = makeEntry({ folder: "alice, bob", confidence: "low", note: "world" });
    const action = computeBaselineSync(
      prev,
      entry,
      { tags: ["alice"], confidence: "high", note: "hello" }, // all match old baseline
      UNTOUCHED,
    );
    expect(action).toEqual({ kind: "perField", syncTags: true, syncConfidence: true, syncNote: true });
  });

  // round 2 protection: a field the user genuinely edited (local differs from
  // old baseline) must not be clobbered by the post-save baseline patch.
  it("does NOT sync a field whose local value diverged from the old baseline", () => {
    const prev = makeBaseline({ folder: "alice", confidence: "high", note: "hello" });
    const entry = makeEntry({ folder: "alice, bob", confidence: "low", note: "world" });
    const action = computeBaselineSync(
      prev,
      entry,
      { tags: ["alice", "zoe"], confidence: "mid", note: "draft" }, // user edited all three
      UNTOUCHED,
    );
    expect(action).toEqual({ kind: "perField", syncTags: false, syncConfidence: false, syncNote: false });
  });

  // round 5: "touched then reverted". Local coincidentally equals the old
  // baseline, but the touched flag records that the user edited it during the
  // in-flight save → keep local, do not adopt the new baseline.
  it("does NOT sync a touched field even if its value coincidentally matches the old baseline", () => {
    const prev = makeBaseline({ folder: "alice", confidence: "high", note: "hello" });
    const entry = makeEntry({ folder: "alice, bob", confidence: "low", note: "world" });
    const action = computeBaselineSync(
      prev,
      entry,
      { tags: ["alice"], confidence: "high", note: "hello" }, // == old baseline
      { tags: true, confidence: true, note: true }, // but all touched
    );
    expect(action).toEqual({ kind: "perField", syncTags: false, syncConfidence: false, syncNote: false });
  });

  it("syncs only the fields that changed (folder unchanged ⇒ tags stay)", () => {
    const prev = makeBaseline({ folder: "alice", confidence: "high", note: "hello" });
    const entry = makeEntry({ folder: "alice", confidence: "low", note: "hello" }); // only confidence changed
    const action = computeBaselineSync(
      prev,
      entry,
      { tags: ["alice"], confidence: "high", note: "hello" },
      UNTOUCHED,
    );
    expect(action).toEqual({ kind: "perField", syncTags: false, syncConfidence: true, syncNote: false });
  });

  // Tag comparison normalizes both sides through extract/serialize, so a legacy
  // no-space sidecar ("alice,bob") and the canonical local list still count as
  // matching the old baseline (mirrors computeEditDirty's legacy handling).
  it("treats a legacy no-space old baseline as matching the canonical local tags", () => {
    const prev = makeBaseline({ folder: "alice,bob" }); // legacy, no space
    const entry = makeEntry({ folder: "alice, bob, carol" });
    const action = computeBaselineSync(
      prev,
      entry,
      { tags: ["alice", "bob"], confidence: "high", note: "hello" }, // matches legacy baseline
      UNTOUCHED,
    );
    expect(action.kind).toBe("perField");
    expect(action).toMatchObject({ syncTags: true });
  });
});
