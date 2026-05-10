import { useCallback, useEffect, useRef, useState } from "react";
import {
  CreateEmptyClassification,
  LoadClassification,
  OpenFolderDialog,
  UpdateClassificationEntry,
} from "../../../wailsjs/go/main/App";
import { classification } from "../../../wailsjs/go/models";
import { state as wstate } from "../../../wailsjs/go/models";
import { useToastFn } from "../../shared/components/Toast";
import type { ConfirmFn } from "../viewer-grid/useViewerGrid";
import { applyFilter, type Confidence, type ListTabFilter } from "./filters";

const CONFLICT_PREFIX = "CONFLICT:";

export type LightboxState = {
  open: boolean;
  filename: string | null;
};

export type EditingState = {
  open: boolean;
  filename: string | null;
};

export type ConflictPrompt = {
  filename: string;
  draft: classification.Entry;
};

export type UseClassificationReturn = {
  folderPath: string;
  loadResult: classification.LoadResult | null;
  loading: boolean;
  error: string | null;
  filter: ListTabFilter;
  filteredEntries: classification.Entry[];
  lightbox: LightboxState;
  editing: EditingState;
  conflict: ConflictPrompt | null;
  openFolder: () => Promise<void>;
  reload: () => Promise<void>;
  setFilter: (patch: Partial<ListTabFilter>) => void;
  toggleTag: (tag: string) => void;
  clearTags: () => void;
  openLightbox: (filename: string) => void;
  closeLightbox: () => void;
  nextLightbox: () => void;
  prevLightbox: () => void;
  openEdit: (filename: string) => void;
  closeEdit: () => void;
  saveEdit: (entry: classification.Entry) => Promise<void>;
  resolveConflictReload: () => Promise<void>;
  resolveConflictForce: () => Promise<void>;
  resolveConflictCancel: () => void;
  persistableState: {
    folderPath: string;
    filter: { tags: string[]; confidence: string; query: string };
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
  const [lightbox, setLightbox] = useState<LightboxState>({
    open: false,
    filename: null,
  });
  const [editing, setEditing] = useState<EditingState>({
    open: false,
    filename: null,
  });
  const [conflict, setConflict] = useState<ConflictPrompt | null>(null);

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

  // Auto-load on mount if a folderPath was restored from session.
  useEffect(() => {
    if (initFolderPath) {
      loadInternal(initFolderPath);
    }
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
    const res = await loadInternal(picked);
    if (!res) return;
    if (!res.hasSidecar) {
      const create = await confirm(
        "サイドカー (_classification.json) がありません。\n新規作成しますか?",
      );
      if (!create) return;
      try {
        await CreateEmptyClassification(picked);
      } catch (e) {
        toast(`サイドカー作成に失敗しました: ${errorMessage(e)}`, "error");
        return;
      }
      await loadInternal(picked);
    }
  }, [confirm, loadInternal, toast]);

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

  const openLightbox = useCallback((filename: string) => {
    setLightbox({ open: true, filename });
  }, []);
  const closeLightbox = useCallback(() => {
    setLightbox({ open: false, filename: null });
  }, []);
  const nextLightbox = useCallback(() => {
    setLightbox((cur) => stepLightbox(cur, filteredEntries, 1));
  }, [filteredEntries]);
  const prevLightbox = useCallback(() => {
    setLightbox((cur) => stepLightbox(cur, filteredEntries, -1));
  }, [filteredEntries]);

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

  const persistableState = {
    folderPath,
    filter: {
      tags: filter.tags,
      confidence: filter.confidence,
      query: filter.query,
    },
  };

  return {
    folderPath,
    loadResult,
    loading,
    error,
    filter,
    filteredEntries,
    lightbox,
    editing,
    conflict,
    openFolder,
    reload,
    setFilter,
    toggleTag,
    clearTags,
    openLightbox,
    closeLightbox,
    nextLightbox,
    prevLightbox,
    openEdit,
    closeEdit,
    saveEdit,
    resolveConflictReload,
    resolveConflictForce,
    resolveConflictCancel,
    persistableState,
  };
}

function stepLightbox(
  cur: LightboxState,
  entries: classification.Entry[],
  delta: number,
): LightboxState {
  if (!cur.open || !cur.filename || entries.length === 0) return cur;
  const idx = entries.findIndex((e) => e.filename === cur.filename);
  if (idx < 0) return cur;
  const next = (idx + delta + entries.length) % entries.length;
  return { open: true, filename: entries[next].filename };
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
