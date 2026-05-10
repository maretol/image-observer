import type { classification } from "../../../wailsjs/go/models";

export type Confidence = "high" | "mid" | "low" | "";

export type ListTabFilter = {
  tags: string[]; // OR; empty = no tag filter
  confidence: Confidence | "all";
  query: string;
};

// extractTags parses a folder string of the form "main (sub + sub + ...)"
// into a deduplicated tag list. Empty input → empty array.
//
// Examples (from spec §4.4):
//   "iroha"                            → ["iroha"]
//   "shugo (iroha + kaguya)"           → ["shugo", "iroha", "kaguya"]
//   "shugo (iroha + kaguya + yachiyo)" → ["shugo", "iroha", "kaguya", "yachiyo"]
//   "fumei"                            → ["fumei"]
//   ""                                 → []
//   "cat (kuro + shiro)"               → ["cat", "kuro", "shiro"]
export function extractTags(folder: string): string[] {
  if (!folder) return [];
  const m = folder.match(/^([^(]+?)\s*(?:\(([^)]*)\))?\s*$/);
  if (!m) return [];
  const head = m[1].trim();
  const inner = (m[2] ?? "")
    .split("+")
    .map((s) => s.trim())
    .filter(Boolean);
  const all = [head, ...inner].filter(Boolean);
  return Array.from(new Set(all));
}

// tagSummary aggregates tag counts across an entry list. Used to render the
// tag chip row at the top of the list view.
export function tagSummary(
  entries: classification.Entry[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of entries) {
    for (const t of extractTags(e.folder)) {
      out.set(t, (out.get(t) ?? 0) + 1);
    }
  }
  return out;
}

// applyFilter returns the subset of entries matching the filter.
// Tags are OR-combined (entry passes if any selected tag matches).
// Confidence is single-select. Query is case-insensitive substring match
// against filename and note. All three are AND-combined.
export function applyFilter(
  entries: classification.Entry[],
  f: ListTabFilter,
): classification.Entry[] {
  const q = f.query.trim().toLowerCase();
  return entries.filter((e) => {
    if (f.tags.length > 0) {
      const tags = extractTags(e.folder);
      if (!f.tags.some((t) => tags.includes(t))) return false;
    }
    if (f.confidence !== "all" && e.confidence !== f.confidence) return false;
    if (
      q &&
      !e.filename.toLowerCase().includes(q) &&
      !e.note.toLowerCase().includes(q)
    ) {
      return false;
    }
    return true;
  });
}
