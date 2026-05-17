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
import { applyFilter, type Confidence, type ListTabFilter } from "./filters";
import { useDirectoryGroups } from "./useDirectoryGroups";
import {
  decideAutoMerge,
  formatChangeSummary,
  type ChangedPayload,
} from "./watcherPolicy";

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
  // settings.watchMode: "auto" | "off". Undefined while settings are still
  // loading; the watch effect intentionally waits in that state — Start
  // would briefly run a watcher for users who have persisted watchMode =
  // "off", and Stop would race with a settings-load that immediately wants
  // a Start. The effect kicks in once settings hydrate.
  watchMode?: string;
};

export function useClassification(opts: Opts): UseClassificationReturn {
  const initFolderPath = opts.initialList?.folderPath ?? "";
  const initFilter: ListTabFilter = {
    tags: opts.initialList?.filter?.tags ?? [],
    confidence: normalizeConfidence(
      opts.initialList?.filter?.confidence ?? "all",
    ),
    query: opts.initialList?.filter?.query ?? "",
  };

  const [folderPath, setFolderPath] = useState<string>(initFolderPath);
  const [loadResult, setLoadResult] =
    useState<classification.LoadResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilterState] = useState<ListTabFilter>(initFilter);
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

  // Avoid stale closures in async ops by mirroring folderPath.
  const folderRef = useRef(folderPath);
  useEffect(() => {
    folderRef.current = folderPath;
  }, [folderPath]);

  // Refs that the watcher event handler reads. Mirrored from state so the
  // single EventsOn callback (registered once per folder/watchMode change)
  // always sees the latest decision-relevant values without needing a fresh
  // closure on every state change.
  const editingRef = useRef<EditingState>(editing);
  useEffect(() => {
    editingRef.current = editing;
  }, [editing]);
  const conflictRef = useRef<ConflictPrompt | null>(conflict);
  useEffect(() => {
    conflictRef.current = conflict;
  }, [conflict]);
  const mergePromptOpenRef = useRef(mergePrompt.open);
  useEffect(() => {
    mergePromptOpenRef.current = mergePrompt.open;
  }, [mergePrompt.open]);

  // pendingResultRef parks a LoadClassification result that arrived during a
  // defer state (conflict, mergePrompt, or editing-open with target intact).
  // The deferral-close effects below commit it when the user finishes
  // resolving. `folder` is captured at park time so a folder-switch while
  // deferred causes the replay to discard the now-stale result instead of
  // splatting the wrong folder's entries onto the new one (PR #75 review).
  const pendingResultRef = useRef<{
    fresh: classification.LoadResult;
    folder: string;
  } | null>(null);

  const loadInternal = useCallback(
    async (path: string) => {
      setLoading(true);
      setError(null);
      try {
        const res = await LoadClassification(path);
        setLoadResult(res);
        return res;
      } catch (e) {
        const msg = errorMessage(e);
        setError(msg);
        setLoadResult(null);
        toast(`読み込みに失敗しました: ${msg}`, "error");
        return null;
      } finally {
        setLoading(false);
      }
    },
    [toast],
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
      let preview: classification.MergePreview | null = null;
      try {
        preview = await PreviewChildSidecars(path);
      } catch {
        preview = null;
      }
      if (preview && preview.hasNonTrivial) {
        setMergePrompt({ open: true, preview, folderPath: path });
        return;
      }
      const create = await confirm(
        "サイドカー (_classification.json) がありません。\n新規作成しますか?",
      );
      if (!create) return;
      try {
        await CreateEmptyClassification(path);
      } catch (e) {
        toast(`サイドカー作成に失敗しました: ${errorMessage(e)}`, "error");
        return;
      }
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
    setFolderPath(picked);
    // Folder change invalidates filename-keyed selection (and its anchor).
    setSelected(new Set());
    setSelectAnchor(null);
    const res = await loadInternal(picked);
    if (!res) return;
    await postLoadFlow(picked, res);
  }, [loadInternal, postLoadFlow, toast]);

  const reload = useCallback(async () => {
    const cur = folderRef.current;
    if (!cur) return;
    await loadInternal(cur);
  }, [loadInternal]);

  const setFilter = useCallback((patch: Partial<ListTabFilter>) => {
    setFilterState((cur) => ({ ...cur, ...patch }));
  }, []);

  const toggleTag = useCallback((tag: string) => {
    setFilterState((cur) => {
      const has = cur.tags.includes(tag);
      return {
        ...cur,
        tags: has ? cur.tags.filter((t) => t !== tag) : [...cur.tags, tag],
      };
    });
  }, []);

  const clearTags = useCallback(() => {
    setFilterState((cur) => ({ ...cur, tags: [] }));
  }, []);

  const filteredEntries = useMemo(
    () => (loadResult ? applyFilter(loadResult.entries, filter) : []),
    [loadResult, filter],
  );

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
  // render and grow the dep churn).
  const loadResultRef = useRef<classification.LoadResult | null>(loadResult);
  useEffect(() => {
    loadResultRef.current = loadResult;
  }, [loadResult]);

  // requestGenRef bumps on every payload arrival. Each handler invocation
  // captures its own generation and checks `current === mine` at every
  // commit point. Because the listener fires `void handlerRef.current(...)`
  // without awaiting, two debounce flushes arriving close together would
  // otherwise overlap their LoadClassification round-trips and the slower
  // (older) result could land *after* the faster (newer) one, rewinding
  // the displayed entries to a stale snapshot (PR #75 review).
  const requestGenRef = useRef(0);

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
        // Mirror the manual-reload error path so a deleted / unreadable
        // folder surfaces to the user instead of silently leaving a stale
        // grid (PR #75 review). Also drop the on-screen result — leaving
        // it in place after a load failure invites the user to act on
        // entries that no longer exist on disk.
        const msg = errorMessage(e);
        setError(msg);
        setLoadResult(null);
        toast(`読み込みに失敗しました: ${msg}`, "error");
        logger.warn("classification", "auto-merge load failed", { err: msg });
        return;
      }
      // Discard the result if a newer payload has already started its own
      // round-trip (out-of-order Load completion) or if the folder switched
      // while we were awaiting Load.
      if (myGen !== requestGenRef.current) return;
      if (folderRef.current !== payload.folder) return;

      // Self-echo / no-op detection. Our own Save/Delete IPCs cause watcher
      // events too, and surfacing "外部で更新されました" for them is just
      // noise (PR #75 review thread #3, spec §5.4). When entries content
      // matches what we already display:
      //   - mtime also equal → fully silent (true no-op or self-echo)
      //   - mtime differs    → silent update so the user's next save still
      //     uses the freshest expectedMtime in the conflict check
      const cur = loadResultRef.current;
      const entriesUnchanged =
        cur != null && entriesEquivalent(cur.entries, fresh.entries);
      if (entriesUnchanged && cur != null && cur.mtime === fresh.mtime) {
        return;
      }
      if (entriesUnchanged) {
        setLoadResult(fresh);
        return;
      }

      const summary = formatChangeSummary(payload);
      if (summary) toast(summary, "info");

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
          // Park the fresh result *with* its folder so the deferral-close
          // replay can discard it if the user switched folders meanwhile.
          pendingResultRef.current = { fresh, folder: payload.folder };
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
    [toast, commitFreshResult],
  );

  // Lifecycle is split into two effects to avoid a Start/Stop IPC race when
  // the user switches folders rapidly:
  //
  //   1. Folder-watch effect (Start-only): Go-side Manager.Start is itself
  //      re-entrant and tears down any previous watch atomically. By NOT
  //      calling StopFolderWatch from this effect's cleanup we keep the IPC
  //      sequence as Start("A") → Start("B"), which Go serializes via mu.
  //      A mixed Stop+Start sequence could re-order across Go goroutines
  //      and leave the wrong watch running.
  //   2. Event-subscription effect: stays mounted for the hook's lifetime,
  //      reads the freshest handler through a ref so it never has to
  //      re-subscribe on state changes. Unmount cleanup also issues a final
  //      StopFolderWatch — the only place we explicitly stop while the hook
  //      is alive is when watchMode flips to "off" or folderPath clears
  //      (handled in effect 1's early-return branch).
  useEffect(() => {
    if (watchMode == null) {
      // Settings haven't arrived yet; do nothing. Starting now would briefly
      // run a watcher for a user who has explicitly persisted watchMode = "off"
      // (their preference loads a few hundred ms after mount, see App.tsx →
      // useSettings). Stopping now would race with a settings-load that may
      // immediately want a Start (PR #75 review).
      return;
    }
    if (!folderPath || watchMode === "off") {
      // Either no folder to watch or the user disabled monitoring; Stop is
      // a no-op when nothing is running.
      void StopFolderWatch();
      return;
    }
    void StartFolderWatch(folderPath).catch((e) => {
      const msg = errorMessage(e);
      toast(
        "自動監視を開始できませんでした (再読み込みボタンで手動更新してください)",
        "warn",
      );
      logger.warn("watcher", "start failed", {
        folder: folderPath,
        err: msg,
      });
    });
  }, [folderPath, watchMode, toast]);

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
      // Hook is going away — make sure no detached goroutine survives in Go.
      void StopFolderWatch();
    };
  }, []);

  // Deferral-close: when both conflict and mergePrompt are closed AND a
  // pending result has been parked, commit it (re-running the decision so
  // the editing-target-removed exception still fires if it arose while we
  // were deferring; if editing is still open with target present we keep
  // deferring — saved by the *next* close trigger).
  const wasInDeferRef = useRef(false);
  useEffect(() => {
    const inDefer = mergePrompt.open || conflict !== null;
    const wasInDefer = wasInDeferRef.current;
    wasInDeferRef.current = inDefer;
    if (!(wasInDefer && !inDefer)) return;
    const pending = pendingResultRef.current;
    if (!pending) return;
    if (pending.folder !== folderRef.current) {
      // Folder switched while parked; the stored result is for the wrong
      // tab. Drop it; a fresh watcher event for the current folder will
      // arrive on its own (PR #75 review).
      pendingResultRef.current = null;
      return;
    }
    const { fresh } = pending;
    const fnames = new Set(fresh.entries.map((e) => e.filename));
    const action = decideAutoMerge({
      editingOpen: editingRef.current.open,
      editingFilename: editingRef.current.filename,
      conflictOpen: false,
      mergePromptOpen: false,
      freshFilenames: fnames,
    });
    if (action.kind === "defer") {
      // editing is still open with target present → keep the result parked
      // until editing closes (closeEdit's effect below picks it up).
      return;
    }
    pendingResultRef.current = null;
    if (action.kind === "commit-editing-removed") {
      toast(`${action.filename} は外部で削除されました`, "warn");
      setEditing({ open: false, filename: null });
    }
    commitFreshResult(fresh, fnames);
  }, [mergePrompt.open, conflict, toast, commitFreshResult]);

  // Editing-close replay: editing.open transitioning true → false matters
  // when there's a parked payload waiting for the popover to close.
  const wasEditingOpenRef = useRef(editing.open);
  useEffect(() => {
    const wasOpen = wasEditingOpenRef.current;
    wasEditingOpenRef.current = editing.open;
    if (!(wasOpen && !editing.open)) return;
    // editing just closed; don't replay if conflict/merge still hold the
    // defer (they'll trigger their own replay when they close).
    if (mergePromptOpenRef.current || conflictRef.current !== null) return;
    const pending = pendingResultRef.current;
    if (!pending) return;
    if (pending.folder !== folderRef.current) {
      pendingResultRef.current = null;
      return;
    }
    pendingResultRef.current = null;
    const { fresh } = pending;
    const fnames = new Set(fresh.entries.map((e) => e.filename));
    commitFreshResult(fresh, fnames);
  }, [editing.open, commitFreshResult]);

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
      setConflict(null);
      setEditing({ open: false, filename: null });
      // Refresh with the truth on disk so we pick up any other external changes.
      await reload();
      // out.mtime is captured by reload, so we don't need to do anything else here.
      void out;
    } catch (e) {
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
      const msg = errorMessage(e);
      toast(`マージに失敗しました: ${msg}`, "error");
      logger.error("classification", "merge failed", { folder: target, err: msg });
      return;
    }
    await loadInternal(target);
  }, [mergePrompt, loadInternal, toast]);

  const resolveMergeSkip = useCallback(async () => {
    const target = mergePrompt.folderPath;
    if (!target) return;
    setMergePrompt({ open: false, preview: null, folderPath: "" });
    try {
      await CreateEmptyClassification(target);
    } catch (e) {
      toast(`サイドカー作成に失敗しました: ${errorMessage(e)}`, "error");
      return;
    }
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

      try {
        await DeleteImage(cur, filename);
      } catch (e) {
        const msg = errorMessage(e);
        toast("削除に失敗しました (詳細はログ)", "error");
        logger.error("classification", "delete failed", { filename, err: msg });
        return false;
      }

      // File is gone on disk. From here we are best-effort on the sidecar.
      const removeFiltered = (entries: classification.Entry[]) =>
        entries.filter((e) => e.filename !== filename);

      let entriesAfter = removeFiltered(loadResult.entries);
      let nextMtime = loadResult.mtime;
      let sidecarErr: string | null = null;

      try {
        const out = await SaveClassification(cur, entriesAfter, loadResult.mtime);
        nextMtime = out.mtime;
      } catch (e) {
        const msg = errorMessage(e);
        if (msg.startsWith(CONFLICT_PREFIX)) {
          // Pick up external edits then re-apply the delete with the fresh mtime.
          const fresh = await loadInternal(cur);
          if (fresh) {
            entriesAfter = removeFiltered(fresh.entries);
            try {
              const out = await SaveClassification(cur, entriesAfter, fresh.mtime);
              nextMtime = out.mtime;
            } catch (e2) {
              sidecarErr = errorMessage(e2);
            }
          } else {
            sidecarErr = "reload failed";
          }
        } else {
          sidecarErr = msg;
        }
      }

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

function normalizeConfidence(c: string): Confidence | "all" {
  switch (c) {
    case "high":
    case "mid":
    case "low":
    case "":
      return c as Confidence;
    case "all":
    default:
      return "all";
  }
}

// entriesEquivalent: order-sensitive shallow compare of every Entry field
// the user cares about. Used by the watcher auto-merge handler to detect
// "the fresh re-Load matches what we already display" so we don't spam the
// user with toast notifications for our own Save/Delete echoes
// (PR #75 review thread #3). Service.Load returns entries in a stable
// (sidecar-order then alphabetical) sequence so ordered comparison is safe.
function entriesEquivalent(
  a: classification.Entry[],
  b: classification.Entry[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.filename !== y.filename ||
      x.folder !== y.folder ||
      x.confidence !== y.confidence ||
      x.note !== y.note
    ) {
      return false;
    }
  }
  return true;
}
