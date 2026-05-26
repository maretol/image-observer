import type { classification } from "../../../wailsjs/go/models";
import { extractTags, serializeTags } from "./filters";

// computeEditDirty returns true when the in-pane form (tags / confidence /
// note) diverges from the entry's persisted baseline. Extracted as a pure
// helper so SampleEditPane stays a thin React wrapper and the dirty rule
// is testable in isolation (spec §5.4 hinges on this — false negatives
// here would let unsaved edits silently survive a prev/next jump).
//
// Tag comparison passes the entry side through extractTags() to canonicalize
// legacy parens / "alice,bob" (no space after comma) folders, then runs
// serializeTags() on *both* sides so the comparison is against the canonical
// "alice, bob" save format. The local `tags` side is not re-extracted —
// TagInput.commit already rejects duplicates on input so the state never
// holds them, and the order is preserved (a user-driven reorder still
// flips dirty on). Only genuine user edits flip dirty on.
export function computeEditDirty(
  entry: classification.Entry | null,
  tags: string[],
  confidence: string,
  note: string,
): boolean {
  if (!entry) return false;
  const baselineFolder = serializeTags(extractTags(entry.folder));
  if (serializeTags(tags) !== baselineFolder) return true;
  if (confidence !== entry.confidence) return true;
  if (note !== entry.note) return true;
  return false;
}
