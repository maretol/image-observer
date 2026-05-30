// Single-key focus shortcuts for the SampleModal edit pane (#115): with the
// modal open and focus NOT in a text field, pressing t / c / n jumps focus to
// the tag input / confidence radios / note textarea respectively. The pure
// bits (key → field mapping, "is this a text field?" predicate) live here so
// they can be unit-tested; SampleEditPane owns the refs and the focus calls.

export type EditField = "tags" | "confidence" | "note";

// editShortcutField maps a bare keystroke to the edit field it focuses, or
// null for any other key. Case-insensitive so Shift/CapsLock still work.
// Callers must still reject modifier combos (Ctrl+T etc.) and text-entry
// focus before acting.
export function editShortcutField(key: string): EditField | null {
  switch (key.toLowerCase()) {
    case "t":
      return "tags";
    case "c":
      return "confidence";
    case "n":
      return "note";
    default:
      return null;
  }
}

// Input `type`s that accept free text — where a bare letter types a character.
// Everything else (radio, checkbox, range, button, color, file, date, …) is
// NOT text entry, so the t/c/n shortcuts stay live on those controls. An
// <input> with a missing or unknown type reports `type === "text"`, so a plain
// <input> is covered by this set.
const TEXT_INPUT_TYPES = new Set([
  "text",
  "search",
  "url",
  "email",
  "tel",
  "password",
  "number",
]);

// isTextEntryTarget reports whether the event target is a free-text field
// (a text-entry <input> per TEXT_INPUT_TYPES, a <textarea>, or a
// contenteditable element) where a bare letter should type a character rather
// than trigger a focus shortcut.
//
// Deliberately narrower than shared/utils/keybindings.isEditableTarget: only
// the input types above count, so a user sitting on a confidence radio (or any
// other non-text control) can still press "n" to jump to the note, while
// typing into the tag input or the note textarea stays protected. Using an
// allowlist (rather than excluding radio/checkbox) keeps the intent explicit
// and correct for future input types (Copilot review #117).
export function isTextEntryTarget(target: EventTarget | null): boolean {
  // Guard so this module imports cleanly in a non-DOM (node) test env.
  if (typeof HTMLElement === "undefined") return false;
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") {
    return TEXT_INPUT_TYPES.has((target as HTMLInputElement).type);
  }
  return false;
}
