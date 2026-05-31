import { useRef } from "react";
import type { classification } from "../../../wailsjs/go/models";
import { t } from "../messages";
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
      // Three explicit actions (merge / skip / cancel) — a stray backdrop
      // click shouldn't be treated as cancel, since it conflates "I didn't
      // mean to click" with a real decision to ignore the children.
      closeOnBackdrop={false}
      initialFocusRef={mergeRef}
      ariaLabel={t("dialog.merge.aria")}
      overlayClassName="confirm-dialog-overlay"
      dialogClassName="confirm-dialog cls-merge-dialog"
    >
      <div className="confirm-message">
        <strong>{t("dialog.merge.heading")}</strong>
        {/* Mixed-markup sentence (embeds <code>) — left inline; a flat string
            catalog can't represent the <code> span. Deferred to Phase 2 (#83). */}
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
              {t("dialog.merge.count", {
                nonEmpty: c.nonEmptyCount,
                total: c.entryCount,
              })}
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
          {t("common.cancel")}
        </button>
        <button
          type="button"
          className="confirm-btn confirm-btn-secondary"
          onClick={onSkip}
        >
          {t("dialog.merge.skip")}
        </button>
        <button
          ref={mergeRef}
          type="button"
          className="confirm-btn confirm-btn-primary"
          onClick={onMerge}
        >
          {t("dialog.merge.merge")}
        </button>
      </div>
    </ModalShell>
  );
}
