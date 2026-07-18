import { useCallback } from "react";
import { SaveClassification } from "../../../wailsjs/go/main/App";
import { classification } from "../../../wailsjs/go/models";
import type { ToastFn } from "../../shared/components/Toast";
import { errorMessage } from "../../shared/utils/error";
import { logger } from "../../shared/utils/logger";
import type { ListTabFilter } from "./filters";
import { canEnterReorderMode } from "./reorderMode";
import type { SortMode } from "./sortMode";
import { CONFLICT_PREFIX } from "./useClassificationEdit";

type Props = {
  sortMode: SortMode;
  filter: ListTabFilter;

  folderRef: React.MutableRefObject<string>;
  requestGenRef: React.MutableRefObject<number>;
  loadResultRef: React.MutableRefObject<classification.LoadResult | null>;
  // 並べ替えモードの render 時同期ミラー (commitReorder の drop 時再確認用)。
  reorderModeRef: React.MutableRefObject<boolean>;
  // saveEdit / resolveConflictForce の IPC 区間で increment されるカウンタ
  // (useClassificationEdit)。>0 の間の drop は保存せず中止 (spec-image-sort.md §8.2)。
  editSaveInFlightRef: React.MutableRefObject<number>;

  setReorderMode: React.Dispatch<React.SetStateAction<boolean>>;
  setLoadResult: React.Dispatch<
    React.SetStateAction<classification.LoadResult | null>
  >;
  clearSelected: () => void;
  reload: () => Promise<void>;
  toast: ToastFn;
};

export type UseClassificationReorderReturn = {
  enterReorderMode: () => void;
  exitReorderMode: () => void;
  // 並び替え後の全 entries を楽観 commit → SaveClassification。gate 詳細は spec §8。
  commitReorder: (newEntries: classification.Entry[]) => Promise<void>;
};

// 並べ替えモードの入退室と保存 (#144 Phase 2, spec-image-sort.md §5.2 / §8)。
// DnD の pointer 幾何は useCardReorder (view 層) が持ち、ここは entries 配列の
// commit + 永続化だけを受け持つ。
export function useClassificationReorder(
  props: Props,
): UseClassificationReorderReturn {
  const {
    sortMode,
    filter,
    folderRef,
    requestGenRef,
    loadResultRef,
    reorderModeRef,
    editSaveInFlightRef,
    setReorderMode,
    setLoadResult,
    clearSelected,
    reload,
    toast,
  } = props;

  const enterReorderMode = useCallback(() => {
    // ボタンの disabled 表示と同じ条件を onClick でも再評価する二重防御 (spec §8.1)。
    if (!canEnterReorderMode(sortMode, filter)) return;
    // モード中は選択操作が無効なので、突入時に選択を捨てて bulk toolbar も消す (§5.2)。
    clearSelected();
    setReorderMode(true);
  }, [sortMode, filter, clearSelected, setReorderMode]);

  const exitReorderMode = useCallback(() => {
    setReorderMode(false);
  }, [setReorderMode]);

  const commitReorder = useCallback(
    async (newEntries: classification.Entry[]) => {
      const folder = folderRef.current;
      const lr = loadResultRef.current;
      if (!folder || !lr) return;
      // drop 時再確認 (spec §8.3): モード解除後に着地した drop は捨てる。
      if (!reorderModeRef.current) return;
      // autosave in-flight 中の drop は保存せず中止 (楽観 commit もしない)。稀ケースは
      // queue 追従より単純さを優先 (D8)。
      if (editSaveInFlightRef.current > 0) {
        logger.debug("card-reorder", "drop skipped (edit save in-flight)");
        return;
      }
      const expectedMtime = lr.mtime;
      // 楽観 local commit。書き込み前に始まった in-flight Load が新しい並びを巻き戻さない
      // よう先に gen bump (saveEdit / deleteOne と同パターン, AGENTS.md H-8)。
      ++requestGenRef.current;
      setLoadResult((prev) =>
        prev
          ? classification.LoadResult.createFrom({
              ...prev,
              entries: newEntries,
            })
          : prev,
      );
      try {
        const out = await SaveClassification(folder, newEntries, expectedMtime);
        // 旧 folder の mtime で新 folder の loadResult を patch しない (saveEdit と同じ)。
        if (folderRef.current !== folder) return;
        ++requestGenRef.current;
        setLoadResult((prev) =>
          prev
            ? classification.LoadResult.createFrom({ ...prev, mtime: out.mtime })
            : prev,
        );
        logger.info("card-reorder", "commit", { folder });
      } catch (e) {
        if (folderRef.current !== folder) return;
        const msg = errorMessage(e);
        if (msg.startsWith(CONFLICT_PREFIX)) {
          // 並び替えには温存すべき draft が無いので conflict ダイアログは出さず、
          // disk 正を再 Load して楽観 commit を捨てる (spec §8.1 保存失敗行)。
          toast("並び替えが外部の変更と競合しました。再読み込みします", "warn");
        } else {
          toast(`並び替えの保存に失敗しました: ${msg}`, "error");
        }
        logger.warn("card-reorder", "save failed", { err: msg });
        // silent に乖離を残さない (§8.1)。reload が gen bump を担う。
        await reload();
      }
    },
    [
      folderRef,
      loadResultRef,
      reorderModeRef,
      editSaveInFlightRef,
      requestGenRef,
      setLoadResult,
      reload,
      toast,
    ],
  );

  return { enterReorderMode, exitReorderMode, commitReorder };
}
