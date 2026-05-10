import { useCallback, useEffect, useRef, useState } from "react";
import {
  CreateEmptyClassification,
  LoadClassification,
  MergeChildSidecars,
  OpenFolderDialog,
  PreviewChildSidecars,
  UpdateClassificationEntry,
} from "../../../wailsjs/go/main/App";
import { classification } from "../../../wailsjs/go/models";
import { state as wstate } from "../../../wailsjs/go/models";
import { useToastFn } from "../../shared/components/Toast";
import type { ConfirmFn } from "../viewer-grid/useViewerGrid";
import { applyFilter, type Confidence, type ListTabFilter } from "./filters";
import { useDirectoryGroups } from "./useDirectoryGroups";

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
  // Multi-select state. Selection is keyed by filename (POSIX-relative inside
  // the current folder) and is cleared automatically when folderPath changes.
  // It survives filter / collapse changes so the user can refine and then
  // open the survivors in bulk.
  selectedFilenames: string[];
  isSelected: (filename: string) => boolean;
  toggleSelected: (filename: string) => void;
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
  persistableState: {
    folderPath: string;
    filter: { tags: string[]; confidence: string; query: string };
    collapsedGroups: string[];
  };
};

type Opts = {
  initialList?: wstate.ListTabState | null;
  confirm: ConfirmFn;
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
  const groups = useDirectoryGroups(opts.initialList?.collapsedGroups ?? []);

  const toast = useToastFn();
  const { confirm } = opts;

  // Avoid stale closures in async ops by mirroring folderPath.
  const folderRef = useRef(folderPath);
  useEffect(() => {
    folderRef.current = folderPath;
  }, [folderPath]);

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
  useEffect(() => {
    if (!initFolderPath) return;
    let cancelled = false;
    (async () => {
      const res = await loadInternal(initFolderPath);
      if (cancelled || !res) return;
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
    // Folder change invalidates filename-keyed selection.
    setSelected(new Set());
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

  const filteredEntries = loadResult
    ? applyFilter(loadResult.entries, filter)
    : [];

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
  }, []);
  const clearSelected = useCallback(() => {
    setSelected((cur) => (cur.size === 0 ? cur : new Set()));
  }, []);
  const selectedFilenames = Array.from(selected).sort();

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
        } else {
          toast(`保存に失敗しました: ${msg}`, "error");
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
    } catch (e) {
      toast(`マージに失敗しました: ${errorMessage(e)}`, "error");
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

  const persistableState = {
    folderPath,
    filter: {
      tags: filter.tags,
      confidence: filter.confidence,
      query: filter.query,
    },
    collapsedGroups: groups.collapsedList,
  };

  return {
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
    selectedFilenames,
    isSelected,
    toggleSelected,
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
    persistableState,
  };
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

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}
