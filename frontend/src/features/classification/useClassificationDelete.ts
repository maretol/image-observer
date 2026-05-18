import { useCallback } from "react";
import {
  DeleteImage,
  SaveClassification,
} from "../../../wailsjs/go/main/App";
import { classification } from "../../../wailsjs/go/models";
import type { ToastFn } from "../../shared/components/Toast";
import { errorMessage } from "../../shared/utils/error";
import { logger } from "../../shared/utils/logger";
import type { ConfirmFn } from "../viewer-grid/useViewerSet";

// CONFLICT_PREFIX is the Go-side sentinel returned by SaveJSON when
// expectedMtime no longer matches the on-disk sidecar (mirrored in
// useClassificationEdit for saveEdit's distinct mtime-conflict path).
const CONFLICT_PREFIX = "CONFLICT:";

export type UseClassificationDeleteReturn = {
  // deleteOne sends one image to the OS recycle bin (Windows; os.Remove in
  // dev builds — see internal/imgfile.Trash) and mirrors the removal into
  // the sidecar. Returns true iff the file is no longer on disk so the
  // caller can also close any viewer tabs still pointing at it. False on
  // user cancel or pre-sidecar failure (file untouched).
  deleteOne: (filename: string) => Promise<boolean>;
};

type Props = {
  loadResult: classification.LoadResult | null;

  folderRef: React.MutableRefObject<string>;
  requestGenRef: React.MutableRefObject<number>;
  inFlightDeletesRef: React.MutableRefObject<Map<string, Set<string>>>;

  setLoadResult: React.Dispatch<
    React.SetStateAction<classification.LoadResult | null>
  >;
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>;

  loadInternal: (
    path: string,
  ) => Promise<classification.LoadResult | null>;
  confirm: ConfirmFn;
  toast: ToastFn;
};

// useClassificationDelete owns the trash-one-image flow: confirm → Trash IPC
// → mirror into sidecar (with one CONFLICT retry) → patch in-memory entries
// + drop from selection. Marks the filename in inFlightDeletesRef before
// the IPC so the watcher self-echo path (entriesEquivalent + asymmetric
// strip) recognises the resulting Remove event as ours and stays silent
// instead of toasting "外部削除" (PR #75 9th thread J / 21st thread A /
// 25th thread D).
export function useClassificationDelete(props: Props): UseClassificationDeleteReturn {
  const {
    loadResult,
    folderRef,
    requestGenRef,
    inFlightDeletesRef,
    setLoadResult,
    setSelected,
    loadInternal,
    confirm,
    toast,
  } = props;

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
    [
      confirm,
      folderRef,
      inFlightDeletesRef,
      loadInternal,
      loadResult,
      requestGenRef,
      setLoadResult,
      setSelected,
      toast,
    ],
  );

  return { deleteOne };
}
