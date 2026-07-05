import { useRef } from "react";
import { t } from "../messages";
import { ModalShell } from "./ModalShell";

export type ConflictDialogProps = {
  open: boolean;
  onReload: () => void;
  onForce: () => void;
  onCancel: () => void;
};

// アプリ内編集中に外部プロセスが _classification.json を変更したときの 3 ボタン dialog (spec-classification.md §4.10)。
export function ConflictDialog({
  open,
  onReload,
  onForce,
  onCancel,
}: ConflictDialogProps) {
  const reloadRef = useRef<HTMLButtonElement>(null);
  return (
    <ModalShell
      open={open}
      onClose={onCancel}
      role="alertdialog"
      initialFocusRef={reloadRef}
      ariaLabelledBy="conflict-dialog-title"
      ariaDescribedBy="conflict-dialog-message"
      overlayClassName="confirm-dialog-overlay"
      dialogClassName="confirm-dialog conflict-dialog"
    >
      <div className="conflict-dialog-title" id="conflict-dialog-title">
        {t("dialog.conflict.title")}
      </div>
      <div className="confirm-dialog-message" id="conflict-dialog-message">
        {t("dialog.conflict.message")}
      </div>
      <div className="confirm-dialog-buttons conflict-dialog-buttons">
        <button
          type="button"
          className="confirm-dialog-btn"
          onClick={onCancel}
        >
          {t("common.cancel")}
        </button>
        <button
          type="button"
          className="confirm-dialog-btn"
          onClick={onForce}
        >
          {t("dialog.conflict.force")}
        </button>
        <button
          ref={reloadRef}
          type="button"
          className="confirm-dialog-btn confirm-dialog-btn-ok"
          onClick={onReload}
        >
          {t("dialog.conflict.reload")}
        </button>
      </div>
    </ModalShell>
  );
}
