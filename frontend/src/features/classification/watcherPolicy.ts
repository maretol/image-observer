// useClassification の fsnotify auto-merge フローを支える純ヘルパ。判定ロジックを
// React / Wails IPC / DOM 無しで vitest にかけられるよう分離 (docs/spec-folder-watch.md §5)。
// ChangedPayload は Go の internal/watcher.ChangedPayload の手写し — EventsEmit の
// payload は binding signature に出ないので Wails が TS を生成しないため。
export type ChangedPayload = {
  folder: string;
  addedFiles: number;
  removedFiles: number;
  renamedFiles: number;
  sidecarChanged: boolean;
};

// payload の toast 文言を返す。カウンタ無し・sidecar 無しの payload も意味がある:
// Go watcher は非画像/非 sidecar の Remove/Rename (典型はサブディレクトリ消失,
// internal/watcher §7.2) でこれを emit するので、汎用の "変更検出" 文言を返す。
export function formatChangeSummary(p: ChangedPayload): string {
  const filesChanged = p.addedFiles > 0 || p.removedFiles > 0;
  if (filesChanged && p.sidecarChanged) {
    return `フォルダと分類データの変更を検出しました (+${p.addedFiles} -${p.removedFiles})`;
  }
  if (filesChanged) {
    return `フォルダの変更を検出しました (+${p.addedFiles} -${p.removedFiles})`;
  }
  if (p.sidecarChanged) {
    return "分類データが外部で更新されました";
  }
  // サブツリー消失/移動 — 件数は無いが on-disk set は変わった。文言はあえて汎用。
  return "フォルダの変更を検出しました";
}

export type AutoMergeContext = {
  editingOpen: boolean;
  editingFilename: string | null; // editingOpen が false のとき null
  conflictOpen: boolean; // mtime 競合解決ダイアログ
  mergePromptOpen: boolean; // 子 sidecar マージ確認
  freshFilenames: ReadonlySet<string>; // 再 Load 結果の filename (O(1) 照合用に Set)
};

export type AutoMergeAction =
  | { kind: "commit" } // fresh を即 loadResult へ適用
  // 編集対象が外部削除された: warn toast で popover を閉じて即 commit (spec §5.3 例外)
  | { kind: "commit-editing-removed"; filename: string }
  // fresh を pending に保持、deferral 元 (conflict / merge prompt) が閉じたら replay
  | { kind: "defer" };

// classification:changed への反応を決める (spec-folder-watch.md §5.3 / §13.8)。
//
//   - mergePrompt / conflict が開いている → defer (捕捉した mtime / preview が
//     ユーザー解決まで安定している前提のため)
//   - editing 中で編集対象が fresh から消えた → "commit-editing-removed" 例外:
//     warn で popover を閉じ即 commit (削除済み対象は保存しても無意味)
//   - editing 中で編集対象が残っている → defer。ここで commit すると loadResult.mtime
//     が外部更新値に進み、次の save (古い draft) が mtime 競合チェックをすり抜けて
//     外部変更を握り潰してしまう
//   - それ以外 → commit
//
// useClassification の deferral-close ハンドラは保留 payload を同じ関数で replay
// するので、deferral 中に編集対象が消えても例外が発火する。
export function decideAutoMerge(ctx: AutoMergeContext): AutoMergeAction {
  if (ctx.mergePromptOpen || ctx.conflictOpen) {
    return { kind: "defer" };
  }
  if (ctx.editingOpen && ctx.editingFilename != null) {
    if (!ctx.freshFilenames.has(ctx.editingFilename)) {
      return {
        kind: "commit-editing-removed",
        filename: ctx.editingFilename,
      };
    }
    return { kind: "defer" };
  }
  return { kind: "commit" };
}
