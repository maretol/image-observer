import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

type ModalShellProps = {
  open: boolean;
  onClose: () => void;
  role?: "dialog" | "alertdialog";
  // True (default) makes a click on the backdrop call onClose. ConfirmDialog
  // sets this to false because it's a yes/no question that needs an explicit
  // decision.
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  ariaDescribedBy?: string;
  overlayClassName?: string;
  dialogClassName?: string;
  children: ReactNode;
};

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getFocusableList(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

// Shared modal wrapper for confirm-style dialogs. Provides:
//   - portal to document.body (so overlay sits above the UI-scale chrome)
//   - backdrop click → onClose (opt-out via closeOnBackdrop=false)
//   - Esc → onClose (opt-out via closeOnEscape=false)
//   - Tab focus trap between the dialog's focusable descendants
//   - initial focus moved into the dialog on open (caller may pin a ref)
//   - previously focused element restored on close
//   - zoom: var(--ui-scale, 1) applied to the inner dialog only (backdrop
//     stays full-viewport — same pattern as SettingsDialog)
export function ModalShell({
  open,
  onClose,
  role = "dialog",
  closeOnBackdrop = true,
  closeOnEscape = true,
  initialFocusRef,
  ariaLabel,
  ariaLabelledBy,
  ariaDescribedBy,
  overlayClassName = "modal-overlay",
  dialogClassName = "modal-dialog",
  children,
}: ModalShellProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Tracks whether the current click began with a pointerdown on the bare
  // backdrop. Browsers fire `click` on the deepest common ancestor of the
  // pointerdown/pointerup targets, so a text-selection drag that starts inside
  // a textarea and releases over the backdrop would otherwise trigger a
  // backdrop click and close the dialog (#96).
  const downOnBackdropRef = useRef(false);

  // Capture previous focus on open and restore it on close.
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    // Defer one tick so the portal subtree is laid out before we query it.
    const target =
      initialFocusRef?.current ??
      (dialogRef.current ? getFocusableList(dialogRef.current)[0] : null);
    target?.focus();
    return () => {
      previouslyFocused?.focus?.();
    };
  }, [open, initialFocusRef]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (closeOnEscape && e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const focusables = getFocusableList(root);
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (!active || active === first || !root.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (!active || active === last || !root.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, closeOnEscape]);

  if (!open) return null;

  return createPortal(
    <div
      className={overlayClassName}
      onPointerDown={(e) => {
        downOnBackdropRef.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        const startedHere = downOnBackdropRef.current;
        downOnBackdropRef.current = false;
        if (!closeOnBackdrop) return;
        if (e.target !== e.currentTarget) return;
        if (!startedHere) return;
        onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={dialogClassName}
        role={role}
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy}
        onClick={(e) => e.stopPropagation()}
        style={{ zoom: "var(--ui-scale, 1)" }}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
