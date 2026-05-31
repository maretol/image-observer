import type { classification } from "../../../wailsjs/go/models";

export type Confidence = "high" | "mid" | "low" | "";

export type ListTabFilter = {
  tags: string[]; // OR; empty = no tag filter
  // untaggedOnly: when true, show only entries with no tags (extractTags empty).
  // Mutually exclusive with `tags` at the UI layer (the toggle handlers clear
  // one when the other is set) — applyFilter still treats it as taking
  // precedence so the function stays well-defined even if both arrive set.
  untaggedOnly: boolean;
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

export type TagSummary = {
  // counts: per-tag occurrence count across the entry list.
  counts: Map<string, number>;
  // untagged: number of entries with no tags at all (extractTags empty).
  untagged: number;
};

// summarizeTags walks the entry list once, building both the per-tag counts
// and the untagged total. The TagChips row needs both at the same time, so a
// single pass avoids running extractTags twice per entry (#120 review).
export function summarizeTags(entries: classification.Entry[]): TagSummary {
  const counts = new Map<string, number>();
  let untagged = 0;
  for (const e of entries) {
    const tags = extractTags(e.folder);
    if (tags.length === 0) {
      untagged++;
      continue;
    }
    for (const t of tags) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  return { counts, untagged };
}

// tagSummary aggregates tag counts across an entry list. Thin wrapper over
// summarizeTags for callers that only need the per-tag counts.
export function tagSummary(
  entries: classification.Entry[],
): Map<string, number> {
  return summarizeTags(entries).counts;
}

// untaggedCount returns how many entries have no tags at all (extractTags
// empty). Drives the count badge on the "未分類" chip (#116).
export function untaggedCount(entries: classification.Entry[]): number {
  return summarizeTags(entries).untagged;
}

// applyFilter returns the subset of entries matching the filter.
// untaggedOnly (when set) keeps only entries with no tags and takes precedence
// over the tag set (the two are mutually exclusive in the UI). Otherwise tags
// are OR-combined (entry passes if any selected tag matches). Confidence is
// single-select. Query is case-insensitive substring match against filename
// and note. All active conditions are AND-combined.
export function applyFilter(
  entries: classification.Entry[],
  f: ListTabFilter,
): classification.Entry[] {
  const q = f.query.trim().toLowerCase();
  return entries.filter((e) => {
    if (f.untaggedOnly) {
      if (extractTags(e.folder).length > 0) return false;
    } else if (f.tags.length > 0) {
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
