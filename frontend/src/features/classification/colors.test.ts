import { describe, expect, it } from "vitest";
import { DEFAULT_PALETTE } from "./defaultPalette";
import { folderClass, readableTextColor, tagColor } from "./colors";

describe("tagColor", () => {
  it("returns the unclassified grey for empty tag", () => {
    expect(tagColor("")).toBe("#555");
  });

  it("returns the known mapping for tags in DEFAULT_PALETTE", () => {
    for (const [name, hex] of Object.entries(DEFAULT_PALETTE)) {
      expect(tagColor(name)).toBe(hex);
    }
  });

  it("is deterministic for unknown tags (same input → same color)", () => {
    expect(tagColor("kuro")).toBe(tagColor("kuro"));
    expect(tagColor("a-very-novel-tag")).toBe(tagColor("a-very-novel-tag"));
  });

  it("returns a 7-char hex color in the fallback palette for unknown tags", () => {
    const c = tagColor("nonexistent-tag-xyz");
    expect(c).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("differentiates at least some unknown tags (palette spread)", () => {
    const samples = [
      "alpha",
      "beta",
      "gamma",
      "delta",
      "epsilon",
      "zeta",
      "eta",
      "theta",
    ];
    const colors = new Set(samples.map(tagColor));
    expect(colors.size).toBeGreaterThan(1);
  });
});

describe("readableTextColor", () => {
  it("returns dark text on bright backgrounds", () => {
    expect(readableTextColor("#ffffff")).toBe("#222");
    expect(readableTextColor("#f9a825")).toBe("#222"); // kaguya yellow
  });

  it("returns light text on dark backgrounds", () => {
    expect(readableTextColor("#000000")).toBe("#fff");
    expect(readableTextColor("#1976d2")).toBe("#fff"); // iroha blue
    expect(readableTextColor("#7b1fa2")).toBe("#fff"); // shugo purple
  });

  it("falls back to white for malformed hex", () => {
    expect(readableTextColor("rgb(0,0,0)")).toBe("#fff");
    expect(readableTextColor("#fff")).toBe("#fff");
    expect(readableTextColor("")).toBe("#fff");
  });
});

describe("folderClass", () => {
  it("returns 'unclassified' for empty folder", () => {
    expect(folderClass("")).toBe("unclassified");
  });

  it("returns the head tag lowercased and stripped", () => {
    expect(folderClass("iroha")).toBe("iroha");
    expect(folderClass("Iroha")).toBe("iroha");
    expect(folderClass("shugo (iroha + kaguya)")).toBe("shugo");
  });

  it("strips non-alphanumeric characters from the class fragment", () => {
    expect(folderClass("hello-world")).toBe("helloworld");
    expect(folderClass("グループ (花)")).toBe("unclassified");
  });
});
