import { useCallback, useRef, useState } from "react";
import { ModalShell } from "./ModalShell";

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

  const dialog = (
    <ConfirmDialog
      open={state !== null}
      message={state?.message ?? ""}
      onConfirm={handleConfirm}
      onCancel={handleCancel}
    />
  );

  return { confirm, dialog };
}

type ConfirmDialogProps = {
  open: boolean;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
};

function ConfirmDialog({ open, message, onConfirm, onCancel }: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <ModalShell
      open={open}
      onClose={onCancel}
      role="alertdialog"
      // Yes/no question — require an explicit decision instead of dismissing
      // on a stray backdrop click.
      closeOnBackdrop={false}
      initialFocusRef={cancelRef}
      ariaDescribedBy="confirm-dialog-message"
      overlayClassName="confirm-dialog-overlay"
      dialogClassName="confirm-dialog"
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
          type="button"
          className="confirm-dialog-btn confirm-dialog-btn-ok"
          onClick={onConfirm}
        >
          OK
        </button>
      </div>
    </ModalShell>
  );
}
