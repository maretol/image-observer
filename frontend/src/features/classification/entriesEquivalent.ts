import { classification } from "../../../wailsjs/go/models";

// entriesEquivalent: order-sensitive shallow compare of every Entry field
// the user cares about. Used by the watcher auto-merge handler to detect
// "the fresh re-Load matches what we already display" so we don't spam the
// user with toast notifications for our own Save/Delete echoes
// (PR #75 review thread #3). Service.Load returns entries in a stable
// (sidecar-order then alphabetical) sequence so ordered comparison is safe.
export function entriesEquivalent(
  a: classification.Entry[],
  b: classification.Entry[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.filename !== y.filename ||
      x.folder !== y.folder ||
      x.confidence !== y.confidence ||
      x.note !== y.note
    ) {
      return false;
    }
  }
  return true;
}
