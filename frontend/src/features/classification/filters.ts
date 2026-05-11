import type { classification } from "../../../wailsjs/go/models";

export type Confidence = "high" | "mid" | "low" | "";

export type ListTabFilter = {
  tags: string[]; // OR; empty = no tag filter
  confidence: Confidence | "all";
  query: string;
};

// extractTags parses the on-disk `folder` field into a deduplicated tag list.
// Two formats are accepted:
//   - Legacy parens form: "head (sub + sub + ...)"  (Phase 4 v1.0 〜)
//   - Direct list form  : "tag1, tag2, tag3"        (Phase 4 v1.5 〜, #8)
// Comma and Japanese full-width comma "、" both work as separators in the
// list form. Single-token input is naturally handled by the list form path.
//
// Examples:
//   "iroha"                            → ["iroha"]
//   "shugo (iroha + kaguya)"           → ["shugo", "iroha", "kaguya"]
//   "tag1, tag2"                       → ["tag1", "tag2"]
//   ""                                 → []
export function extractTags(folder: string): string[] {
  if (!folder) return [];
  const parens = folder.match(/^([^(]+?)\s*\(([^)]*)\)\s*$/);
  if (parens) {
    const head = parens[1].trim();
    const inner = parens[2]
      .split("+")
      .map((s) => s.trim())
      .filter(Boolean);
    return Array.from(new Set([head, ...inner].filter(Boolean)));
  }
  const list = folder
    .split(/[,、]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return Array.from(new Set(list));
}

// serializeTags joins a tag list back into the on-disk `folder` field.
// Uses comma+space separator (the canonical save format from Phase 4 v1.5).
// Empty input → "" (so unclassified entries round-trip correctly).
export function serializeTags(tags: string[]): string {
  return tags
    .map((t) => t.trim())
    .filter(Boolean)
    .join(", ");
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
