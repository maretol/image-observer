import { useCallback, useMemo, useRef, useState } from "react";
import { classification } from "../../../wailsjs/go/models";
import { state as wstate } from "../../../wailsjs/go/models";
import { useToastFn } from "../../shared/components/Toast";
import type { ConfirmFn } from "../viewer-grid/useViewerSet";
import { type ListTabFilter } from "./filters";
import { useClassificationDelete } from "./useClassificationDelete";
import { useClassificationEdit } from "./useClassificationEdit";
import { useClassificationFilter } from "./useClassificationFilter";
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

// useClassification is the orchestrator for the list-tab feature. The hook
// declares shared state + refs at the top and then composes the following
// child hooks (each gets only the refs / setters it actually needs):
//
//   useClassificationFilter    — filter state + filteredEntries (independent)
//   useClassificationSelection — multi-select set + range anchor (independent)
//   useClassificationLoad      — load IPC wrapper + folder picker + reload
//   useClassificationWatcher   — fsnotify event handler + Start/Stop dispatch
//   useClassificationReplay    — defer-close → performReplay
//   useClassificationEdit      — save + conflict resolution
//   useClassificationMerge     — child-sidecar prompt resolution
//   useClassificationDelete    — trash one image + sidecar mirror
//
// Race correctness rests on the shared refs declared below — see AGENTS.md
// §H-8 and docs/spec-folder-watch.md §15 for the variable matrix. Every
// child hook either reads these refs through props (so the type signature
// surfaces the dependency) or — for setters / dispatch — calls through the
// orchestrator-owned setter. Do not collapse refs into child hooks: the
// generation token / folder check pattern relies on a single shared
// instance across all async paths.
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
  // opts.watchMode is consumed directly (watchModeRef sync + useClassificationWatcher
  // prop) — destructuring it into a local would just shadow opts without any reader.
  const { confirm } = opts;

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
  // (PR #75 13th, thread A). Wired into the three catch sites that null
  // loadResult: useClassificationLoad.loadInternal,
  // useClassificationWatcher.handleWatcherPayload,
  // useClassificationReplay.performReplay reload — all of which receive
  // this function as a prop.
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
  //   - useClassificationLoad.loadInternal (manual reload / openFolder /
  //     auto-load on mount / conflict-resolve / merge-resolve /
  //     delete-conflict-retry)
  //   - useClassificationWatcher.handleWatcherPayload (each watcher event)
  //   - useClassificationReplay.performReplay's reload branch
  //   - useClassificationEdit.saveEdit / resolveConflictForce, and
  //     useClassificationMerge / useClassificationDelete after their disk
  //     writes (so an in-flight Load that started pre-write is stale-
  //     discarded — preemptive sweep, PR #75 10th thread A).
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
  // user manually re-reads. The actual implementation is assigned inside
  // useClassificationWatcher every render — refs are not part of React's
  // render-immutable state model, so the function identity bound to
  // .current can be replaced each render without invalidating any
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

  // loadResultRef mirrors loadResult so the watcher handler can compare the
  // incoming re-Load to what we already display without depending on
  // loadResult directly (which would force a new handleWatcherPayload
  // identity each render and grow the dep churn). Synced render-time (not
  // via useEffect) because the handler reads it in its self-echo check —
  // if a watcher event lands between `setLoadResult(patch)` and the
  // post-render effect, the handler would compare against the PRE-patch
  // entries and falsely classify the watcher echo of our just-completed
  // save as an external change, surfacing "外部変更" toasts / unnecessary
  // commits for normal saves (PR #75 14th, thread B). Same reasoning as
  // folderRef / watchModeRef / editingRef / conflictRef /
  // mergePromptOpenRef above.
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

  const { deleteOne } = useClassificationDelete({
    loadResult,
    folderRef,
    requestGenRef,
    inFlightDeletesRef,
    setLoadResult,
    setSelected,
    loadInternal,
    confirm,
    toast,
  });

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

