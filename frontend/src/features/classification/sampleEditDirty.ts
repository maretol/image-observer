import type { classification } from "../../../wailsjs/go/models";
import { extractTags, serializeTags } from "./filters";

// computeEditDirty returns true when the in-pane form (tags / confidence /
// note) diverges from the entry's persisted baseline. Extracted as a pure
// helper so SampleEditPane stays a thin React wrapper and the dirty rule
// is testable in isolation (spec §5.4 hinges on this — false negatives
// here would let unsaved edits silently survive a prev/next jump).
//
// Tag comparison goes through serializeTags on *both* sides so legacy
// "alice,bob" sidecars (no space after comma) round-trip cleanly against
// the canonical "alice, bob" save format and don't show up as dirty on
// open. Only genuine user edits flip dirty on.
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
