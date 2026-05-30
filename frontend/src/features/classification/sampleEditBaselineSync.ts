import { classification } from "../../../wailsjs/go/models";
import { extractTags, serializeTags } from "./filters";

// Baseline is the (filename, folder, confidence, note) tuple SampleEditPane
// remembers as "the entry state the local form was last reconciled against".
// extracted from SampleEditPane (#110 B) so the per-field sync decision — the
// part that took PR #109 rounds 2 and 5 to get right — can be unit-tested.
export type Baseline = {
  filename: string | null;
  folder: string;
  confidence: string;
  note: string;
};

export type LocalEdit = {
  tags: string[];
  confidence: string;
  note: string;
};

// Per-field "touched since the last baseline observation" flags.
export type Touched = {
  tags: boolean;
  confidence: boolean;
  note: boolean;
};

// Baseline used when no entry is active. Read-only by convention — callers
// assign it to a ref but never mutate it in place (the touched flags, which
// *are* mutated field-by-field, deliberately have no shared constant: see the
// reset sites in SampleEditPane which always allocate a fresh literal).
export const EMPTY_BASELINE: Baseline = {
  filename: null,
  folder: "",
  confidence: "",
  note: "",
};

export function baselineOf(entry: classification.Entry): Baseline {
  return {
    filename: entry.filename,
    folder: entry.folder,
    confidence: entry.confidence,
    note: entry.note,
  };
}

export type BaselineSyncAction =
  // filename change = an entirely different entry (prev/next nav). Reset all
  // three local fields to the new baseline; the previous local edits do not
  // belong to this entry (nav is blocked while dirty, #93 §5.4).
  | { kind: "resetAll" }
  // Same entry, baseline patched (auto-save success touching a subset of
  // fields, or an external sidecar edit). Sync a field only if it still
  // matches the *previous* baseline AND the user hasn't touched it since.
  | {
      kind: "perField";
      syncTags: boolean;
      syncConfidence: boolean;
      syncNote: boolean;
    };

// computeBaselineSync decides how the local form should react to a new (non-
// null) `entry` baseline observation. The caller handles `entry === null`
// (clear to EMPTY_BASELINE) separately so this stays a total function over a
// present entry.
//
// Per-field rule (round 2 + round 5): overwrite a local field with the new
// baseline only when BOTH
//   (a) the local value still equals the *previous* baseline value, and
//   (b) the user has not touched that field since the last baseline.
// (a) alone is the round 2 fix (partial save must not clobber an untouched
// field that genuinely differs). (b) adds the round 5 fix: a "touched then
// reverted" field whose value coincidentally equals the previous baseline must
// stay local — without (b) a post-save baseline patch would silently discard
// the user's revert.
export function computeBaselineSync(
  prev: Baseline,
  entry: classification.Entry,
  local: LocalEdit,
  touched: Touched,
): BaselineSyncAction {
  if (prev.filename !== entry.filename) return { kind: "resetAll" };
  const syncTags =
    prev.folder !== entry.folder &&
    serializeTags(local.tags) === serializeTags(extractTags(prev.folder)) &&
    !touched.tags;
  const syncConfidence =
    prev.confidence !== entry.confidence &&
    local.confidence === prev.confidence &&
    !touched.confidence;
  const syncNote =
    prev.note !== entry.note &&
    local.note === prev.note &&
    !touched.note;
  return { kind: "perField", syncTags, syncConfidence, syncNote };
}
