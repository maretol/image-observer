import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DeleteImage,
  LoadClassification,
  SaveClassification,
} from "../../../wailsjs/go/main/App";
import { classification } from "../../../wailsjs/go/models";
import { state as wstate } from "../../../wailsjs/go/models";
import { useToastFn } from "../../shared/components/Toast";
import { errorMessage } from "../../shared/utils/error";
import { logger } from "../../shared/utils/logger";
import type { ConfirmFn } from "../viewer-grid/useViewerSet";
import { entriesEquivalent } from "./entriesEquivalent";
import { type ListTabFilter } from "./filters";
import { useClassificationFilter } from "./useClassificationFilter";
import { useClassificationEdit } from "./useClassificationEdit";
import { useClassificationLoad } from "./useClassificationLoad";
import { useClassificationMerge } from "./useClassificationMerge";
import { useClassificationReplay } from "./useClassificationReplay";
import { useClassificationSelection } from "./useClassificationSelection";
import { useClassificationWatcher } from "./useClassificationWatcher";
import { useDirectoryGroups } from "./useDirectoryGroups";

// Re-export CLASSIFICATION_CHANGED_EVENT for tests and existing callers.
// The canonical declaration lives in `./useClassificationWatcher` next to
// the EventsOn subscription that consumes it.
export { CLASSIFICATION_CHANGED_EVENT } from "./useClassificationWatcher";

const CONFLICT_PREFIX = "CONFLICT:";

export type EditingState = {
  open: boolean;
  filename: string | null;
};

export type ConflictPrompt = {
  filename: string;
  draft: classification.Entry;
};

// PendingResult captures a watcher-supplied LoadResult that arrived while a
// defer source (editing / conflict / merge prompt) was active, plus the
// folder context and request generation at park time. performReplay uses
// `folder` and `capturedGen` to discard the pending if state moved on while
// the user resolved the defer (PR #75 11th, suppressed-A). Exported so the
// watcher / replay hooks can type the shared ref.
export type PendingResult = {
  fresh: classification.LoadResult;
  folder: string;
  capturedGen: number;
};

export type MergePromptState = {
  open: boolean;
  preview: classification.MergePreview | null;
  // The folder this prompt is for. Captured at trigger time so the user can
  // change folder selection (cancel + reopen) without contaminating state.
  folderPath: string;
};

export type UseClassificationReturn = {
  folderPath: string;
  loadResult: classification.LoadResult | null;
  loading: boolean;
  error: string | null;
  filter: ListTabFilter;
  filteredEntries: classification.Entry[];
  editing: EditingState;
  conflict: ConflictPrompt | null;
  mergePrompt: MergePromptState;
  collapsedGroups: string[];
  isCollapsed: (key: string) => boolean;
  toggleGroup: (key: string) => void;
  expandAllGroups: () => void;
  collapseAllGroups: (keys: string[]) => void;
  // Multi-select state. Selection is keyed by filename (POSIX-relative inside
  // the current folder) and is cleared automatically when folderPath changes.
  // It survives filter / collapse changes so the user can refine and then
  // open the survivors in bulk.
  selectedFilenames: string[];
  isSelected: (filename: string) => boolean;
  toggleSelected: (filename: string) => void;
  // Range select: if an anchor is set (most recent toggle), select every
  // filename between the anchor and `filename` in `displayedOrder` (which
  // the caller computes from the visible group ordering). With no anchor or
  // when either endpoint isn't in the displayed order, falls back to a
  // single toggle.
  extendSelectionTo: (filename: string, displayedOrder: string[]) => void;
  clearSelected: () => void;
  openFolder: () => Promise<void>;
  reload: () => Promise<void>;
  setFilter: (patch: Partial<ListTabFilter>) => void;
  toggleTag: (tag: string) => void;
  clearTags: () => void;
  openEdit: (filename: string) => void;
  closeEdit: () => void;
  saveEdit: (entry: classification.Entry) => Promise<void>;
  resolveConflictReload: () => Promise<void>;
  resolveConflictForce: () => Promise<void>;
  resolveConflictCancel: () => void;
  resolveMergeMerge: () => Promise<void>;
  resolveMergeSkip: () => Promise<void>;
  resolveMergeCancel: () => void;
  // deleteOne sends one image to the OS recycle bin (Windows; os.Remove in
  // dev builds — see internal/imgfile.Trash) and mirrors the removal into
  // the sidecar. Returns true iff the file is no longer on disk so the
  // caller can also close any viewer tabs still pointing at it. False on
  // user cancel or pre-sidecar failure (file untouched).
  deleteOne: (filename: string) => Promise<boolean>;
  persistableState: {
    folderPath: string;
    filter: { tags: string[]; confidence: string; query: string };
    collapsedGroups: string[];
  };
};

