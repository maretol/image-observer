// Lightweight keyboard helpers.
//
// `zoomCommandBus` is a single-listener pubsub used for "ask the active
// ImageView to do something" — the active panel's ImageView registers
// itself on mount/active-change, the App-level keydown handler emits.
// Single-listener (not Set) is intentional: only one ImageView is active
// at a time, and we want a clean takeover when activation changes.

export type ZoomCommand = "fit" | "actualSize" | "in" | "out";

type Listener = (cmd: ZoomCommand) => void;

let zoomListener: Listener | null = null;

export const zoomCommandBus = {
  setListener(fn: Listener | null): void {
    zoomListener = fn;
  },
  emit(cmd: ZoomCommand): boolean {
    if (!zoomListener) return false;
    zoomListener(cmd);
    return true;
  },
  hasListener(): boolean {
    return zoomListener !== null;
  },
};

// Don't intercept keys while the user is typing into a form control or
// contenteditable region (search box, edit popover, settings dialog inputs).
export function isEditableTarget(target: EventTarget | null): boolean {
  // Guard so the file can be imported in non-DOM test environments without
  // a ReferenceError at module load.
  if (typeof HTMLElement === "undefined") return false;
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}

// Cmd on macOS, Ctrl on Linux/Windows. The dev/target environment is
// Linux/Windows so Ctrl wins, but accept either for portability.
export function isPrimaryModifier(e: KeyboardEvent): boolean {
  return Boolean(e.ctrlKey || e.metaKey);
}
