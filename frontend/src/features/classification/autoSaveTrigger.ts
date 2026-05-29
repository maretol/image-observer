import type { classification } from "../../../wailsjs/go/models";

// shouldAutoSave is the gate the SampleEditPane uses before firing onSave
// from a blur / radio change. Extracted as a pure helper so the gating rule
// is testable without a DOM harness (spec-edit-autosave.md §10-E A).
//
// All three conditions must hold:
//   - autoSave  — user opted into the #105 mode (settings.editAutoSave)
//   - entry     — the pane has a backing baseline to save against (null
//                 placeholder during prev/next race)
//   - dirty     — there is actually something to save vs the baseline,
//                 so refocus-without-change blurs don't burn IPC
export function shouldAutoSave(
  autoSave: boolean,
  entry: classification.Entry | null,
  dirty: boolean,
): boolean {
  return autoSave && entry !== null && dirty;
}
