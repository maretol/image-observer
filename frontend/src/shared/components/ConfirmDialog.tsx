import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type DialogState = {
  message: string;
  resolve: (ok: boolean) => void;
};

export function useConfirm() {
  const [state, setState] = useState<DialogState | null>(null);

  const confirm = useCallback((message: string): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      setState({ message, resolve });
    });
  }, []);

  const handleConfirm = useCallback(() => {
    setState((s) => {
      s?.resolve(true);
      return null;
    });
  }, []);

  const handleCancel = useCallback(() => {
    setState((s) => {
      s?.resolve(false);
      return null;
    });
  }, []);

  const dialog = state ? (
    <ConfirmDialog
      message={state.message}
      onConfirm={handleConfirm}
      onCancel={handleCancel}
    />
  ) : null;

  return { confirm, dialog };
}

type ConfirmDialogProps = {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
};

function ConfirmDialog({ message, onConfirm, onCancel }: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    return () => {
      previouslyFocusedRef.current?.focus?.();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key === "Tab") {
        // Trap focus between the two buttons.
        e.preventDefault();
        const next =
          document.activeElement === cancelRef.current
            ? confirmRef.current
            : cancelRef.current;
        next?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return createPortal(
    // Portaled to <body>, outside .app-toplevel. We apply --ui-scale to the
    // inner dialog box only — not the overlay — because the overlay is
    // `position: fixed; inset: 0` and scaling it would shrink/grow the dark
    // backdrop away from full-viewport coverage. Same pattern as
    // SettingsDialog (backdrop unscaled, .settings-dialog scaled).
    <div className="confirm-dialog-overlay">
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-describedby="confirm-dialog-message"
        style={{ zoom: "var(--ui-scale, 1)" }}
      >
        <div className="confirm-dialog-message" id="confirm-dialog-message">
          {message}
        </div>
        <div className="confirm-dialog-buttons">
          <button
            ref={cancelRef}
            type="button"
            className="confirm-dialog-btn confirm-dialog-btn-cancel"
            onClick={onCancel}
          >
            キャンセル
          </button>
          <button
            ref={confirmRef}
            type="button"
            className="confirm-dialog-btn confirm-dialog-btn-ok"
            onClick={onConfirm}
          >
            OK
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
