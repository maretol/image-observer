import { describe, expect, it } from "vitest";
import {
  SORT_MANUAL,
  SORT_MODE_VALUES,
  SORT_MTIME_ASC,
  SORT_MTIME_DESC,
  SORT_NAME_ASC,
  SORT_NAME_DESC,
  normalizeSortMode,
} from "./sortMode";

// AGENTS.md D-1 drift detector: these literals are duplicated in Go-side
// `internal/state.SortManual` etc. (locked there by `TestSortModeValues`).
// Renaming one side without the other makes validateState silently snap the
// persisted sort back to manual instead of failing CI.
describe("sortMode constants", () => {
  it("literals match the Go-side state.Sort* constants", () => {
    expect(SORT_MANUAL).toBe("manual");
    expect(SORT_NAME_ASC).toBe("nameAsc");
    expect(SORT_NAME_DESC).toBe("nameDesc");
    expect(SORT_MTIME_ASC).toBe("mtimeAsc");
    expect(SORT_MTIME_DESC).toBe("mtimeDesc");
  });

  it("SORT_MODE_VALUES enumerates exactly the allowed values", () => {
    expect(SORT_MODE_VALUES).toEqual([
      "manual",
      "nameAsc",
      "nameDesc",
      "mtimeAsc",
      "mtimeDesc",
    ]);
  });
});

describe("normalizeSortMode", () => {
  it("passes valid values through", () => {
    for (const v of SORT_MODE_VALUES) {
      expect(normalizeSortMode(v)).toBe(v);
    }
  });

  it("falls back to manual for missing / unknown values", () => {
    expect(normalizeSortMode(undefined)).toBe(SORT_MANUAL);
    expect(normalizeSortMode(null)).toBe(SORT_MANUAL);
    expect(normalizeSortMode("")).toBe(SORT_MANUAL);
    expect(normalizeSortMode("bogus")).toBe(SORT_MANUAL);
  });
});
