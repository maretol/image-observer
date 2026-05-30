// @vitest-environment happy-dom
// happy-dom supplies HTMLElement / form controls for the isTextEntryTarget
// DOM checks; the project's default test env is node, so opt in here. The
// pragma must be the first line of the file for vitest to pick it up.
import { describe, expect, it } from "vitest";
import { editShortcutField, isTextEntryTarget } from "./modalEditShortcuts";

describe("editShortcutField", () => {
  it("maps t / c / n to their fields", () => {
    expect(editShortcutField("t")).toBe("tags");
    expect(editShortcutField("c")).toBe("confidence");
    expect(editShortcutField("n")).toBe("note");
  });
  it("is case-insensitive", () => {
    expect(editShortcutField("T")).toBe("tags");
    expect(editShortcutField("C")).toBe("confidence");
    expect(editShortcutField("N")).toBe("note");
  });
  it("returns null for any other key", () => {
    expect(editShortcutField("a")).toBeNull();
    expect(editShortcutField("Enter")).toBeNull();
    expect(editShortcutField("ArrowLeft")).toBeNull();
  });
});

describe("isTextEntryTarget", () => {
  it("is true for a text input", () => {
    const el = document.createElement("input");
    el.type = "text";
    expect(isTextEntryTarget(el)).toBe(true);
  });
  it("is true for a textarea", () => {
    expect(isTextEntryTarget(document.createElement("textarea"))).toBe(true);
  });
  it("is true for a contenteditable element", () => {
    const el = document.createElement("div");
    el.setAttribute("contenteditable", "true");
    // happy-dom reflects the attribute into isContentEditable.
    expect(isTextEntryTarget(el)).toBe(true);
  });
  it("is false for radio / checkbox inputs", () => {
    const radio = document.createElement("input");
    radio.type = "radio";
    expect(isTextEntryTarget(radio)).toBe(false);
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    expect(isTextEntryTarget(checkbox)).toBe(false);
  });
  it("is false for a plain div / button", () => {
    expect(isTextEntryTarget(document.createElement("div"))).toBe(false);
    expect(isTextEntryTarget(document.createElement("button"))).toBe(false);
  });
  it("is false for null", () => {
    expect(isTextEntryTarget(null)).toBe(false);
  });
});
