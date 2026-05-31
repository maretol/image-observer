// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useClassificationFilter } from "./useClassificationFilter";

// These tests pin the mutual-exclusion between the tag set and the untagged
// filter (#116, spec-untagged-filter.md §4.4). loadResult is null throughout —
// we only exercise the toggle reducers, not filteredEntries.
const setup = () =>
  renderHook(() => useClassificationFilter({ initial: null, loadResult: null }));

describe("useClassificationFilter untagged exclusivity", () => {
  it("toggleUntagged turns the mode on and clears any selected tags", () => {
    const { result } = setup();
    act(() => result.current.toggleTag("iroha"));
    expect(result.current.filter.tags).toEqual(["iroha"]);

    act(() => result.current.toggleUntagged());
    expect(result.current.filter.untaggedOnly).toBe(true);
    expect(result.current.filter.tags).toEqual([]);
  });

  it("toggleTag leaves untagged mode and selects the tag", () => {
    const { result } = setup();
    act(() => result.current.toggleUntagged());
    expect(result.current.filter.untaggedOnly).toBe(true);

    act(() => result.current.toggleTag("kaguya"));
    expect(result.current.filter.untaggedOnly).toBe(false);
    expect(result.current.filter.tags).toEqual(["kaguya"]);
  });

  it("toggleUntagged is a flip-flop", () => {
    const { result } = setup();
    act(() => result.current.toggleUntagged());
    expect(result.current.filter.untaggedOnly).toBe(true);
    act(() => result.current.toggleUntagged());
    expect(result.current.filter.untaggedOnly).toBe(false);
  });

  it("clearTags resets both the tag set and untagged mode", () => {
    const { result } = setup();
    act(() => result.current.toggleUntagged());
    act(() => result.current.clearTags());
    expect(result.current.filter.untaggedOnly).toBe(false);
    expect(result.current.filter.tags).toEqual([]);
  });

  it("restores untaggedOnly from initial filter state", () => {
    const { result } = renderHook(() =>
      useClassificationFilter({
        initial: { tags: [], untaggedOnly: true, confidence: "all", query: "" },
        loadResult: null,
      }),
    );
    expect(result.current.filter.untaggedOnly).toBe(true);
  });

  it("drops tags at hydration when initial state has both set (invariant)", () => {
    // A persisted / hand-edited session could violate exclusivity; the hook
    // normalizes it so untagged mode wins and no tag chip shows active.
    const { result } = renderHook(() =>
      useClassificationFilter({
        initial: {
          tags: ["iroha", "kaguya"],
          untaggedOnly: true,
          confidence: "all",
          query: "",
        },
        loadResult: null,
      }),
    );
    expect(result.current.filter.untaggedOnly).toBe(true);
    expect(result.current.filter.tags).toEqual([]);
  });
});
