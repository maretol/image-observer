import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CreateEmptyClassification,
  DeleteImage,
  LoadClassification,
  MergeChildSidecars,
  OpenFolderDialog,
  PreviewChildSidecars,
  SaveClassification,
  StartFolderWatch,
  StopFolderWatch,
  UpdateClassificationEntry,
} from "../../../wailsjs/go/main/App";
import { EventsOn } from "../../../wailsjs/runtime/runtime";
import { classification } from "../../../wailsjs/go/models";
import { state as wstate } from "../../../wailsjs/go/models";
import { useToastFn } from "../../shared/components/Toast";
import { errorMessage } from "../../shared/utils/error";
import { logger } from "../../shared/utils/logger";
import type { ConfirmFn } from "../viewer-grid/useViewerSet";
import { entriesEquivalent } from "./entriesEquivalent";
import { type ListTabFilter } from "./filters";
import { useClassificationFilter } from "./useClassificationFilter";
import { useDirectoryGroups } from "./useDirectoryGroups";
import {
  decideAutoMerge,
  formatChangeSummary,
  type ChangedPayload,
} from "./watcherPolicy";
import { WATCH_MODE_AUTO, WATCH_MODE_OFF } from "../settings/watchMode";

// CLASSIFICATION_CHANGED_EVENT mirrors the Go-side
// `watcher.ClassificationChangedEvent`. There is no auto-generated TS
// namespace for the watcher package (Wails only emits TS for types that
// appear in binding signatures, and EventsEmit payloads do not), so the
// string literal is duplicated. A vitest assertion in
// `watcherPolicy.test.ts` pins this constant to the same literal as the
// Go-side test (`internal/watcher.TestClassificationChangedEventName`);
// renaming one without the other trips CI (AGENTS.md D-1).
export const CLASSIFICATION_CHANGED_EVENT = "classification:changed";

const CONFLICT_PREFIX = "CONFLICT:";

export type EditingState = {
  open: boolean;
  filename: string | null;
};

