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

// isTextEntryTarget reports whether the event target is a free-text field
// (text-like input / textarea / contenteditable) where a bare letter should
// type a character rather than trigger a focus shortcut.
//
// This is deliberately narrower than shared/utils/keybindings.isEditableTarget:
// radio and checkbox inputs are NOT text entry, so a user sitting on a
// confidence radio can still press "n" to jump to the note. Typing into the
// tag input or the note textarea is still protected.
export function isTextEntryTarget(target: EventTarget | null): boolean {
  // Guard so this module imports cleanly in a non-DOM (node) test env.
  if (typeof HTMLElement === "undefined") return false;
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") {
    const type = (target as HTMLInputElement).type;
    return type !== "radio" && type !== "checkbox";
  }
  return false;
}
