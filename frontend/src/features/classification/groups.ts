import type { classification } from "../../../wailsjs/go/models";

// ROOT_GROUP_KEY is the canonical key for files that live directly under the
// parent folder (not in a subdirectory). Persisted to state.json; do not
// change without bumping the state schema.
export const ROOT_GROUP_KEY = ".";

// ROOT_GROUP_LABEL is the human-readable name shown in the accordion header
// for the root group. Localized only here so changes are one-place.
export const ROOT_GROUP_LABEL = "(直下)";

export type DirectoryGroup = {
  key: string;          // ROOT_GROUP_KEY or relative POSIX path (e.g. "child1", "child1/sub")
  label: string;        // display string (ROOT_GROUP_LABEL for root, otherwise key)
  entries: classification.Entry[];
};

// groupKeyOf returns the directory portion of a filename (entry.filename),
// using ROOT_GROUP_KEY for files with no directory part.
//
// Examples:
//   "a.jpg"           → "."
//   "child1/x.png"    → "child1"
//   "child1/sub/y.gif"→ "child1/sub"
export function groupKeyOf(filename: string): string {
  const slash = filename.lastIndexOf("/");
  if (slash < 0) return ROOT_GROUP_KEY;
  return filename.slice(0, slash);
}

// groupByDirectory partitions entries into directory-keyed groups, preserving
// each group's original entry order. Group order in the returned array is:
// ROOT_GROUP_KEY first (if present), then the rest sorted lexicographically
// by key. This gives a stable, predictable accordion layout.
export function groupByDirectory(
  entries: classification.Entry[],
): DirectoryGroup[] {
  const buckets = new Map<string, classification.Entry[]>();
  for (const e of entries) {
    const k = groupKeyOf(e.filename);
    const arr = buckets.get(k);
    if (arr) arr.push(e);
    else buckets.set(k, [e]);
  }
  const keys = Array.from(buckets.keys()).sort((a, b) => {
    if (a === ROOT_GROUP_KEY) return -1;
    if (b === ROOT_GROUP_KEY) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return keys.map((key) => ({
    key,
    label: key === ROOT_GROUP_KEY ? ROOT_GROUP_LABEL : key,
    entries: buckets.get(key)!,
  }));
}
