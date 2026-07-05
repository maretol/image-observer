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

// sidecar を持たない親フォルダを初めて開き、子フォルダに非自明な分類データがあるとき表示。3 択:
//   - merge:  子を取り込み prefix 付き path で親 sidecar を書く
//   - skip:   空の親 sidecar を作り子を無視
//   - cancel: フォルダ選択は残しディスクは変えない (manual reload で再訪可)
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
      // 3 択 (merge / skip / cancel) なので、うっかりの backdrop クリックを cancel 扱いしない
      // (誤クリックと「子を無視する決定」を混同するため)。
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