export type ConflictPrompt = {
  filename: string;
  draft: classification.Entry;
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
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  // Anchor for Shift+click range selection. Set on every toggle (single or
  // ctrl); persists across shift-extends so the user can adjust the range.
  const [selectAnchor, setSelectAnchor] = useState<string | null>(null);
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
  const pendingResultRef = useRef<{
    fresh: classification.LoadResult;
    folder: string;
    capturedGen: number;
  } | null>(null);

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
    setSelected((cur) => (cur.size === 0 ? cur : new Set()));
    setSelectAnchor(null);
  }, []);

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

  const loadInternal = useCallback(
    async (
      path: string,
    ): Promise<classification.LoadResult | null> => {
      const myGen = ++requestGenRef.current;
      const myLoadToken = ++loadingTokenRef.current;
      initialLoadInFlightRef.current = true;
      setLoading(true);
      setError(null);
      try {
        const res = await LoadClassification(path);
        // Stale → return null so callers (openFolder / autoLoad) skip
        // postLoadFlow against a now-superseded folder. Returning the
        // success result let the caller's downstream side-effects fire
        // against the wrong folder (PR #75 review thread #1).
        if (myGen !== requestGenRef.current) return null;
        setLoadResult(res);
        return res;
      } catch (e) {
        if (myGen !== requestGenRef.current) return null;
        const msg = errorMessage(e);
        setError(msg);
        setLoadResult(null);
        // Clear entries-dependent state so a stranded editing popover /
        // conflict draft / mergePrompt / pending replay doesn't survive
        // the load failure (PR #75 13th, thread A).
        resetEntriesDependentState();
        toast(`読み込みに失敗しました: ${msg}`, "error");
        return null;
      } finally {
        // Clear the in-flight flag before the spinner release so any
        // silent recheck scheduled while we were awaiting can proceed
        // on the next microtask without seeing a stale flag.
        if (myLoadToken === loadingTokenRef.current) {
          initialLoadInFlightRef.current = false;
          setLoading(false);
        }
      }
    },
    [toast, resetEntriesDependentState],
  );

  // postLoadFlow runs after a successful Load when the parent has no sidecar.
  // It first looks for child sidecars to merge (one-time migration path) and
  // falls back to the "create empty sidecar?" confirm. Used by both the
  // explicit folder picker and the auto-load on mount, so a session-restored
  // folder also gets the merge prompt — without this, picking a folder once
  // and then restarting the app would silently bypass the migration.
  const postLoadFlow = useCallback(
    async (path: string, res: classification.LoadResult) => {
      if (res.hasSidecar) return;
      // Each await point below is a potential window for the user to
      // switch folders. Without these guards we'd surface the OLD
      // folder's merge prompt / "create sidecar?" confirm against the
      // NEW folder's UI (a real UX bug — the user sees a prompt they
      // never asked for) (PR #75 12th preemptive, postLoadFlow stale
      // check). The CreateEmptyClassification / loadInternal at the end
      // still run because they're disk-level operations the user
      // originally requested on `path` — only the user-facing surfacing
      // of state (setMergePrompt / confirm) needs the stale check.
      let preview: classification.MergePreview | null = null;
      try {
        preview = await PreviewChildSidecars(path);
      } catch {
        preview = null;
      }
      if (folderRef.current !== path) return;
      if (preview && preview.hasNonTrivial) {
        setMergePrompt({ open: true, preview, folderPath: path });
        return;
      }
      const create = await confirm(
        "サイドカー (_classification.json) がありません。\n新規作成しますか?",
      );
      if (folderRef.current !== path) return;
      if (!create) return;
      try {
        await CreateEmptyClassification(path);
      } catch (e) {
        if (folderRef.current === path) {
          toast(`サイドカー作成に失敗しました: ${errorMessage(e)}`, "error");
        }
        return;
      }
      // Folder check before the trailing reload: even though loadInternal
      // is gen-aware and would mark itself stale via the new openFolder's
      // bump, we still issued an IPC for the OLD folder. Skipping it when
      // state has moved on saves a wasted Load and prevents any race with
      // the gen-bump timing (PR #75 14th, thread C).
      if (folderRef.current !== path) return;
      await loadInternal(path);
    },
    [confirm, loadInternal, toast],
  );

  // Auto-load on mount if a folderPath was restored from session. Also runs
  // the same merge / create-empty decision tree so the user does not need to
  // re-pick the folder to see the migration prompt after an app restart.
  // The ref guards postLoadFlow (the user-facing prompt) at the side-effect
  // point so StrictMode's dev double-mount cannot queue confirm() twice.
  // Putting the guard at the effect entry instead would suppress *both* runs:
  // the first async would be killed by `cancelled` (set by the immediate
  // cleanup), and the second would early-return before starting any work.
  const autoLoadFlowedRef = useRef(false);
  useEffect(() => {
    if (!initFolderPath) return;
    let cancelled = false;
    (async () => {
      const res = await loadInternal(initFolderPath);
      if (cancelled || !res) return;
      if (autoLoadFlowedRef.current) return;
      autoLoadFlowedRef.current = true;
      await postLoadFlow(initFolderPath, res);
    })();
    return () => {
      cancelled = true;
    };
    // Intentionally run only on mount; `initFolderPath` is a constant captured
    // at hook construction.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openFolder = useCallback(async () => {
    let picked: string;
    try {
      picked = await OpenFolderDialog();
    } catch (e) {
      toast(`フォルダ選択に失敗しました: ${errorMessage(e)}`, "error");
      return;
    }
    if (!picked) return; // user cancelled
    // Sync folderRef synchronously before triggering the state update so
    // any in-flight watcher event for the OLD folder is rejected by the
    // handler's "payload.folder === folderRef.current" check, instead of
    // sneaking through during the gap between setFolderPath() and the
    // next render (PR #75 review).
    folderRef.current = picked;
    setFolderPath(picked);
    // Folder change invalidates ALL entries-dependent state, not just
    // selection — editing pointing at an OLD-folder file would re-surface
    // its popover if the NEW folder happens to contain a same-named file,
    // conflict / mergePrompt / pendingResultRef likewise carry stale
    // folder pointers (PR #75 14th, thread A). resetEntriesDependentState
    // covers selection + anchor + all of the above in one call.
    resetEntriesDependentState();
    const res = await loadInternal(picked);
    // loadInternal returns null on stale (a newer Load superseded us) as
    // well as on error. In both cases the postLoadFlow's merge / create-
    // empty prompts must not run against an already-superseded folder
    // (PR #75 review thread #1).
    if (!res) return;
    await postLoadFlow(picked, res);
  }, [loadInternal, postLoadFlow, toast, resetEntriesDependentState]);

  const reload = useCallback(async () => {
    const cur = folderRef.current;
    if (!cur) return;
    await loadInternal(cur);
    // Also kick the watcher reconciliation: if a previous root vanished
    // (the Go-side loop exited but Manager.state went zombie until the
    // next Start), the folder-watch effect won't re-fire on its own
    // because folderPath/watchMode didn't change. Dispatching here
    // bridges that gap so a user pressing "再読み込み" after recreating
    // the folder also restores auto-monitoring. Manager.Start's
    // goroutineExited zombie-detection then tears down the dead state
    // and builds a fresh watcher (PR #75 11th, thread B).
    dispatchWatchIntentRef.current();
  }, [loadInternal]);

  // Mirror anchor into a ref so extendSelectionTo's identity stays stable.
  // Declared above the callbacks that read it to avoid a TDZ-shaped pitfall.
  const selectAnchorRef = useRef<string | null>(selectAnchor);
  useEffect(() => {
    selectAnchorRef.current = selectAnchor;
  }, [selectAnchor]);

  // Selection actions. The displayed selection list is sorted DFS-style by
  // sticking close to the on-disk filename order (= POSIX relative path).
  const isSelected = useCallback(
    (filename: string) => selected.has(filename),
    [selected],
  );
  const toggleSelected = useCallback((filename: string) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(filename)) next.delete(filename);
      else next.add(filename);
      return next;
    });
    setSelectAnchor(filename);
  }, []);
  const extendSelectionTo = useCallback(
    (filename: string, displayedOrder: string[]) => {
      const anchor = selectAnchorRef.current;
      // No anchor / either endpoint missing → degrade to a plain toggle.
      const startIdx = anchor != null ? displayedOrder.indexOf(anchor) : -1;
      const endIdx = displayedOrder.indexOf(filename);
      if (startIdx < 0 || endIdx < 0) {
        setSelected((cur) => {
          const next = new Set(cur);
          if (next.has(filename)) next.delete(filename);
          else next.add(filename);
          return next;
        });
        setSelectAnchor(filename);
        return;
      }
      const [lo, hi] =
        startIdx <= endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
      const range = displayedOrder.slice(lo, hi + 1);
      setSelected((cur) => {
        const next = new Set(cur);
        for (const f of range) next.add(f);
        return next;
      });
      // Anchor stays put so the user can re-shift to a different end-point.
    },
    [],
  );
  const clearSelected = useCallback(() => {
    setSelected((cur) => (cur.size === 0 ? cur : new Set()));
    setSelectAnchor(null);
  }, []);
  const selectedFilenames = useMemo(
    () => Array.from(selected).sort(),
    [selected],
  );

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

  const handleWatcherPayload = useCallback(
    async (payload: ChangedPayload) => {
      if (watchModeRef.current === WATCH_MODE_OFF) {
        // The user disabled monitoring; StopFolderWatch() can't recall
        // events that were already dispatched into JS land. Drop them at
        // the handler boundary so a payload in flight at the moment of
        // off-switch doesn't auto-merge after the user opted out
        // (PR #75 review thread#3).
        return;
      }
      if (payload.folder !== folderRef.current) {
        // Stale residual from a watcher that hadn't been torn down yet, or
        // the user switched folders mid-flush. Drop quietly.
        return;
      }
      const myGen = ++requestGenRef.current;

      let fresh: classification.LoadResult | null = null;
      try {
        fresh = await LoadClassification(folderRef.current);
      } catch (e) {
        // Suppress this catch if the failure belongs to a stale request
        // (newer payload already in flight, or folder switched out from
        // under us). Without these guards a slow-failing older Load could
        // wipe a successfully-displayed newer result (PR #75 review).
        if (myGen !== requestGenRef.current) return;
        if (folderRef.current !== payload.folder) return;
        // Also re-check watchMode: the entry-gate above ran before the
        // await; if the user flipped to off while we were awaiting,
        // surfacing the failure (with toast / setError) would be acting
        // on monitoring the user opted out of (PR #75 8th, thread A).
        if (watchModeRef.current === WATCH_MODE_OFF) return;
        // Mirror the manual-reload error path so a deleted / unreadable
        // folder surfaces to the user instead of silently leaving a stale
        // grid. Also drop the on-screen result — leaving it in place
        // after a load failure invites the user to act on entries that
        // no longer exist on disk.
        const msg = errorMessage(e);
        setError(msg);
        setLoadResult(null);
        // Clear entries-dependent state alongside loadResult — same rule
        // as loadInternal's catch (PR #75 13th, thread A).
        resetEntriesDependentState();
        toast(`読み込みに失敗しました: ${msg}`, "error");
        logger.warn("classification", "auto-merge load failed", { err: msg });
        return;
      }
      // Discard the success result for the same reasons.
      if (myGen !== requestGenRef.current) return;
      if (folderRef.current !== payload.folder) return;
      // Same off-during-await guard as the catch above — the entry-gate
      // ran before LoadClassification. If watchMode flipped to off while
      // awaiting, committing the result would auto-merge after the user
      // opted out (PR #75 8th, thread A).
      if (watchModeRef.current === WATCH_MODE_OFF) return;
      // Successful Load (including silent self-echo paths) is a
      // confirmation that the folder is readable; clear any leftover
      // error from a previous failed reload so the UI doesn't keep
      // showing it after we've recovered (PR #75 review suppressed-c).
      setError(null);

      // Self-echo / no-op detection. Our own Save/Delete IPCs cause watcher
      // events too, and surfacing "外部で更新されました" for them is just
      // noise (PR #75 review thread #3, spec §5.4). When entries content
      // matches what we already display:
      //   - mtime also equal → fully silent (true no-op or self-echo)
      //   - mtime differs    → silent update so the user's next save still
      //     uses the freshest expectedMtime in the conflict check
      //
      // entriesEquivalent compares both sides AFTER filtering out
      // in-flight deletes — the local loadResult still has the entry the
      // user just asked us to delete (our setLoadResult patch happens
      // post-sidecar-save), while the fresh re-Load already lacks it. If
      // the only difference is one of those in-flight deletes, treat as
      // self-echo and skip the toast (PR #75 9th, thread J).
      const cur = loadResultRef.current;
      // Scope in-flight delete filenames to payload.folder so a stale
      // delete pending on a different folder can't suppress this folder's
      // diff (PR #75 21st, thread A). Asymmetric strip: only the stale-cur
      // side has the filename hidden, fresh is left untouched so an external
      // re-creation during the IPC window still surfaces as a diff (PR #75
      // 25th, thread D).
      const inFlightDeletes =
        inFlightDeletesRef.current.get(payload.folder) ?? null;
      const stripInFlight = (
        entries: classification.Entry[],
      ): classification.Entry[] =>
        !inFlightDeletes || inFlightDeletes.size === 0
          ? entries
          : entries.filter((e) => !inFlightDeletes.has(e.filename));
      const entriesUnchanged =
        cur != null &&
        entriesEquivalent(stripInFlight(cur.entries), fresh.entries);
      if (entriesUnchanged && cur != null && cur.mtime === fresh.mtime) {
        return;
      }
      if (entriesUnchanged) {
        setLoadResult(fresh);
        return;
      }

      // formatChangeSummary always returns a non-empty string (PR #75
      // review: counter-less anyChange payloads still warrant a generic
      // notification, see watcherPolicy.ts).
      toast(formatChangeSummary(payload), "info");

      const fnames = new Set(fresh.entries.map((e) => e.filename));
      const action = decideAutoMerge({
        editingOpen: editingRef.current.open,
        editingFilename: editingRef.current.filename,
        conflictOpen: conflictRef.current !== null,
        mergePromptOpen: mergePromptOpenRef.current,
        freshFilenames: fnames,
      });
      switch (action.kind) {
        case "defer":
          // Park the fresh result *with* its folder + current generation
          // so the deferral-close replay can discard it if the user
          // switched folders or another commit landed meanwhile
          // (PR #75 11th, suppressed-A).
          pendingResultRef.current = {
            fresh,
            folder: payload.folder,
            capturedGen: requestGenRef.current,
          };
          return;
        case "commit-editing-removed":
          toast(`${action.filename} は外部で削除されました`, "warn");
          setEditing({ open: false, filename: null });
          commitFreshResult(fresh, fnames);
          return;
        case "commit":
          commitFreshResult(fresh, fnames);
          return;
      }
    },
    [toast, commitFreshResult, resetEntriesDependentState],
  );

  // silentRecheckAfterStart bridges the gap between the initial / restore
  // LoadClassification and StartFolderWatch actually being live: files
  // dropped into the folder during that window aren't in the cached entries
  // nor the fsnotify stream. We re-Load (no loading flag flicker, no toast
  // on success / silent on diff) and route the result through the same
  // defer / mode / generation logic as a regular watcher payload so
  // editing-open et al. are still honored (PR #75 9th, thread I).
  const silentRecheckAfterStart = useCallback(
    (folder: string) => {
      // Defer while any loadInternal is awaiting. Without this we can
      // race the initial load (same generation since silent recheck only
      // snapshots, not bumps) — silent recheck commits its fresher
      // snapshot first, then the older initial-load result lands and
      // overwrites it (PR #75 12th, thread C). Waiting for the initial
      // load to complete guarantees our subsequent read is strictly
      // newer than its read (it happened-after), so even if we both
      // commit at the same gen, last-write-wins is correctness-preserving.
      // setTimeout yields to the event loop so the initial load's finally
      // (which clears the flag + commits its result) fires first.
      if (initialLoadInFlightRef.current) {
        setTimeout(() => silentRecheckAfterStart(folder), 50);
        return;
      }
      // Snapshot the current generation WITHOUT bumping (PR #75 11th,
      // thread A). Two requirements to satisfy at once:
      //   1) silent recheck must NOT supersede in-flight initial-load
      //      paths (openFolder / auto-load on mount). If we bumped, the
      //      ongoing `loadInternal` would see itself as stale and return
      //      null, and openFolder's `postLoadFlow` (sidecar-create
      //      prompt / child-sidecar merge prompt) would silently skip —
      //      a real regression triggered by the Round 10 suppressed-A
      //      fix that incorrectly bumped here.
      //   2) silent recheck must NOT roll back a newer commit that
      //      landed during our await. Snapshot + check at commit time
      //      handles this: if anything else bumps the gen while we wait,
      //      our myGen !== requestGenRef.current branches return.
      // Snapshot satisfies both.
      const myGen = requestGenRef.current;
      void LoadClassification(folder)
        .then((fresh) => {
          if (myGen !== requestGenRef.current) return;
          // Stale guards mirror handleWatcherPayload.
          if (folderRef.current !== folder) return;
          if (watchModeRef.current !== WATCH_MODE_AUTO) return;
          const cur = loadResultRef.current;
          // See handleWatcherPayload: per-folder set, so a delete still in
          // flight on a different folder can't suppress this one's diff
          // (PR #75 21st, thread A).
          // Asymmetric strip — only cur side is filtered, so an external
          // re-creation racing our delete IPC is still detected as a diff
          // (PR #75 25th, thread D; same reasoning as handleWatcherPayload).
          const inFlightDeletes =
            inFlightDeletesRef.current.get(folder) ?? null;
          const stripInFlight = (
            entries: classification.Entry[],
          ): classification.Entry[] =>
            !inFlightDeletes || inFlightDeletes.size === 0
              ? entries
              : entries.filter((e) => !inFlightDeletes.has(e.filename));
          const entriesUnchanged =
            cur != null &&
            entriesEquivalent(stripInFlight(cur.entries), fresh.entries);
          if (entriesUnchanged && cur != null && cur.mtime === fresh.mtime) {
            return;
          }
          // Reaching here means silent recheck observed a successful re-Load.
          // Clear any stale error from a prior failed initial / manual reload
          // — leaving it visible after recovery is the same UI artifact the
          // watcher handler / performReplay success paths already clear
          // (PR #75 16th, thread D).
          setError(null);
          if (entriesUnchanged) {
            setLoadResult(fresh);
            return;
          }
          // A genuine diff existed between initial Load and watcher Start.
          // No toast (silent — the user didn't ask, and it isn't strictly
          // an "external change" event), but go through decideAutoMerge so
          // an open editing popover / conflict / merge prompt parks the
          // result instead of being clobbered.
          const fnames = new Set(fresh.entries.map((e) => e.filename));
          const action = decideAutoMerge({
            editingOpen: editingRef.current.open,
            editingFilename: editingRef.current.filename,
            conflictOpen: conflictRef.current !== null,
            mergePromptOpen: mergePromptOpenRef.current,
            freshFilenames: fnames,
          });
          switch (action.kind) {
            case "defer":
              // Park with capturedGen so the replay can discard if another
              // commit lands (PR #75 11th, suppressed-A).
              pendingResultRef.current = {
                fresh,
                folder,
                capturedGen: requestGenRef.current,
              };
              return;
            case "commit-editing-removed":
              toast(`${action.filename} は外部で削除されました`, "warn");
              setEditing({ open: false, filename: null });
              commitFreshResult(fresh, fnames);
              return;
            case "commit":
              commitFreshResult(fresh, fnames);
              return;
          }
        })
        .catch((e) => {
          // Silent recheck stays silent on failure too — the user will
          // see the next manual reload's error if there's a real problem.
          if (myGen !== requestGenRef.current) return;
          logger.warn("watcher", "post-start silent recheck failed", {
            folder,
            err: errorMessage(e),
          });
        });
    },
    [toast, commitFreshResult, resetEntriesDependentState],
  );

  // Lifecycle is split into two effects to avoid a Start/Stop IPC race when
  // the user switches folders rapidly:
  //
  //   1. Folder-watch effect (Start-only on the live path): Go-side
  //      Manager.Start is itself re-entrant and tears down any previous
  //      watch atomically. By NOT calling StopFolderWatch from this
  //      effect's cleanup we keep the IPC sequence as Start("A") →
  //      Start("B"), which Go serializes via mu. A mixed Stop+Start
  //      sequence could re-order across Go goroutines and leave the wrong
  //      watch running. The only explicit Stop here is when watchMode
  //      flips to "off" or folderPath clears — both legitimate user-driven
  //      transitions, not effect-cleanup-driven.
  //   2. Event-subscription effect: stays mounted for the hook's lifetime,
  //      reads the freshest handler through a ref so it never has to
  //      re-subscribe on state changes. The cleanup only `unsub()`s the
  //      listener — it deliberately does NOT call StopFolderWatch because
  //      React.StrictMode's dev double-mount runs cleanup → re-setup, and
  //      a Stop fired here could land in Go after the next mount's Start.
  //      The final teardown on real app shutdown is handled by main.go's
  //      OnShutdown → app.shutdown → Manager.Stop instead.
  // dispatchWatchIntent is the single entry point for any Start/Stop IPC.
  // Wails dispatches each Bind call into its own Go goroutine, so JS-side
  // call ordering is NOT preserved at Go's mu lock — Start("A") → Start("B")
  // from JS can land as Start("B") then Start("A"), leaving Go watching the
  // wrong folder. To recover from any such reordering we re-evaluate the
  // current intent (refs are synced render-time) after EVERY IPC completion
  // and re-dispatch if it diverges. This converges to the latest intent
  // regardless of arrival order:
  //   - Start on same root + live goroutine: Go-side Manager.Start
  //     short-circuits to no-op (no walk).
  //   - Stop: idempotent.
  // so re-dispatching is always safe — at worst a duplicate IPC.
  //
  // Past variants this resolves (one per round, PR #75):
  //   - Round 7 thread C: Start success-side stale check
  //   - Round 10 suppressed-B: Start failure left Go without any watch
  //     because Manager.Start tears down old root BEFORE Add'ing new
  //   - Round 10 suppressed-C: mode-switch Stop completing after a
  //     later Start arrived stopped the wrong watcher
  //   - Round 10 suppressed-D: stale-start correction Stop completing
  //     out of order with same effect
  const dispatchWatchIntentRef = useRef<() => void>(() => {});
  dispatchWatchIntentRef.current = () => {
    const folder = folderRef.current;
    const mode = watchModeRef.current;
    if (mode == null) {
      // Settings haven't arrived yet; do nothing. Starting now would
      // briefly run a watcher for a user who has explicitly persisted
      // watchMode = "off". The effect re-fires once watchMode hydrates.
      return;
    }
    if (!folder || mode === WATCH_MODE_OFF) {
      // Drop any parked auto-merge result first — replaying it after
      // off-switch would surprise a user who opted out (suppressed-g).
      pendingResultRef.current = null;
      void StopFolderWatch()
        .then(() => {
          // After Stop completes, intent may have moved back to auto /
          // a folder. Re-check and re-dispatch so the latest intent is
          // honored even if this Stop landed at Go after a later Start
          // (PR #75 10th, suppressed-C / -D).
          if (
            folderRef.current &&
            watchModeRef.current === WATCH_MODE_AUTO
          ) {
            dispatchWatchIntentRef.current();
          }
        })
        .catch((e) => {
          // Swallow into the log so an unhandled rejection doesn't
          // bubble up (PR #75 review suppressed-f).
          logger.warn("watcher", "stop failed", { err: errorMessage(e) });
          // Same intent-reconcile pass on error.
          if (
            folderRef.current &&
            watchModeRef.current === WATCH_MODE_AUTO
          ) {
            dispatchWatchIntentRef.current();
          }
        });
      return;
    }
    // mode === auto && folder !== ""
    void StartFolderWatch(folder)
      .then(() => {
        const curFolder = folderRef.current;
        const curMode = watchModeRef.current;
        if (curMode === WATCH_MODE_AUTO && curFolder === folder) {
          // Intent matches what we just told Go. Bridge the initial
          // LoadClassification ↔ watch-live gap with a silent recheck
          // (PR #75 9th, thread I).
          silentRecheckAfterStart(folder);
          return;
        }
        // Intent moved while we were awaiting. Reconcile by re-dispatching.
        dispatchWatchIntentRef.current();
      })
      .catch((e) => {
        const curFolder = folderRef.current;
        const curMode = watchModeRef.current;
        if (curFolder === folder && curMode === WATCH_MODE_AUTO) {
          // Current intent matches the one we just failed to start —
          // surface the failure to the user.
          const msg = errorMessage(e);
          toast(
            "自動監視を開始できませんでした (再読み込みボタンで手動更新してください)",
            "warn",
          );
          logger.warn("watcher", "start failed", { folder, err: msg });
          return;
        }
        // Intent moved AND our Start failed. Manager.Start tears down
        // any prior watch BEFORE Add'ing the new root, so a stale failure
        // means Go currently has no watch at all — we must re-dispatch
        // to (re-)establish the latest intent (PR #75 10th, suppressed-B).
        dispatchWatchIntentRef.current();
      });
  };

  useEffect(() => {
    dispatchWatchIntentRef.current();
    // folderPath / watchMode are dependencies but the body reads from refs
    // (which are render-time synced) to keep the dispatcher itself
    // closure-free. toast / silentRecheckAfterStart are stable useCallbacks
    // so omitting them from deps is intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderPath, watchMode]);

  // Keep a ref to the latest handler so the EventsOn subscription below can
  // bind once and never need to re-bind on state-derived identity changes.
  const handlerRef = useRef(handleWatcherPayload);
  useEffect(() => {
    handlerRef.current = handleWatcherPayload;
  }, [handleWatcherPayload]);

  useEffect(() => {
    const unsub = EventsOn(
      CLASSIFICATION_CHANGED_EVENT,
      (payload: ChangedPayload) => {
        void handlerRef.current(payload);
      },
    );
    return () => {
      unsub();
      // No explicit StopFolderWatch here. React.StrictMode runs cleanup
      // → re-setup on the dev double-mount; queuing a Stop here would
      // race with the next mount's StartFolderWatch and could land in
      // Go *after* the new Start, leaving dev silently unmonitored
      // (PR #75 review). For real app shutdown the watcher is torn down
      // by main.go's OnShutdown calling app.shutdown → Manager.Stop,
      // so the Go goroutine doesn't leak either way.
    };
  }, []);

  // performReplay handles the parked-payload commit for *any* defer-source
  // closing (conflict, mergePrompt, or editing). It centralises four
  // corner cases that the per-effect implementations kept getting subtly
  // wrong as more cases piled up:
  //   1) folder switched while deferred → drop pending
  //   2) mtime advanced (user saved while deferred → pending.fresh is
  //      pre-save) → re-Load instead of committing the stale snapshot,
  //      otherwise the user's edit gets visually rolled back (PR #75
  //      review)
  //   3) re-running decideAutoMerge so editing-target-removed exception
  //      still fires if it arose while deferring
  //   4) re-parking when one defer source closed but another is still
  //      open (e.g. conflict resolved → editing still open with target)
  //
  // The replay reload (case 2) bumps requestGenRef so that any in-flight
  // watcher-handler Load whose result returns *after* this reload's
  // commit is discarded as stale (out-of-order ordering between the
  // event-driven path and the replay-driven path). The reload also
  // honours its own generation in its catch / success guards.
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
  }, [toast, commitFreshResult, resetEntriesDependentState]);

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

  const openEdit = useCallback((filename: string) => {
    setEditing({ open: true, filename });
  }, []);
  const closeEdit = useCallback(() => {
    setEditing({ open: false, filename: null });
  }, []);

  const saveEdit = useCallback(
    async (entry: classification.Entry) => {
      const cur = folderRef.current;
      if (!cur || !loadResult) return;
      try {
        const out = await UpdateClassificationEntry(
          cur,
          entry,
          loadResult.mtime,
        );
        // Folder check before any state commit — the UpdateEntry disk
        // write itself is fine to complete against `cur`, but patching
        // the NEW folder's loadResult with OLD folder's mtime / entry
        // would corrupt it. If the user switched folders mid-await we
        // skip the local commit entirely; the OLD folder's save did
        // succeed on disk, and any next openFolder of it will Load the
        // updated entry via the normal path (PR #75 14th, thread C).
        if (folderRef.current !== cur) return;
        // Bump the shared generation BEFORE patching local state so any
        // watcher / replay / silent-recheck / manual reload whose
        // LoadClassification started before our save returned is now
        // marked stale and its setLoadResult is skipped. Without this a
        // pre-save Load returning out-of-order would visually undo the
        // user's edit (PR #75 10th, thread A).
        ++requestGenRef.current;
        // Patch the loadResult locally so the grid updates without a full reload.
        setLoadResult((prev) => {
          if (!prev) return prev;
          let replaced = false;
          const newEntries = prev.entries.map((e) => {
            if (e.filename === entry.filename) {
              replaced = true;
              return entry;
            }
            return e;
          });
          if (!replaced) newEntries.push(entry);
          // Keep the LoadResult prototype so its methods remain available.
          const updated = classification.LoadResult.createFrom({
            ...prev,
            entries: newEntries,
            mtime: out.mtime,
          });
          return updated;
        });
        setEditing({ open: false, filename: null });
      } catch (e) {
        // Same folder check as the success path — surfacing a conflict
        // dialog or error toast for the OLD folder while the user is
        // on a NEW folder is confusing UX (PR #75 14th, thread C).
        if (folderRef.current !== cur) return;
        const msg = errorMessage(e);
        if (msg.startsWith(CONFLICT_PREFIX)) {
          setConflict({ filename: entry.filename, draft: entry });
          logger.warn("classification", "save conflict", {
            filename: entry.filename,
          });
        } else {
          toast(`保存に失敗しました: ${msg}`, "error");
          logger.error("classification", "save failed", {
            filename: entry.filename,
            err: msg,
          });
        }
      }
    },
    [loadResult, toast],
  );

  const resolveConflictReload = useCallback(async () => {
    setConflict(null);
    setEditing({ open: false, filename: null });
    await reload();
  }, [reload]);

  const resolveConflictForce = useCallback(async () => {
    if (!conflict) return;
    const cur = folderRef.current;
    if (!cur) return;
    try {
      const out = await UpdateClassificationEntry(cur, conflict.draft, 0);
      // Folder check before any state commit — patching the NEW folder's
      // state with OLD folder's mutation result is the same UX bug as
      // saveEdit (PR #75 14th, thread C).
      if (folderRef.current !== cur) return;
      // Bump gen immediately after the disk write so any in-flight
      // watcher / replay / silent recheck Load whose LoadClassification
      // started before our forced overwrite is now stale — without this
      // there's a small flicker window between UpdateClassificationEntry
      // returning and reload() bumping where a pre-write Load could
      // briefly commit pre-overwrite state (same rule as saveEdit /
      // deleteOne, PR #75 10th thread A pattern; preemptive sweep for
      // the remaining mutation IPC sites).
      ++requestGenRef.current;
      setConflict(null);
      setEditing({ open: false, filename: null });
      // Refresh with the truth on disk so we pick up any other external changes.
      await reload();
      // out.mtime is captured by reload, so we don't need to do anything else here.
      void out;
    } catch (e) {
      if (folderRef.current !== cur) return;
      toast(`強制上書きに失敗しました: ${errorMessage(e)}`, "error");
    }
  }, [conflict, reload, toast]);

  const resolveConflictCancel = useCallback(() => {
    setConflict(null);
    // Editing popover stays open so the user can copy their draft if needed.
  }, []);

  const resolveMergeMerge = useCallback(async () => {
    const target = mergePrompt.folderPath;
    if (!target) return;
    setMergePrompt({ open: false, preview: null, folderPath: "" });
    try {
      await MergeChildSidecars(target);
      logger.info("classification", "merged child sidecars", { folder: target });
    } catch (e) {
      if (folderRef.current !== target) return;
      const msg = errorMessage(e);
      toast(`マージに失敗しました: ${msg}`, "error");
      logger.error("classification", "merge failed", { folder: target, err: msg });
      return;
    }
    // Folder check before bumping gen + dispatching the reload — without
    // this the OLD folder's reload would bump generation (stale-ifying
    // the NEW folder's in-flight Load) and then commit OLD folder data
    // to NEW folder state (PR #75 14th, thread C).
    if (folderRef.current !== target) return;
    // Bump gen after the merge write so an in-flight watcher / silent
    // recheck Load that started before the merge is stale-discarded —
    // same flicker-prevention rule as saveEdit / deleteOne (PR #75 10th
    // thread A pattern; preemptive sweep).
    ++requestGenRef.current;
    await loadInternal(target);
  }, [mergePrompt, loadInternal, toast]);

  const resolveMergeSkip = useCallback(async () => {
    const target = mergePrompt.folderPath;
    if (!target) return;
    setMergePrompt({ open: false, preview: null, folderPath: "" });
    try {
      await CreateEmptyClassification(target);
    } catch (e) {
      if (folderRef.current !== target) return;
      toast(`サイドカー作成に失敗しました: ${errorMessage(e)}`, "error");
      return;
    }
    if (folderRef.current !== target) return;
    // Same gen-bump rule as resolveMergeMerge above.
    ++requestGenRef.current;
    await loadInternal(target);
  }, [mergePrompt, loadInternal, toast]);

  const resolveMergeCancel = useCallback(() => {
    setMergePrompt({ open: false, preview: null, folderPath: "" });
    // Folder selection persists; the user can hit "再読み込み" or pick again.
  }, []);

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

