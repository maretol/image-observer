import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

type ModalShellProps = {
  open: boolean;
  onClose: () => void;
  role?: "dialog" | "alertdialog";
  // true (既定) で backdrop クリックが onClose を呼ぶ。ConfirmDialog は明示的な決定が要る yes/no なので false。
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

// confirm 系 dialog の共有ラッパ。提供機能:
//   - document.body への portal (overlay を UI-scale chrome の上に置く)
//   - backdrop クリック → onClose (closeOnBackdrop=false で opt-out)
//   - Esc → onClose (closeOnEscape=false で opt-out)
//   - dialog 内 focusable 間の Tab focus trap
//   - open 時に dialog へ初期 focus (呼び出し側が ref で指定可)
//   - close 時に直前 focus を復元
//   - zoom: var(--ui-scale, 1) を内側 dialog にだけ適用 (backdrop は全画面のまま)
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
  // 現在の click が bare backdrop での pointerdown から始まったか。browser は
  // pointerdown/up ターゲットの最深共通祖先で click を発火するので、textarea 内で始まり
  // backdrop 上で release した選択 drag が backdrop click として dialog を閉じてしまうため (#96)。
  const downOnBackdropRef = useRef(false);

  // open 時に直前 focus を捕捉し close 時に復元。
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    // useEffect は layout 後に走るので portal subtree を query できる。
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
