import { describe, expect, it } from "vitest";
import { pickSibling } from "./sampleModalNav";

describe("pickSibling", () => {
  it("returns null for both ends within a single root group", () => {
    const order = ["a.jpg", "b.jpg", "c.jpg"];
    expect(pickSibling(order, "a.jpg")).toEqual({ prev: null, next: "b.jpg" });
    expect(pickSibling(order, "b.jpg")).toEqual({
      prev: "a.jpg",
      next: "c.jpg",
    });
    expect(pickSibling(order, "c.jpg")).toEqual({ prev: "b.jpg", next: null });
  });

  it("does not cross directory boundaries", () => {
    // displayedOrder mirrors groupByDirectory's flatten: root entries first,
    // then each subgroup in directory-key order.
    const order = [
      "root1.jpg",
      "root2.jpg",
      "child1/a.png",
      "child1/b.png",
      "child2/x.png",
    ];
    // last root entry → next is in child1/, so next is null
    expect(pickSibling(order, "root2.jpg")).toEqual({
      prev: "root1.jpg",
      next: null,
    });
    // first entry of child1/ → prev is root2.jpg (different group), so prev is null
    expect(pickSibling(order, "child1/a.png")).toEqual({
      prev: null,
      next: "child1/b.png",
    });
    // last entry of child1/ → next is child2/x.png (different group)
    expect(pickSibling(order, "child1/b.png")).toEqual({
      prev: "child1/a.png",
      next: null,
    });
    // child2/ has only one entry → both null
    expect(pickSibling(order, "child2/x.png")).toEqual({
      prev: null,
      next: null,
    });
  });

  it("treats different nested directory depths as distinct groups", () => {
    const order = ["a/b/x.png", "a/b/y.png", "a/b/c/z.png"];
    // last "a/b" entry → next is "a/b/c/z.png" with different groupKey
    expect(pickSibling(order, "a/b/y.png")).toEqual({
      prev: "a/b/x.png",
      next: null,
    });
    // sole "a/b/c" entry → prev is "a/b/y.png" with different groupKey
    expect(pickSibling(order, "a/b/c/z.png")).toEqual({
      prev: null,
      next: null,
    });
  });

  it("returns both null when the filename is not in displayedOrder", () => {
    // Happens when the modal was opened, then the user changed the filter
    // and the preview's filename is no longer visible. Caller renders both
    // nav buttons as disabled.
    const order = ["a.jpg", "b.jpg"];
    expect(pickSibling(order, "ghost.jpg")).toEqual({
      prev: null,
      next: null,
    });
  });

  it("returns both null when only one entry is in the same group", () => {
    const order = ["only.jpg"];
    expect(pickSibling(order, "only.jpg")).toEqual({ prev: null, next: null });
  });

  it("handles an empty displayedOrder", () => {
    expect(pickSibling([], "anything.jpg")).toEqual({
      prev: null,
      next: null,
    });
  });
});
