import { useRef } from "react";
import { ModalShell } from "./ModalShell";

export type ConflictDialogProps = {
  open: boolean;
  onReload: () => void;
  onForce: () => void;
  onCancel: () => void;
};

// Three-button dialog used when an external process modified
// _classification.json while the user was editing in-app.
// See spec-classification.md §4.10.
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
        ⚠ 外部編集を検出しました
      </div>
      <div className="confirm-dialog-message" id="conflict-dialog-message">
        このファイルを開いてからの間に、別のプロセス
        (AI ツールやテキストエディタ) が _classification.json を編集しました。
        どうしますか?
      </div>
      <div className="confirm-dialog-buttons conflict-dialog-buttons">
        <button
          type="button"
          className="confirm-dialog-btn"
          onClick={onCancel}
        >
          キャンセル
        </button>
        <button
          type="button"
          className="confirm-dialog-btn"
          onClick={onForce}
        >
          強制上書き
        </button>
        <button
          ref={reloadRef}
          type="button"
          className="confirm-dialog-btn confirm-dialog-btn-ok"
          onClick={onReload}
        >
          再読み込み (推奨)
        </button>
      </div>
    </ModalShell>
  );
}
