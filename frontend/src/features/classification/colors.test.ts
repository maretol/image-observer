import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PALETTE } from "./defaultPalette";
import {
  getKnownTagColors,
  readableTextColor,
  setKnownTagColors,
  tagBadgeClass,
  tagColor,
} from "./colors";

// Reset to defaults after each test to keep cross-test isolation. The setter
// is module-level state, so leaks would otherwise break ordering.
afterEach(() => {
  setKnownTagColors(DEFAULT_PALETTE);
});

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

describe("setKnownTagColors", () => {
  it("overrides the active palette so tagColor uses the new map", () => {
    setKnownTagColors({ iroha: "#abcdef" });
    expect(tagColor("iroha")).toBe("#abcdef");
  });

  it("falls back to DEFAULT_PALETTE when given an empty map", () => {
    setKnownTagColors({ iroha: "#abcdef" });
    setKnownTagColors({});
    expect(tagColor("iroha")).toBe(DEFAULT_PALETTE.iroha);
  });

  it("falls back to DEFAULT_PALETTE when given null/undefined", () => {
    setKnownTagColors({ iroha: "#abcdef" });
    setKnownTagColors(null);
    expect(tagColor("iroha")).toBe(DEFAULT_PALETTE.iroha);
  });

  it("leaves unknown tags on the hash-derived path", () => {
    setKnownTagColors({ iroha: "#abcdef" });
    expect(tagColor("kuro")).toBe(tagColor("kuro")); // still deterministic
  });
});

describe("getKnownTagColors", () => {
  it("returns the active palette as a snapshot", () => {
    setKnownTagColors({ a: "#000000", b: "#ffffff" });
    const snap = getKnownTagColors();
    expect(snap.a).toBe("#000000");
    expect(snap.b).toBe("#ffffff");
  });
});

describe("tagBadgeClass", () => {
  it("returns 'unclassified' for empty tag", () => {
    expect(tagBadgeClass("")).toBe("unclassified");
  });

  it("lowercases and keeps alphanumerics", () => {
    expect(tagBadgeClass("iroha")).toBe("iroha");
    expect(tagBadgeClass("Iroha")).toBe("iroha");
  });

  it("strips non-alphanumeric characters from the class fragment", () => {
    expect(tagBadgeClass("hello-world")).toBe("helloworld");
    expect(tagBadgeClass("グループ")).toBe("unclassified");
  });
});