type Opts = {
  initialList?: wstate.ListTabState | null;
  confirm: ConfirmFn;
  // settings.watchMode: the WATCH_MODE_AUTO / WATCH_MODE_OFF literals
  // (frontend/src/features/settings/watchMode.ts, pinned to the Go-side
  // `internal/settings.WatchMode*` values via AGENTS.md D-1 drift tests).
  // Typed as `string` because the Wails-generated `SettingsData.watchMode`
  // is `string`; Go-side Validate guarantees one of the two literals at
  // load time, so direct equality with the constants is safe.
  //
  // Undefined while settings are still loading; the watch effect intentionally
  // waits in that state — Start would briefly run a watcher for users who
  // have persisted watchMode = "off", and Stop would race with a settings-load
  // that immediately wants a Start. The effect kicks in once settings hydrate.
  watchMode?: string;
};

export function useClassification(opts: Opts): UseClassificationReturn {
  const initFolderPath = opts.initialList?.folderPath ?? "";

  const [folderPath, setFolderPath] = useState<string>(initFolderPath);
  const [loadResult, setLoadResult] =
    useState<classification.LoadResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { filter, filteredEntries, setFilter, toggleTag, clearTags } =
    useClassificationFilter({
      initial: opts.initialList?.filter ?? null,
      loadResult,
    });
  const [editing, setEditing] = useState<EditingState>({
    open: false,
    filename: null,
  });
  const [conflict, setConflict] = useState<ConflictPrompt | null>(null);
  const [mergePrompt, setMergePrompt] = useState<MergePromptState>({
    open: false,
    preview: null,
    folderPath: "",
  });
  const {
    selected,
    selectedFilenames,
    isSelected,
    toggleSelected,
    extendSelectionTo,
    clearSelected,
    setSelected,
    resetForFolderSwitch: resetSelectionForFolderSwitch,
  } = useClassificationSelection();
  const groups = useDirectoryGroups(opts.initialList?.collapsedGroups ?? []);

  const toast = useToastFn();
  const { confirm, watchMode } = opts;

  // Refs that the watcher event handler reads. Mirrored from state so the
  // single EventsOn callback (registered once for the hook's lifetime — see
  // the empty-deps subscription effect below) always sees the latest
  // decision-relevant values without needing a fresh closure on every state
  // change.
  //
  // folderRef and watchModeRef are synced during render (not in a useEffect)
  // so that watcher events arriving between a state / prop change and the
  // post-render effect can't slip through with a stale value. A typical
  // failure mode: user picks folder B, setFolderPath(B) is called, but
  // folderRef.current is still A until the post-commit effect runs. An
  // in-flight event for folder A would then pass the "payload.folder ===
  // folderRef.current" check and get auto-merged into the wrong list
  // (PR #75 review). React's render phase is allowed to mutate refs —
  // they are not part of the React state model.
  const folderRef = useRef(folderPath);
  folderRef.current = folderPath;
  const watchModeRef = useRef<string | undefined>(opts.watchMode);
  watchModeRef.current = opts.watchMode;

  // editingRef / conflictRef / mergePromptOpenRef are ALSO synced during
  // render (same reason as folderRef / watchModeRef above): a watcher
  // event arriving between `setEditing({ open: true, ... })` and the
  // post-render effect would see the ref still showing "closed" and
  // commit the change immediately — bypassing the defer logic. The
  // really bad sub-case is editing-open: the handler would silently
  // patch loadResult.mtime to the fresh value, and the user's next
  // saveEdit would pass the mtime conflict check despite reading a
  // pre-external-edit draft (PR #75 12th, thread A). Ref mutation in
  // render is allowed (refs aren't part of React state model).
  const editingRef = useRef<EditingState>(editing);
  editingRef.current = editing;
  const conflictRef = useRef<ConflictPrompt | null>(conflict);
  conflictRef.current = conflict;
  const mergePromptOpenRef = useRef(mergePrompt.open);
  mergePromptOpenRef.current = mergePrompt.open;

  // pendingResultRef parks a LoadClassification result that arrived during a
  // defer state (conflict, mergePrompt, or editing-open with target intact).
  // The deferral-close effects below commit it when the user finishes
  // resolving. `folder` is captured at park time so a folder-switch while
  // deferred causes the replay to discard the now-stale result instead of
  // splatting the wrong folder's entries onto the new one (PR #75 review).
  // `capturedGen` is the `requestGenRef` value at park time — if anything
  // else (manual reload / mutation / another watcher event) bumps the gen
  // while the user resolves the defer, the replay drops this pending so a
  // mtime-equal-but-entries-different commit can't roll back the newer
  // state (PR #75 11th, suppressed-A).
  const pendingResultRef = useRef<PendingResult | null>(null);

  // resetEntriesDependentState clears every piece of state whose meaning is
  // tied to the entries list (= the file we were editing, the conflict
  // draft for a specific file, the merge prompt for a specific folder, a
  // parked auto-merge result, the filename-keyed selection). Call this
  // alongside `setLoadResult(null)` in error-driven catch paths so that
  // when the entries we were operating on disappear, the dependent state
  // doesn't strand:
  //   - editing.open=true with EditPopover showing entry=null is visually
  //     harmless but causes the next watcher event to defer (the handler
  //     treats it as "still open"), and re-surfaces the popover if the
  //     same filename reappears.
  //   - conflict / mergePrompt similarly carry stale folder / draft
  //     pointers that surface in misleading ways on next render.
  //   - pendingResultRef would replay against a now-empty loadResult.
  //   - filename-keyed selection becomes nonsensical without entries.
  // (PR #75 13th, thread A). Called from all three catch sites that null
  // loadResult: loadInternal, handleWatcherPayload, performReplay reload.
  // Declared here (before loadInternal) so the useCallback dep list works
  // — moving it after loadInternal would put it in TDZ at useCallback
  // dispatch time.
  const resetEntriesDependentState = useCallback(() => {
    setEditing({ open: false, filename: null });
    setConflict(null);
    setMergePrompt({ open: false, preview: null, folderPath: "" });
    pendingResultRef.current = null;
    resetSelectionForFolderSwitch();
  }, [resetSelectionForFolderSwitch]);

  // requestGenRef gates every `setLoadResult` / `setError` commit triggered
  // by an asynchronous Load so that out-of-order completions can't roll back
  // a newer result. Bumped at the entry of:
  //   - loadInternal (manual reload / openFolder / auto-load on mount /
  //     conflict-resolve / merge-resolve / delete-conflict-retry)
  //   - handleWatcherPayload (each watcher event)
  //   - performReplay's reload branch
  // Every commit path checks `myGen === current` before touching state.
  // Without a single shared generation across all of these, a stale Load
  // from any one of them could clobber the others (PR #75 review).
  const requestGenRef = useRef(0);

  // loadingTokenRef is bumped *only* by loadInternal (the paths that set
  // `loading: true`). The spinner-release in loadInternal's finally checks
  // this token, not requestGenRef — otherwise a watcher event arriving while
  // a manual Load is awaiting would bump the shared generation, the manual
  // Load's stale-check would skip setLoading(false), and the spinner would
  // hang because the watcher path never touched `loading` in the first place
  // (PR #75 review).
  const loadingTokenRef = useRef(0);

  // initialLoadInFlightRef is true while any loadInternal call is awaiting
  // LoadClassification. silentRecheckAfterStart reads this to defer its
  // own read until the initial load's commit has landed — otherwise the
  // two same-generation Loads can both commit and the later-arriving one
  // wins regardless of which read was actually newer. This was the race
  // that Round 11 thread A (silent recheck bumping the gen) and Round 12
  // thread C (silent recheck snapshotting only) traded off; gating on a
  // separate "is initial load still going?" flag breaks the tie cleanly
  // (PR #75 12th, thread C).
  const initialLoadInFlightRef = useRef(false);

  // dispatchWatchIntentRef is declared here (above useClassificationLoad)
  // so reload() can read it via ref to kick a watcher reconcile when the
  // user manually re-reads. The actual implementation is assigned during
  // render further down (in the watcher section) — refs are not part of
  // React's render-immutable state model, so the function identity bound
  // to .current can be replaced each render without invalidating any
  // consumers (they all dereference through .current at call time).
  const dispatchWatchIntentRef = useRef<() => void>(() => {});

  const { openFolder, reload, loadInternal } = useClassificationLoad({
    initFolderPath,
    folderRef,
    requestGenRef,
    loadingTokenRef,
    initialLoadInFlightRef,
    dispatchWatchIntentRef,
    setFolderPath,
    setLoadResult,
    setLoading,
    setError,
    setMergePrompt,
    resetEntriesDependentState,
    confirm,
    toast,
  });


  // ─── fsnotify auto-merge (#19) ─────────────────────────────────────
  //
  // handleWatcherPayload runs on every flushed "classification:changed"
  // event from the Go watcher (see internal/watcher + docs/spec-folder-watch.md).
  // It reads decision-relevant state via refs so its identity can change on
  // each render without us needing to re-bind the EventsOn listener (see
  // the mount-once subscription effect below + handlerRef indirection).
  //
  // loadResultRef mirrors loadResult so the handler can compare the incoming
  // re-Load to what we already display without depending on loadResult
  // directly (which would force a new handleWatcherPayload identity each
  // render and grow the dep churn). Synced render-time (not via useEffect)
  // because the handler reads it in its self-echo check — if a watcher
  // event lands between `setLoadResult(patch)` and the post-render effect,
  // the handler would compare against the PRE-patch entries and falsely
  // classify the watcher echo of our just-completed save as an external
  // change, surfacing "外部変更" toasts / unnecessary commits for normal
  // saves (PR #75 14th, thread B). Same reasoning as folderRef /
  // watchModeRef / editingRef / conflictRef / mergePromptOpenRef above.
  const loadResultRef = useRef<classification.LoadResult | null>(loadResult);
  loadResultRef.current = loadResult;

  // inFlightDeletesRef tracks filenames whose Delete IPC has fired but whose
  // sidecar save / local state patch hasn't completed yet. The watcher fires
  // a Remove event almost immediately, well before our SaveClassification
  // round-trip lands, so by the time the debounced flush arrives at the
  // handler and LoadClassification runs, the fresh entries list already
  // lacks the file (the orphan-filter in Service.Load drops it) while our
  // local loadResult still has it. Without filtering, the entriesEquivalent
  // self-echo check would miss this case and toast "外部で更新されました"
  // for the user's own delete (PR #75 9th, thread J).
  //
  // strip is applied **only to the stale-current side**, not to fresh. If
  // an external writer recreated a file with the same name during our
  // delete IPC round-trip, fresh.entries legitimately contains the new
  // entry; stripping fresh as well would silently hide that re-creation
  // (PR #75 25th, thread D). Asymmetric strip keeps the self-echo case
  // working (cur stripped vs fresh that already lost the file = equivalent
  // = no toast) while still surfacing the recreation case.
  //
  // Scoped per folder (Map<folder, Set<filename>>) so an in-flight delete on
  // folder A doesn't suppress a same-named-file diff in folder B if the user
  // switches folders before the delete IPC settles. Without folder scoping,
  // stripping cur with the wrong folder's in-flight set would drop a
  // same-named entry from the new folder's cur side and entriesEquivalent
  // would falsely report "no change", leaving the listing stale until the
  // next event (PR #75 21st, thread A).
  const inFlightDeletesRef = useRef<Map<string, Set<string>>>(new Map());

  // commitFreshResult swaps loadResult to the watcher-supplied snapshot AND
  // drops any selected filenames that no longer exist on disk. The bulk
  // toolbar / "open many" actions otherwise hand stale paths to the viewer
  // (PR #75 review).
  const commitFreshResult = useCallback(
    (fresh: classification.LoadResult, fnames: ReadonlySet<string>) => {
      setLoadResult(fresh);
      setSelected((cur) => {
        if (cur.size === 0) return cur;
        let changed = false;
        const next = new Set<string>();
        for (const f of cur) {
          if (fnames.has(f)) next.add(f);
          else changed = true;
        }
        return changed ? next : cur;
      });
    },
    [],
  );

  useClassificationWatcher({
    folderPath,
    watchMode: opts.watchMode,
    folderRef,
    watchModeRef,
    requestGenRef,
    initialLoadInFlightRef,
    loadResultRef,
    inFlightDeletesRef,
    editingRef,
    conflictRef,
    mergePromptOpenRef,
    pendingResultRef,
    dispatchWatchIntentRef,
    setLoadResult,
    setError,
    setEditing,
    commitFreshResult,
    resetEntriesDependentState,
    toast,
  });

  useClassificationReplay({
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
  });

  const {
    openEdit,
    closeEdit,
    saveEdit,
    resolveConflictReload,
    resolveConflictForce,
    resolveConflictCancel,
  } = useClassificationEdit({
    conflict,
    loadResult,
    folderRef,
    requestGenRef,
    setLoadResult,
    setEditing,
    setConflict,
    reload,
    toast,
  });

  const { resolveMergeMerge, resolveMergeSkip, resolveMergeCancel } =
    useClassificationMerge({
      mergePrompt,
      folderRef,
      requestGenRef,
      setMergePrompt,
      loadInternal,
      toast,
    });

  // deleteOne: confirm → Trash → mirror into sidecar → patch in-memory entries.
  // Returns true iff the file was removed from disk (the caller, App.tsx,
  // uses this signal to also close any matching viewer tabs). False when
  // the user cancels confirm or the Trash IPC fails before any disk change.
  //
  // Sidecar save uses the standard mtime-conflict path: on CONFLICT we
  // reload the JSON (picking up any external edits to other entries) and
  // retry the delete once. If the retry also fails the file stays gone on
  // disk and a warn toast is surfaced — the user's intent (remove this
  // file) has been honored even if the sidecar bookkeeping drifted.
  const deleteOne = useCallback(
    async (filename: string): Promise<boolean> => {
      const cur = folderRef.current;
      if (!cur || !loadResult) return false;

      const proceed = await confirm(
        `${filename} をゴミ箱に送りますか?`,
      );
      if (!proceed) return false;

      // Mark the file as "we're deleting this" BEFORE DeleteImage so the
      // watcher Remove event (which can fire within a few ms of the IPC
      // round-trip — well before our subsequent SaveClassification +
      // setLoadResult patch lands) is recognised as a self-echo rather
      // than as an unexplained external removal that triggers a toast +
      // possible commit. Cleared in the finally below regardless of the
      // sidecar outcome (PR #75 9th, thread J). Keyed by the folder we
      // captured at entry (`cur`) so the cleanup deletes from the same
      // bucket even if folderRef has changed by then (PR #75 21st, thread A).
      let folderDeletes = inFlightDeletesRef.current.get(cur);
      if (!folderDeletes) {
        folderDeletes = new Set();
        inFlightDeletesRef.current.set(cur, folderDeletes);
      }
      folderDeletes.add(filename);
      try {
        try {
          await DeleteImage(cur, filename);
        } catch (e) {
          const msg = errorMessage(e);
          logger.error("classification", "delete failed", {
            filename,
            err: msg,
          });
          // Surface the failure toast only if the user is still looking
          // at this folder (PR #75 14th, thread C).
          if (folderRef.current === cur) {
            toast("削除に失敗しました (詳細はログ)", "error");
          }
          return false;
        }

        // File is gone on disk. From here we are best-effort on the sidecar.
        const removeFiltered = (entries: classification.Entry[]) =>
          entries.filter((e) => e.filename !== filename);

        let entriesAfter = removeFiltered(loadResult.entries);
        let nextMtime = loadResult.mtime;
        let sidecarErr: string | null = null;

        try {
          const out = await SaveClassification(
            cur,
            entriesAfter,
            loadResult.mtime,
          );
          nextMtime = out.mtime;
        } catch (e) {
          const msg = errorMessage(e);
          if (msg.startsWith(CONFLICT_PREFIX)) {
            // Pick up external edits then re-apply the delete with the
            // fresh mtime.
            const fresh = await loadInternal(cur);
            if (fresh) {
              entriesAfter = removeFiltered(fresh.entries);
              try {
                const out = await SaveClassification(
                  cur,
                  entriesAfter,
                  fresh.mtime,
                );
                nextMtime = out.mtime;
              } catch (e2) {
                sidecarErr = errorMessage(e2);
              }
            } else {
              // fresh === null can mean a real Load failure (in which
              // case loadInternal already toasted) OR that a newer
              // watcher payload / manual reload superseded us mid-await.
              // In the supersede case the local state already reflects
              // a fresher truth via the winner's commit, so patching
              // with our pre-supersede `entriesAfter` would roll it
              // back, and bumping the gen would stale-ify the newer
              // result we just merged into. Skip the local patch +
              // gen bump entirely — the file is already off disk, so
              // the next watcher event (or the winning Load) reconciles
              // the sidecar drift (PR #75 11th, suppressed-B).
              return true;
            }
          } else {
            sidecarErr = msg;
          }
        }

        // Folder check before any state commit — patching NEW folder's
        // loadResult with OLD folder's entriesAfter (which is missing the
        // deleted filename for the OLD folder) would erroneously remove a
        // same-named entry from the NEW folder's list (PR #75 14th,
        // thread C). File is already off disk for OLD folder; the user
        // sees no visible state change, which is correct for NEW folder
        // context.
        if (folderRef.current !== cur) return true;
        // Bump generation before patching local state so any in-flight
        // LoadClassification (watcher / replay / silent recheck / manual
        // reload) that started before our delete + sidecar save returned
        // is now stale and won't re-introduce the deleted entry via its
        // setLoadResult (PR #75 10th, thread A).
        ++requestGenRef.current;
        setLoadResult((prev) => {
          if (!prev) return prev;
          return classification.LoadResult.createFrom({
            ...prev,
            entries: entriesAfter,
            mtime: nextMtime,
          });
        });
        setSelected((curSel) => {
          if (!curSel.has(filename)) return curSel;
          const next = new Set(curSel);
          next.delete(filename);
          return next;
        });

        if (sidecarErr) {
          toast(
            `${filename} を削除しましたが、サイドカー更新に失敗しました (詳細はログ)`,
            "warn",
          );
          logger.warn("classification", "delete sidecar save failed", {
            filename,
            err: sidecarErr,
          });
        } else {
          toast(`${filename} をゴミ箱に送りました`, "info");
          logger.info("classification", "deleted", { filename });
        }
        return true;
      } finally {
        const set = inFlightDeletesRef.current.get(cur);
        if (set) {
          set.delete(filename);
          if (set.size === 0) inFlightDeletesRef.current.delete(cur);
        }
      }
    },
    [confirm, loadInternal, loadResult, toast],
  );

  const persistableState = useMemo(
    () => ({
      folderPath,
      filter: {
        tags: filter.tags,
        confidence: filter.confidence,
        query: filter.query,
      },
      collapsedGroups: groups.collapsedList,
    }),
    [folderPath, filter, groups.collapsedList],
  );

  // Stabilize the return so consumers (App.tsx, ClassificationView) see a
  // constant identity unless something inside actually changed.
  return useMemo(
    () => ({
      folderPath,
      loadResult,
      loading,
      error,
      filter,
      filteredEntries,
      editing,
      conflict,
      mergePrompt,
      collapsedGroups: groups.collapsedList,
      isCollapsed: groups.isCollapsed,
      toggleGroup: groups.toggle,
      expandAllGroups: groups.expandAll,
      collapseAllGroups: groups.collapseAll,
      selectedFilenames,
      isSelected,
      toggleSelected,
      extendSelectionTo,
      clearSelected,
      openFolder,
      reload,
      setFilter,
      toggleTag,
      clearTags,
      openEdit,
      closeEdit,
      saveEdit,
      resolveConflictReload,
      resolveConflictForce,
      resolveConflictCancel,
      resolveMergeMerge,
      resolveMergeSkip,
      resolveMergeCancel,
      deleteOne,
      persistableState,
    }),
    [
      folderPath,
      loadResult,
      loading,
      error,
      filter,
      filteredEntries,
      editing,
      conflict,
      mergePrompt,
      groups.collapsedList,
      groups.isCollapsed,
      groups.toggle,
      groups.expandAll,
      groups.collapseAll,
      selectedFilenames,
      isSelected,
      toggleSelected,
      extendSelectionTo,
      clearSelected,
      openFolder,
      reload,
      setFilter,
      toggleTag,
      clearTags,
      openEdit,
      closeEdit,
      saveEdit,
      resolveConflictReload,
      resolveConflictForce,
      resolveConflictCancel,
      resolveMergeMerge,
      resolveMergeSkip,
      resolveMergeCancel,
      deleteOne,
      persistableState,
    ],
  );
}

