import { describe, expect, it } from "vitest";
import type { classification } from "../../../wailsjs/go/models";
import {
  applyFilter,
  extractTags,
  serializeTags,
  tagSummary,
  untaggedCount,
} from "./filters";

const entry = (
  filename: string,
  folder: string,
  confidence: "high" | "mid" | "low" | "" = "",
  note = "",
): classification.Entry =>
  ({ filename, folder, confidence, note }) as classification.Entry;

describe("extractTags", () => {
  it("returns single tag for plain folder name", () => {
    expect(extractTags("iroha")).toEqual(["iroha"]);
    expect(extractTags("fumei")).toEqual(["fumei"]);
  });

  it("extracts head tag plus inner tags split by '+' (legacy parens form)", () => {
    expect(extractTags("shugo (iroha + kaguya)")).toEqual([
      "shugo",
      "iroha",
      "kaguya",
    ]);
    expect(extractTags("shugo (iroha + kaguya + yachiyo)")).toEqual([
      "shugo",
      "iroha",
      "kaguya",
      "yachiyo",
    ]);
  });

  it("trims whitespace around tokens (legacy parens form)", () => {
    expect(extractTags("  shugo  (  iroha  +  kaguya  )  ")).toEqual([
      "shugo",
      "iroha",
      "kaguya",
    ]);
  });

  it("deduplicates repeated tags", () => {
    expect(extractTags("a (a + a)")).toEqual(["a"]);
    expect(extractTags("shugo (iroha + iroha + kaguya)")).toEqual([
      "shugo",
      "iroha",
      "kaguya",
    ]);
  });

  it("returns empty array for empty string", () => {
    expect(extractTags("")).toEqual([]);
  });

  it("ignores empty inner tokens (e.g. trailing '+')", () => {
    expect(extractTags("a (b + )")).toEqual(["a", "b"]);
    expect(extractTags("a ( + b)")).toEqual(["a", "b"]);
    expect(extractTags("a ()")).toEqual(["a"]);
  });

  it("handles arbitrary tag names (no domain coupling)", () => {
    expect(extractTags("cat (kuro + shiro)")).toEqual([
      "cat",
      "kuro",
      "shiro",
    ]);
    expect(extractTags("グループ (花 + 月)")).toEqual([
      "グループ",
      "花",
      "月",
    ]);
  });

  // #8: direct multi-tag input. Comma-separated is the new canonical save
  // format; we also accept the Japanese full-width comma for free.
  it("accepts comma-separated list form", () => {
    expect(extractTags("shugo, iroha, kaguya")).toEqual([
      "shugo",
      "iroha",
      "kaguya",
    ]);
    expect(extractTags("a,b,c")).toEqual(["a", "b", "c"]);
  });

  it("accepts full-width comma (、) as a separator", () => {
    expect(extractTags("shugo、iroha、kaguya")).toEqual([
      "shugo",
      "iroha",
      "kaguya",
    ]);
  });

  it("dedups + trims in list form", () => {
    expect(extractTags("shugo,  iroha , shugo ")).toEqual(["shugo", "iroha"]);
  });

  it("ignores empty tokens in list form", () => {
    expect(extractTags(", a,, b,")).toEqual(["a", "b"]);
  });
});

describe("serializeTags", () => {
  it("joins tags with comma+space", () => {
    expect(serializeTags(["shugo", "iroha"])).toBe("shugo, iroha");
  });

  it("returns empty string for empty list", () => {
    expect(serializeTags([])).toBe("");
  });

  it("trims and drops blanks", () => {
    expect(serializeTags(["  a  ", "", "b"])).toBe("a, b");
  });

  it("round-trips with extractTags for the new list form", () => {
    const tags = ["shugo", "iroha", "kaguya"];
    expect(extractTags(serializeTags(tags))).toEqual(tags);
  });

  it("legacy parens form round-trips through extractTags → serializeTags into the canonical list form", () => {
    // The new canonical save format is comma-separated, so editing a legacy
    // entry and saving silently migrates the on-disk string. Reading it back
    // still yields the same tag list, which is the contract that matters.
    const legacy = "shugo (iroha + kaguya)";
    const tags = extractTags(legacy);
    const next = serializeTags(tags);
    expect(next).toBe("shugo, iroha, kaguya");
    expect(extractTags(next)).toEqual(tags);
  });
});

