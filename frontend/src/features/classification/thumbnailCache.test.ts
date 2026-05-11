import { describe, expect, it, vi } from "vitest";
import { createThumbCache, type ThumbCacheValue } from "./thumbnailCache";

const ok = (url: string): ThumbCacheValue => ({ url, state: "ok" });
const err = (): ThumbCacheValue => ({ url: "", state: "error" });

describe("createThumbCache", () => {
  it("returns undefined for missing keys", () => {
    const c = createThumbCache(3, () => {});
    expect(c.get("a")).toBeUndefined();
    expect(c.size()).toBe(0);
  });

  it("stores and retrieves values", () => {
    const c = createThumbCache(3, () => {});
    c.set("a", ok("blob:a"));
    expect(c.get("a")?.url).toBe("blob:a");
    expect(c.size()).toBe(1);
  });

  it("evicts the least-recently-used entry on overflow and revokes its URL", () => {
    const revoke = vi.fn();
    const c = createThumbCache(2, revoke);
    c.set("a", ok("blob:a"));
    c.set("b", ok("blob:b"));
    c.set("c", ok("blob:c"));
    expect(c.size()).toBe(2);
    expect(c.get("a")).toBeUndefined();
    expect(c.get("b")?.url).toBe("blob:b");
    expect(c.get("c")?.url).toBe("blob:c");
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith("blob:a");
  });

  it("get() bumps the entry to MRU so it is not evicted next", () => {
    const revoke = vi.fn();
    const c = createThumbCache(2, revoke);
    c.set("a", ok("blob:a"));
    c.set("b", ok("blob:b"));
    // Touch "a"; now "b" is LRU.
    c.get("a");
    c.set("c", ok("blob:c"));
    expect(c.get("a")?.url).toBe("blob:a");
    expect(c.get("b")).toBeUndefined();
    expect(c.get("c")?.url).toBe("blob:c");
    expect(revoke).toHaveBeenCalledWith("blob:b");
  });

  it("re-setting an existing key with a new URL revokes the old URL", () => {
    const revoke = vi.fn();
    const c = createThumbCache(3, revoke);
    c.set("a", ok("blob:a1"));
    c.set("a", ok("blob:a2"));
    expect(c.get("a")?.url).toBe("blob:a2");
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith("blob:a1");
  });

  it("re-setting with the same URL does not revoke", () => {
    const revoke = vi.fn();
    const c = createThumbCache(3, revoke);
    c.set("a", ok("blob:a"));
    c.set("a", ok("blob:a"));
    expect(revoke).not.toHaveBeenCalled();
  });

  it("skips revoke for error entries (no URL)", () => {
    const revoke = vi.fn();
    const c = createThumbCache(1, revoke);
    c.set("a", err());
    c.set("b", err());
    expect(c.size()).toBe(1);
    expect(revoke).not.toHaveBeenCalled();
  });

  it("evicts in LRU order across multiple overflows", () => {
    const revoke = vi.fn();
    const c = createThumbCache(2, revoke);
    c.set("a", ok("blob:a"));
    c.set("b", ok("blob:b"));
    c.set("c", ok("blob:c")); // evicts a
    c.set("d", ok("blob:d")); // evicts b
    expect(revoke.mock.calls.map((args) => args[0])).toEqual([
      "blob:a",
      "blob:b",
    ]);
    expect(c.size()).toBe(2);
    expect(c.get("c")?.url).toBe("blob:c");
    expect(c.get("d")?.url).toBe("blob:d");
  });

  it("swallows revoke exceptions", () => {
    const revoke = vi.fn(() => {
      throw new Error("bad URL");
    });
    const c = createThumbCache(1, revoke);
    c.set("a", ok("blob:a"));
    expect(() => c.set("b", ok("blob:b"))).not.toThrow();
    expect(c.size()).toBe(1);
  });
});
