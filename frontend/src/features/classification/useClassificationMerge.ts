import { useCallback } from "react";
import {
  CreateEmptyClassification,
  MergeChildSidecars,
} from "../../../wailsjs/go/main/App";
import { classification } from "../../../wailsjs/go/models";
import type { ToastFn } from "../../shared/components/Toast";
import { errorMessage } from "../../shared/utils/error";
import { logger } from "../../shared/utils/logger";
import type { MergePromptState } from "./useClassification";

export type UseClassificationMergeReturn = {
  resolveMergeMerge: () => Promise<void>;
  resolveMergeSkip: () => Promise<void>;
  resolveMergeCancel: () => void;
};

type Props = {
  mergePrompt: MergePromptState;

  folderRef: React.MutableRefObject<string>;
  requestGenRef: React.MutableRefObject<number>;

  setMergePrompt: React.Dispatch<React.SetStateAction<MergePromptState>>;

  loadInternal: (
    path: string,
  ) => Promise<classification.LoadResult | null>;
  toast: ToastFn;
};

// useClassificationMerge owns the child-sidecar merge prompt: either merge
// the discovered child sidecars into the parent folder, skip and create an
// empty sidecar, or cancel and leave the prompt closed. Mutation IPCs
// (MergeChildSidecars / CreateEmptyClassification) bump requestGenRef
// after the disk write so any in-flight watcher / silent-recheck Load is
// stale-discarded (AGENTS.md §H-8, PR #75 10th thread A pattern).
export function useClassificationMerge(props: Props): UseClassificationMergeReturn {
  const {
    mergePrompt,
    folderRef,
    requestGenRef,
    setMergePrompt,
    loadInternal,
    toast,
  } = props;

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
  }, [
    folderRef,
    loadInternal,
    mergePrompt.folderPath,
    requestGenRef,
    setMergePrompt,
    toast,
  ]);

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
  }, [
    folderRef,
    loadInternal,
    mergePrompt.folderPath,
    requestGenRef,
    setMergePrompt,
    toast,
  ]);

  const resolveMergeCancel = useCallback(() => {
    setMergePrompt({ open: false, preview: null, folderPath: "" });
    // Folder selection persists; the user can hit "再読み込み" or pick again.
  }, [setMergePrompt]);

  return { resolveMergeMerge, resolveMergeSkip, resolveMergeCancel };
}
