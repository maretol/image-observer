import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isEditableTarget,
  isPrimaryModifier,
  zoomCommandBus,
} from "./keybindings";

afterEach(() => {
  zoomCommandBus.setListener(null);
});

describe("zoomCommandBus", () => {
  it("returns false when nothing is subscribed", () => {
    expect(zoomCommandBus.hasListener()).toBe(false);
    expect(zoomCommandBus.emit("fit")).toBe(false);
  });

  it("delivers commands to the active listener", () => {
    const fn = vi.fn();
    zoomCommandBus.setListener(fn);
    expect(zoomCommandBus.hasListener()).toBe(true);
    expect(zoomCommandBus.emit("fit")).toBe(true);
    expect(zoomCommandBus.emit("actualSize")).toBe(true);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(1, "fit");
    expect(fn).toHaveBeenNthCalledWith(2, "actualSize");
  });

  it("replaces the listener on takeover", () => {
    const a = vi.fn();
    const b = vi.fn();
    zoomCommandBus.setListener(a);
    zoomCommandBus.setListener(b);
    zoomCommandBus.emit("in");
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledWith("in");
  });

  it("clears with setListener(null)", () => {
    zoomCommandBus.setListener(vi.fn());
    zoomCommandBus.setListener(null);
    expect(zoomCommandBus.hasListener()).toBe(false);
    expect(zoomCommandBus.emit("fit")).toBe(false);
  });
});

describe("isEditableTarget", () => {
  it("false for null / non-HTMLElement objects", () => {
    expect(isEditableTarget(null)).toBe(false);
    // Plain objects fail the instanceof HTMLElement check at runtime so we
    // rely on the function's defensive return; the DOM-side behavior is
    // exercised manually via wails dev.
    expect(isEditableTarget({} as unknown as EventTarget)).toBe(false);
  });
});

describe("isPrimaryModifier", () => {
  // Duck-typed KeyboardEvent — tests run in node, no DOM types available.
  const kev = (mods: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }) =>
    mods as unknown as KeyboardEvent;

  it("true on Ctrl or Meta", () => {
    expect(isPrimaryModifier(kev({ ctrlKey: true }))).toBe(true);
    expect(isPrimaryModifier(kev({ metaKey: true }))).toBe(true);
  });
  it("false on no modifier or Shift only", () => {
    expect(isPrimaryModifier(kev({}))).toBe(false);
    expect(isPrimaryModifier(kev({ shiftKey: true }))).toBe(false);
  });
});
