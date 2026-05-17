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

// classificationChangedEvent must match the Go-side constant in app.go.
// Single source: this string IS the event name and the Go constant just
// happens to spell it the same. If you rename one, rename both — there is
// no shared definition because the watcher namespace isn't auto-generated
// by wails generate module (the payload type never appears in a binding
// signature).
const CLASSIFICATION_CHANGED_EVENT = "classification:changed";

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
  // loading; we treat that as "auto" so the first folder open still gets a
  // watch (it will be torn down + restarted if the user explicitly set "off").
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
  // defer state (conflict or mergePrompt). The deferral-close effect below
  // commits it when the user finishes resolving.
  const pendingResultRef = useRef<classification.LoadResult | null>(null);

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
  // It reads decision-relevant state via refs so the listener can stay
  // bound for the full (folderPath, watchMode) lifetime; otherwise we'd
  // tear down + re-subscribe on every keystroke or selection change.
  const handleWatcherPayload = useCallback(
    async (payload: ChangedPayload) => {
      if (payload.folder !== folderRef.current) {
        // Stale residual from a watcher that hadn't been torn down yet, or
        // the user switched folders mid-flush. Drop quietly.
        return;
      }
      const summary = formatChangeSummary(payload);
      if (summary) toast(summary, "info");

      let fresh: classification.LoadResult | null = null;
      try {
        fresh = await LoadClassification(folderRef.current);
      } catch (e) {
        logger.warn("classification", "auto-merge load failed", {
          err: errorMessage(e),
        });
        return;
      }
      if (folderRef.current !== payload.folder) {
        // Folder switched while LoadClassification was in flight; discard
        // to avoid clobbering the new folder's state with the old one.
        return;
      }
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
          // Park the fresh result; deferral-close effect commits it.
          pendingResultRef.current = fresh;
          return;
        case "commit-editing-removed":
          toast(`${action.filename} は外部で削除されました`, "warn");
          setEditing({ open: false, filename: null });
          setLoadResult(fresh);
          return;
        case "commit":
          setLoadResult(fresh);
          return;
      }
    },
    [toast],
  );

  // Lifecycle: start/stop the Go-side watcher and bind the EventsOn listener.
  // Effect re-runs on folderPath (the watch target) or watchMode (the user
  // setting). watchMode === "off" suppresses Start without freezing the rest
  // of the hook — manual reload still works.
  useEffect(() => {
    if (!folderPath) return;
    if (watchMode === "off") return;

    let unsub: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      try {
        await StartFolderWatch(folderPath);
      } catch (e) {
        const msg = errorMessage(e);
        toast(
          "自動監視を開始できませんでした (再読み込みボタンで手動更新してください)",
          "warn",
        );
        logger.warn("watcher", "start failed", {
          folder: folderPath,
          err: msg,
        });
        return;
      }
      if (cancelled) {
        // Effect was torn down (folder switched / watchMode flipped) while
        // we were awaiting Start. Reverse the side effect.
        void StopFolderWatch();
        return;
      }
      unsub = EventsOn(
        CLASSIFICATION_CHANGED_EVENT,
        (payload: ChangedPayload) => {
          void handleWatcherPayload(payload);
        },
      );
    })();
    return () => {
      cancelled = true;
      if (unsub) {
        unsub();
        unsub = null;
      }
      void StopFolderWatch();
    };
  }, [folderPath, watchMode, handleWatcherPayload, toast]);

  // Deferral-close: when both conflict and mergePrompt are closed AND a
  // pending result has been parked, commit it (re-running the decision so
  // an editing-target-removed exception that arose while deferred still
  // fires the warn + close path).
  const wasInDeferRef = useRef(false);
  useEffect(() => {
    const inDefer = mergePrompt.open || conflict !== null;
    const wasInDefer = wasInDeferRef.current;
    wasInDeferRef.current = inDefer;
    if (!(wasInDefer && !inDefer)) return;
    const fresh = pendingResultRef.current;
    if (!fresh) return;
    pendingResultRef.current = null;
    const fnames = new Set(fresh.entries.map((e) => e.filename));
    const action = decideAutoMerge({
      editingOpen: editingRef.current.open,
      editingFilename: editingRef.current.filename,
      conflictOpen: false,
      mergePromptOpen: false,
      freshFilenames: fnames,
    });
    if (action.kind === "commit-editing-removed") {
      toast(`${action.filename} は外部で削除されました`, "warn");
      setEditing({ open: false, filename: null });
    }
    setLoadResult(fresh);
  }, [mergePrompt.open, conflict, toast]);

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
