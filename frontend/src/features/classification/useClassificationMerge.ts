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

// 子 sidecar マージ prompt。mutation IPC (MergeChildSidecars / CreateEmptyClassification)
// はディスク書き込み後に requestGenRef を bump し、in-flight の watcher / silent-recheck
// Load を stale 破棄する (AGENTS.md §H-8)。
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
    // gen bump + reload の前に folder チェック — これが無いと旧 folder の reload が
    // gen を bump して新 folder の in-flight Load を stale 化し、旧 folder データを
    // 新 folder state に commit してしまう。
    if (folderRef.current !== target) return;
    // merge 書き込み後に gen bump し、merge 前に始まった in-flight watcher /
    // silent-recheck Load を stale 破棄する (saveEdit / deleteOne と同じ flicker 防止)。
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
    // resolveMergeMerge と同じ gen-bump ルール。
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
    // フォルダ選択は残す (ユーザーは "再読み込み" か再選択できる)。
  }, [setMergePrompt]);

  return { resolveMergeMerge, resolveMergeSkip, resolveMergeCancel };
}
