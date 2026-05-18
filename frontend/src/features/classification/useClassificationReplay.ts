import { useCallback, useEffect, useRef } from "react";
import { LoadClassification } from "../../../wailsjs/go/main/App";
import { classification } from "../../../wailsjs/go/models";
import type { ToastFn } from "../../shared/components/Toast";
import { errorMessage } from "../../shared/utils/error";
import { logger } from "../../shared/utils/logger";
import { WATCH_MODE_OFF } from "../settings/watchMode";
import type {
  ConflictPrompt,
  EditingState,
  MergePromptState,
  PendingResult,
} from "./useClassification";
import { decideAutoMerge } from "./watcherPolicy";

type Props = {
  // Defer-source state (drives the open→close detection effects below).
  editing: EditingState;
  conflict: ConflictPrompt | null;
  mergePrompt: MergePromptState;

  // shared refs
  folderRef: React.MutableRefObject<string>;
  watchModeRef: React.MutableRefObject<string | undefined>;
  requestGenRef: React.MutableRefObject<number>;
  loadResultRef: React.MutableRefObject<classification.LoadResult | null>;
  editingRef: React.MutableRefObject<EditingState>;
  conflictRef: React.MutableRefObject<ConflictPrompt | null>;
  mergePromptOpenRef: React.MutableRefObject<boolean>;
  pendingResultRef: React.MutableRefObject<PendingResult | null>;

  // setters
  setLoadResult: React.Dispatch<
    React.SetStateAction<classification.LoadResult | null>
  >;
  setError: (msg: string | null) => void;
  setEditing: React.Dispatch<React.SetStateAction<EditingState>>;

  // collaborators
  commitFreshResult: (
    fresh: classification.LoadResult,
    fnames: ReadonlySet<string>,
  ) => void;
  resetEntriesDependentState: () => void;
  toast: ToastFn;
};

