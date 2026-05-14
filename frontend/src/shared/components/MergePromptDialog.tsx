import { useRef } from "react";
import type { classification } from "../../../wailsjs/go/models";
import { ModalShell } from "./ModalShell";

export type MergePromptDialogProps = {
  open: boolean;
  preview: classification.MergePreview | null;
  onMerge: () => void;
  onSkip: () => void;
  onCancel: () => void;
};

// MergePromptDialog is shown the first time a parent folder without its own
// sidecar is opened, when child folders contain non-trivial classification
// data. The user picks one of three actions:
//
//   - merge:  consume children and write a parent sidecar with prefixed paths
//   - skip:   create an empty parent sidecar; ignore children entirely
//   - cancel: keep folder selection but make no on-disk change (the user can
//             revisit this with a manual reload)
export function MergePromptDialog({
  open,
  preview,
  onMerge,
  onSkip,
  onCancel,
}: MergePromptDialogProps) {
  const mergeRef = useRef<HTMLButtonElement>(null);
  if (!preview) return null;
  const children = preview.children ?? [];
  return (
    <ModalShell
      open={open}
      onClose={onCancel}
      initialFocusRef={mergeRef}
      ariaLabel="子フォルダのサイドカーをマージ"
      overlayClassName="confirm-overlay"
      dialogClassName="confirm-dialog cls-merge-dialog"
    >
      <div className="confirm-message">
        <strong>子フォルダのサイドカーが見つかりました</strong>
        <p>
          以下の子フォルダの分類データを親 (
          <code>_classification.json</code>) に取り込めます。
        </p>
      </div>
      <ul className="cls-merge-list">
        {children.map((c) => (
          <li key={c.subfolder} className="cls-merge-item">
            <span className="cls-merge-folder">{c.subfolder}/</span>
            <span className="cls-merge-source">{c.source}</span>
            <span className="cls-merge-counts">
              {c.nonEmptyCount} / {c.entryCount} 件
            </span>
          </li>
        ))}
      </ul>
      <div className="confirm-buttons">
        <button
          type="button"
          className="confirm-btn confirm-btn-cancel"
          onClick={onCancel}
        >
          キャンセル
        </button>
        <button
          type="button"
          className="confirm-btn confirm-btn-secondary"
          onClick={onSkip}
        >
          無視して空の親サイドカーを作成
        </button>
        <button
          ref={mergeRef}
          type="button"
          className="confirm-btn confirm-btn-primary"
          onClick={onMerge}
        >
          マージして親に取込
        </button>
      </div>
    </ModalShell>
  );
}