describe("tagSummary", () => {
  it("counts each extracted tag across entries", () => {
    const entries = [
      entry("a.jpg", "iroha"),
      entry("b.jpg", "shugo (iroha + kaguya)"),
      entry("c.jpg", "kaguya"),
    ];
    const summary = tagSummary(entries);
    expect(summary.get("iroha")).toBe(2);
    expect(summary.get("kaguya")).toBe(2);
    expect(summary.get("shugo")).toBe(1);
  });

  it("ignores empty folders", () => {
    const summary = tagSummary([entry("a.jpg", "")]);
    expect(summary.size).toBe(0);
  });

  it("counts tags from the list form too", () => {
    const summary = tagSummary([
      entry("a.jpg", "shugo, iroha"),
      entry("b.jpg", "iroha, kaguya"),
    ]);
    expect(summary.get("shugo")).toBe(1);
    expect(summary.get("iroha")).toBe(2);
    expect(summary.get("kaguya")).toBe(1);
  });
});

describe("applyFilter", () => {
  const entries = [
    entry("alpha.jpg", "iroha", "high", "first"),
    entry("beta.jpg", "shugo (iroha + kaguya)", "mid", "second"),
    entry("gamma.jpg", "kaguya", "low", "third"),
    entry("delta.jpg", "", "", "uncategorized"),
    entry("epsilon.jpg", "shugo, kaguya", "mid", "list-form"),
  ];

  it("returns all entries when filter is empty", () => {
    const out = applyFilter(entries, {
      tags: [],
      untaggedOnly: false,
      confidence: "all",
      query: "",
    });
    expect(out).toHaveLength(5);
  });

  it("OR-combines selected tags (both forms recognized)", () => {
    const out = applyFilter(entries, {
      tags: ["iroha", "kaguya"],
      untaggedOnly: false,
      confidence: "all",
      query: "",
    });
    expect(out.map((e) => e.filename)).toEqual([
      "alpha.jpg",
      "beta.jpg",
      "gamma.jpg",
      "epsilon.jpg",
    ]);
  });

  it("filters by confidence single-select", () => {
    const out = applyFilter(entries, {
      tags: [],
      untaggedOnly: false,
      confidence: "high",
      query: "",
    });
    expect(out.map((e) => e.filename)).toEqual(["alpha.jpg"]);
  });

  it("filters by case-insensitive substring against filename and note", () => {
    expect(
      applyFilter(entries, {
        tags: [],
        untaggedOnly: false,
        confidence: "all",
        query: "ALPHA",
      }).map((e) => e.filename),
    ).toEqual(["alpha.jpg"]);
    expect(
      applyFilter(entries, {
        tags: [],
        untaggedOnly: false,
        confidence: "all",
        query: "third",
      }).map((e) => e.filename),
    ).toEqual(["gamma.jpg"]);
  });

  it("AND-combines tag, confidence, and query filters", () => {
    const out = applyFilter(entries, {
      tags: ["iroha"],
      untaggedOnly: false,
      confidence: "mid",
      query: "second",
    });
    expect(out.map((e) => e.filename)).toEqual(["beta.jpg"]);
  });

  it("trims whitespace-only query so it does not exclude all entries", () => {
    const out = applyFilter(entries, {
      tags: [],
      untaggedOnly: false,
      confidence: "all",
      query: "   ",
    });
    expect(out).toHaveLength(5);
  });

  it("untaggedOnly keeps only entries with no tags", () => {
    const out = applyFilter(entries, {
      tags: [],
      untaggedOnly: true,
      confidence: "all",
      query: "",
    });
    expect(out.map((e) => e.filename)).toEqual(["delta.jpg"]);
  });

  it("untaggedOnly takes precedence over a non-empty tag set", () => {
    // Defensive: the UI keeps these mutually exclusive, but applyFilter must
    // stay well-defined if both arrive set — untagged wins.
    const out = applyFilter(entries, {
      tags: ["iroha", "kaguya"],
      untaggedOnly: true,
      confidence: "all",
      query: "",
    });
    expect(out.map((e) => e.filename)).toEqual(["delta.jpg"]);
  });

  it("AND-combines untaggedOnly with confidence and query", () => {
    const taggedHigh = entry("zeta.jpg", "", "high", "needs-tag");
    const out = applyFilter([...entries, taggedHigh], {
      tags: [],
      untaggedOnly: true,
      confidence: "high",
      query: "needs",
    });
    expect(out.map((e) => e.filename)).toEqual(["zeta.jpg"]);
  });
});

describe("untaggedCount", () => {
  it("counts only entries whose folder yields no tags", () => {
    const entries = [
      entry("a.jpg", "iroha"),
      entry("b.jpg", ""),
      entry("c.jpg", "shugo (iroha + kaguya)"),
      entry("d.jpg", ""),
      entry("e.jpg", "shugo, kaguya"),
    ];
    expect(untaggedCount(entries)).toBe(2);
  });

  it("returns 0 when every entry is tagged", () => {
    expect(untaggedCount([entry("a.jpg", "iroha")])).toBe(0);
  });
});
