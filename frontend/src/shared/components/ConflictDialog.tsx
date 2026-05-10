import { useEffect } from "react";

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
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;
  return (
    <div className="confirm-dialog-overlay" onClick={onCancel}>
      <div
        className="confirm-dialog conflict-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="conflict-dialog-title">⚠ 外部編集を検出しました</div>
        <div className="confirm-dialog-message">
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
            type="button"
            className="confirm-dialog-btn confirm-dialog-btn-ok"
            onClick={onReload}
            autoFocus
          >
            再読み込み (推奨)
          </button>
        </div>
      </div>
    </div>
  );
}