// useClassificationReplay handles the parked-payload commit when any of the
// three defer sources (editing-open / conflict-open / mergePrompt-open)
// transitions open → closed. performReplay centralises four corner cases
// that the per-effect implementations kept getting subtly wrong as more
// cases piled up:
//   1) folder switched while deferred → drop pending
//   2) mtime advanced (user saved while deferred → pending.fresh is
//      pre-save) → re-Load instead of committing the stale snapshot,
//      otherwise the user's edit gets visually rolled back (PR #75 review)
//   3) re-running decideAutoMerge so editing-target-removed exception
//      still fires if it arose while deferring
//   4) re-parking when one defer source closed but another is still open
//      (e.g. conflict resolved → editing still open with target)
//
// The replay reload (case 2) bumps requestGenRef so that any in-flight
// watcher-handler Load whose result returns *after* this reload's commit
// is discarded as stale (out-of-order ordering between the event-driven
// path and the replay-driven path). The reload also honours its own
// generation in its catch / success guards.
export function useClassificationReplay(props: Props): void {
  const {
    editing,
    conflict,
    mergePrompt,
    folderRef,
    watchModeRef,
    requestGenRef,
    loadResultRef,
    editingRef,
    conflictRef,
    mergePromptOpenRef,
    pendingResultRef,
    setLoadResult,
    setError,
    setEditing,
    commitFreshResult,
    resetEntriesDependentState,
    toast,
  } = props;

  const performReplay = useCallback(async () => {
    const pending = pendingResultRef.current;
    if (!pending) return;
    if (watchModeRef.current === WATCH_MODE_OFF) {
      // The user disabled monitoring while we held this parked auto-merge
      // result. Commit-on-defer-close would surprise them by reflecting an
      // external change they opted out of (PR #75 review suppressed-g).
      pendingResultRef.current = null;
      return;
    }
    if (pending.folder !== folderRef.current) {
      // Folder switched while parked; the stored result is for the wrong
      // tab. Drop it; a fresh watcher event for the current folder will
      // arrive on its own.
      pendingResultRef.current = null;
      return;
    }
    if (pending.capturedGen !== requestGenRef.current) {
      // Generation drifted: a manual reload / local mutation / another
      // watcher payload committed (and bumped requestGenRef) since this
      // pending was parked. The on-screen state already reflects a newer
      // truth; committing the pending could roll it back even if mtime
      // happens to match (entries-only changes don't bump sidecar mtime,
      // so the mtime check below misses this case — PR #75 11th,
      // suppressed-A).
      pendingResultRef.current = null;
      return;
    }
    let fresh = pending.fresh;
    let reloadedFresh = false;
    const cur = loadResultRef.current;
    if (cur && cur.mtime !== fresh.mtime) {
      // mtime advanced past the park snapshot, which means we (or another
      // path) wrote the sidecar while deferred. The parked fresh is now
      // pre-save state — committing it would visually undo the user's
      // edit. Re-Load to pick up the latest entries + mtime, claiming a
      // new generation so an out-of-order watcher Load can't overwrite us.
      pendingResultRef.current = null;
      const myGen = ++requestGenRef.current;
      try {
        fresh = await LoadClassification(folderRef.current);
        reloadedFresh = true;
      } catch (e) {
        // Drop if a newer request superseded us mid-await (the watcher
        // handler's success path will commit instead).
        if (myGen !== requestGenRef.current) return;
        if (folderRef.current !== pending.folder) return;
        // Also re-check watchMode: the entry-gate above ran before the
        // reload await. If the user flipped to off while awaiting,
        // surfacing the failure would act on monitoring the user opted
        // out of (PR #75 8th, thread B).
        if (watchModeRef.current === WATCH_MODE_OFF) return;
        // Otherwise surface to the user — the suppressed comment in the
        // 4th-round review pointed out that log-only made auto-merge
        // failures invisible. Mirror the manual-reload error path.
        const msg = errorMessage(e);
        setError(msg);
        setLoadResult(null);
        // Clear entries-dependent state alongside loadResult — same rule
        // as loadInternal's catch (PR #75 13th, thread A).
        resetEntriesDependentState();
        toast(`読み込みに失敗しました: ${msg}`, "error");
        logger.warn("classification", "replay reload failed", { err: msg });
        return;
      }
      // Success path also generation-checked: a newer watcher Load may
      // have committed while we awaited; discard so we don't roll it
      // back (PR #75 review).
      if (myGen !== requestGenRef.current) return;
      if (folderRef.current !== pending.folder) return;
      // Same off-during-await guard — committing the freshly-reloaded
      // result after the user disabled monitoring would surprise them
      // (PR #75 8th, thread B).
      if (watchModeRef.current === WATCH_MODE_OFF) return;
    }
    // Even when we didn't reload (mtime matched, fresh = pending.fresh),
    // re-check watchMode here so the deferred commit doesn't slip through
    // after the user disabled monitoring between defer-park and replay
    // trigger. The entry-gate above already handles the case where
    // performReplay starts with watchMode = off, but watchMode could
    // also flip during the reload await covered above (handled there).
    // This final guard catches the "no reload, fresh was parked while
    // watchMode was auto, then user toggled off, then defer closed"
    // sequence (PR #75 8th, thread B).
    if (watchModeRef.current === WATCH_MODE_OFF) {
      pendingResultRef.current = null;
      return;
    }
    if (reloadedFresh) {
      // Clear any leftover error from a previous failed reload — the
      // replay succeeded so the UI should not keep showing it
      // (PR #75 review suppressed-d).
      setError(null);
    }
    const fnames = new Set(fresh.entries.map((e) => e.filename));
    const action = decideAutoMerge({
      editingOpen: editingRef.current.open,
      editingFilename: editingRef.current.filename,
      conflictOpen: conflictRef.current !== null,
      mergePromptOpen: mergePromptOpenRef.current,
      freshFilenames: fnames,
    });
    if (action.kind === "defer") {
      // Re-park with the possibly-fresher snapshot AND the current gen
      // (the snapshot was just refreshed by our reload, so this becomes
      // the new baseline against which future gen drift is measured).
      pendingResultRef.current = {
        fresh,
        folder: pending.folder,
        capturedGen: requestGenRef.current,
      };
      return;
    }
    pendingResultRef.current = null;
    if (action.kind === "commit-editing-removed") {
      toast(`${action.filename} は外部で削除されました`, "warn");
      setEditing({ open: false, filename: null });
    }
    commitFreshResult(fresh, fnames);
  }, [
    commitFreshResult,
    conflictRef,
    editingRef,
    folderRef,
    loadResultRef,
    mergePromptOpenRef,
    pendingResultRef,
    requestGenRef,
    resetEntriesDependentState,
    setEditing,
    setError,
    setLoadResult,
    toast,
    watchModeRef,
  ]);

  // Replay triggers: any of conflict / mergePrompt / editing transitioning
  // open → closed. performReplay drops itself if any *other* defer source
  // is still open.
  const wasInDeferRef = useRef(false);
  useEffect(() => {
    const inDefer = mergePrompt.open || conflict !== null;
    const wasInDefer = wasInDeferRef.current;
    wasInDeferRef.current = inDefer;
    if (wasInDefer && !inDefer) {
      void performReplay();
    }
  }, [mergePrompt.open, conflict, performReplay]);

  const wasEditingOpenRef = useRef(editing.open);
  useEffect(() => {
    const wasOpen = wasEditingOpenRef.current;
    wasEditingOpenRef.current = editing.open;
    if (wasOpen && !editing.open) {
      void performReplay();
    }
  }, [editing.open, performReplay]);
}
