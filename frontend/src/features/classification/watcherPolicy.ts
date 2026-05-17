// Pure helpers backing the fsnotify auto-merge flow in `useClassification`.
// Extracted from the hook so the decision logic can be exercised by vitest
// without React / Wails IPC / DOM in scope. See docs/spec-folder-watch.md §5.
//
// Type-mirrors:
//   ChangedPayload mirrors the Go struct in `internal/watcher.ChangedPayload`.
//   Wails does not generate a TS namespace for it (it never appears in a
//   binding signature — `EventsEmit` is dynamic), so we hand-mirror it here.

/** Shape of the payload emitted by the Go-side watcher via Wails events. */
export type ChangedPayload = {
  folder: string;
  addedFiles: number;
  removedFiles: number;
  renamedFiles: number;
  sidecarChanged: boolean;
};

/**
 * formatChangeSummary returns the user-facing toast text for a payload, or
 * null when the payload carries no UI-visible change (defensive — the Go
 * side already drops empty flushes, so null here is unexpected in practice).
 */
export function formatChangeSummary(p: ChangedPayload): string | null {
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
  return null;
}

/** Minimal view of the hook's UI state needed to decide what to do. */
export type AutoMergeContext = {
  /** True iff the user has the per-card edit popover open. */
  editingOpen: boolean;
  /** filename being edited, or null when editingOpen is false. */
  editingFilename: string | null;
  /** True iff the mtime-conflict resolution dialog is open. */
  conflictOpen: boolean;
  /** True iff the child-sidecar merge confirmation is open. */
  mergePromptOpen: boolean;
  /**
   * Sorted/unsorted entry filenames present in the freshly-loaded result.
   * Passed as a Set for O(1) lookup of the editing target.
   */
  freshFilenames: ReadonlySet<string>;
};

/** Action recommended by `decideAutoMerge`. */
export type AutoMergeAction =
  /** Apply fresh result to loadResult immediately. */
  | { kind: "commit" }
  /**
   * Apply fresh result AND close the editing popover with a warn toast —
   * the editing target was removed externally (spec §5.3 exception).
   */
  | { kind: "commit-editing-removed"; filename: string }
  /**
   * Hold fresh result in a pending ref; replay when the deferral source
   * closes (conflict resolved OR merge prompt resolved).
   */
  | { kind: "defer" };

/**
 * decideAutoMerge picks the right reaction to an incoming `classification:changed`
 * event. Per spec-folder-watch.md §5.3 / §13.8:
 *
 *   - mergePrompt or conflict open → defer (their semantics depend on the
 *     captured mtime / preview being stable until the user resolves)
 *   - editing open AND the edited file is gone in fresh entries →
 *     "commit-editing-removed" exception: close the popover with a warn and
 *     commit immediately (the user can't usefully save a deleted target)
 *   - editing open AND the edited file still exists → defer; if we committed
 *     here we'd advance `loadResult.mtime` to the externally-bumped value
 *     and the user's next save (still using the old draft) would slip past
 *     the mtime-conflict check, silently overwriting the external change
 *     (PR #75 review thread #1)
 *   - otherwise → commit
 *
 * The deferral-close handler in useClassification replays the parked
 * payload through this same function so the exception still fires if the
 * editing target was removed while we were deferring.
 */
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
