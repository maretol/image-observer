import { describe, expect, it } from "vitest";
import type { classification } from "../../../wailsjs/go/models";
import { applyFilter, extractTags, tagSummary } from "./filters";

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

  it("extracts head tag plus inner tags split by '+'", () => {
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

  it("trims whitespace around tokens", () => {
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
});

describe("applyFilter", () => {
  const entries = [
    entry("alpha.jpg", "iroha", "high", "first"),
    entry("beta.jpg", "shugo (iroha + kaguya)", "mid", "second"),
    entry("gamma.jpg", "kaguya", "low", "third"),
    entry("delta.jpg", "", "", "uncategorized"),
  ];

  it("returns all entries when filter is empty", () => {
    const out = applyFilter(entries, {
      tags: [],
      confidence: "all",
      query: "",
    });
    expect(out).toHaveLength(4);
  });

  it("OR-combines selected tags", () => {
    const out = applyFilter(entries, {
      tags: ["iroha", "kaguya"],
      confidence: "all",
      query: "",
    });
    // alpha (iroha), beta (iroha+kaguya), gamma (kaguya)
    expect(out.map((e) => e.filename)).toEqual([
      "alpha.jpg",
      "beta.jpg",
      "gamma.jpg",
    ]);
  });

  it("filters by confidence single-select", () => {
    const out = applyFilter(entries, {
      tags: [],
      confidence: "high",
      query: "",
    });
    expect(out.map((e) => e.filename)).toEqual(["alpha.jpg"]);
  });

  it("filters by case-insensitive substring against filename and note", () => {
    expect(
      applyFilter(entries, { tags: [], confidence: "all", query: "ALPHA" }).map(
        (e) => e.filename,
      ),
    ).toEqual(["alpha.jpg"]);
    expect(
      applyFilter(entries, {
        tags: [],
        confidence: "all",
        query: "third",
      }).map((e) => e.filename),
    ).toEqual(["gamma.jpg"]);
  });

  it("AND-combines tag, confidence, and query filters", () => {
    const out = applyFilter(entries, {
      tags: ["iroha"],
      confidence: "mid",
      query: "second",
    });
    expect(out.map((e) => e.filename)).toEqual(["beta.jpg"]);
  });

  it("trims whitespace-only query so it does not exclude all entries", () => {
    const out = applyFilter(entries, {
      tags: [],
      confidence: "all",
      query: "   ",
    });
    expect(out).toHaveLength(4);
  });
});
