import { useCallback } from "react";
import { UpdateClassificationEntry } from "../../../wailsjs/go/main/App";
import { classification } from "../../../wailsjs/go/models";
import type { ToastFn } from "../../shared/components/Toast";
import { errorMessage } from "../../shared/utils/error";
import { logger } from "../../shared/utils/logger";
import type { ConflictPrompt, EditingState } from "./useClassification";

// CONFLICT_PREFIX is the Go-side sentinel returned by SaveJSON when
// expectedMtime no longer matches the on-disk sidecar (see
// internal/classification/service.go ErrConflict path). Compared with
// startsWith so the suffix carries the actual mtime detail back to
// callers / logs.
const CONFLICT_PREFIX = "CONFLICT:";

// SaveContext carries the folder a save was captured for (#110 C). saveEdit
// gates on ctx.folder instead of a live folderRef so a save-on-unmount cleanup
// firing after a folder switch (its snapshot belongs to the OLD folder) is
// skipped without ClassificationView.handleSave's folderPathRef band-aid
// (PR #109 round 6). mtime is intentionally NOT carried — saveEdit reads it
// fresh from loadResultRef so queued replays use the advanced value
// (spec-edit-autosave-testing.md §4.2 / §11 D-2 a).
export type SaveContext = { folder: string };

export type UseClassificationEditReturn = {
  openEdit: (filename: string) => void;
  closeEdit: () => void;
  saveEdit: (entry: classification.Entry, ctx: SaveContext) => Promise<void>;
  resolveConflictReload: () => Promise<void>;
  resolveConflictForce: () => Promise<void>;
  resolveConflictCancel: () => void;
};

type Props = {
  conflict: ConflictPrompt | null;
  // loadResultRef is the render-time-synced mirror of `loadResult`
  // (useClassification.ts:338). saveEdit reads `.current.mtime` at *call
  // time* rather than capturing it via useCallback closure so that a stale
  // `saveEdit` (held by an unmounted SampleEditPane that still has a
  // queued auto-save replaying after the in-flight save's setLoadResult
  // committed) still picks up the latest mtime — without this the queued
  // save would replay against the pre-save mtime and trip the Go-side
  // expectedMtime CONFLICT path (Copilot review #109 round 2, #6).
  loadResultRef: React.MutableRefObject<classification.LoadResult | null>;

  folderRef: React.MutableRefObject<string>;
  requestGenRef: React.MutableRefObject<number>;

  setLoadResult: React.Dispatch<
    React.SetStateAction<classification.LoadResult | null>
  >;
  setEditing: React.Dispatch<React.SetStateAction<EditingState>>;
  setConflict: React.Dispatch<React.SetStateAction<ConflictPrompt | null>>;

  reload: () => Promise<void>;
  toast: ToastFn;
};

// useClassificationEdit owns the per-entry edit / save / conflict-resolve
// chain. saveEdit and resolveConflictForce both follow the "bump
// requestGenRef immediately after the disk write so any in-flight Load
// whose LoadClassification started before our mutation is stale-discarded
// before its setLoadResult lands" pattern (AGENTS.md §H-8, PR #75 10th
// thread A). Folder checks on each post-await commit (`folderRef.current
// !== cur`) keep stale OLD-folder mutations from corrupting NEW-folder
// state if the user switched folders mid-await (PR #75 14th, thread C).
export function useClassificationEdit(props: Props): UseClassificationEditReturn {
  const {
    conflict,
    loadResultRef,
    folderRef,
    requestGenRef,
    setLoadResult,
    setEditing,
    setConflict,
    reload,
    toast,
  } = props;

  const openEdit = useCallback(
    (filename: string) => {
      setEditing({ open: true, filename });
    },
    [setEditing],
  );

  const closeEdit = useCallback(() => {
    setEditing({ open: false, filename: null });
  }, [setEditing]);

  const saveEdit = useCallback(
    async (entry: classification.Entry, ctx: SaveContext) => {
      // Pre-IPC folder gate (#110 C). The save targets ctx.folder — the folder
      // active when the snapshot was captured, carried explicitly instead of
      // via a stale onSave closure. If the user has since switched away (the
      // save-on-unmount cleanup firing after a folder change, whose snapshot
      // belongs to the OLD folder), skip without touching disk. This replaces
      // ClassificationView.handleSave's folderPathRef band-aid (PR #109 round 6)
      // with an explicit context check, and also covers the empty-folder case
      // the old `if (!cur)` guarded (ctx.folder is never "" while a save fires).
      if (!ctx.folder || folderRef.current !== ctx.folder) return;
      // Read the live mtime from the ref so a saveEdit closure captured by an
      // unmounted SampleEditPane (queued auto-save replay after in-flight
      // success) still sends the latest mtime. Without this, the queued IPC
      // would carry the pre-save mtime and trip Go's expectedMtime CONFLICT
      // path (PR #109 round 2 #6). Having passed the gate, loadResultRef tracks
      // ctx.folder.
      const lr = loadResultRef.current;
      if (!lr) return;
      try {
        const out = await UpdateClassificationEntry(
          ctx.folder,
          entry,
          lr.mtime,
        );
        // Folder check before any state commit — the UpdateEntry disk
        // write itself is fine to complete against ctx.folder, but patching
        // the NEW folder's loadResult with OLD folder's mtime / entry
        // would corrupt it. If the user switched folders mid-await we
        // skip the local commit entirely; the OLD folder's save did
        // succeed on disk, and any next openFolder of it will Load the
        // updated entry via the normal path (PR #75 14th, thread C).
        if (folderRef.current !== ctx.folder) return;
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
        if (folderRef.current !== ctx.folder) return;
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
    [
      folderRef,
      loadResultRef,
      requestGenRef,
      setConflict,
      setEditing,
      setLoadResult,
      toast,
    ],
  );

  const resolveConflictReload = useCallback(async () => {
    setConflict(null);
    setEditing({ open: false, filename: null });
    await reload();
  }, [reload, setConflict, setEditing]);

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
  }, [
    conflict,
    folderRef,
    reload,
    requestGenRef,
    setConflict,
    setEditing,
    toast,
  ]);

  const resolveConflictCancel = useCallback(() => {
    setConflict(null);
    // Editing popover stays open so the user can copy their draft if needed.
  }, [setConflict]);

  return {
    openEdit,
    closeEdit,
    saveEdit,
    resolveConflictReload,
    resolveConflictForce,
    resolveConflictCancel,
  };
}
