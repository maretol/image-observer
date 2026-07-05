import type { classification } from "../../../wailsjs/go/models";

// SampleEditPane が blur / radio 変更で onSave する前のゲート (spec-edit-autosave.md
// §10-E A)。3 条件すべて必要:
//   - autoSave — ユーザーが #105 モードを選択済み (settings.editAutoSave)
//   - entry    — 保存対象の baseline がある (prev/next race 中は null プレースホルダ)
//   - dirty    — baseline と差分がある (変更なし blur で IPC を焼かないため)
export function shouldAutoSave(
  autoSave: boolean,
  entry: classification.Entry | null,
  dirty: boolean,
): boolean {
  return autoSave && entry !== null && dirty;
}
