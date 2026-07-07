import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckDuplicates,
  DismissDuplicatePair,
} from "../../../wailsjs/go/main/App";
import type { classification, imghash } from "../../../wailsjs/go/models";
import type { ToastFn } from "../../shared/components/Toast";
import { errorMessage } from "../../shared/utils/error";
import { logger } from "../../shared/utils/logger";
import { DUPLICATE_DETECT_AUTO } from "../settings/duplicateDetect";
import { removePair } from "./duplicateBadge";

export type UseDuplicateCheckReturn = {
  // 現 folder のダブり候補ペア (dismiss 除外済み)。null = 未検出 (off / クリア直後 / 初回前)。
  duplicatePairs: imghash.DuplicatePair[] | null;
  // 「ダブりではない」— 永続化 (Go) 成功後に現 report から local 除去。失敗は error toast。
  dismissDuplicatePair: (fileA: string, fileB: string) => Promise<void>;
  // report クリア + in-flight Check の stale 化。orchestrator の resetEntriesDependentState から
  // 呼ぶ (duplicatePairs は entries 依存 state, spec §8.1)。
  resetDuplicates: () => void;
  // 同名上書き (watcher payload の contentChanged) の再判定トリガ。filename 集合キーでは
  // 内容変化を検知できないため、専用 counter を kick effect の deps に足す (spec §8.1)。
  notifyContentChanged: () => void;
};

type Props = {
  folderPath: string;
  folderRef: React.MutableRefObject<string>;
  loadResult: classification.LoadResult | null;
  // settings ロード中は undefined — kick せず待つ (off を永続化したユーザーに対して
  // 一瞬の Check が走らないように。watcher の watchMode gate と同じ理由)。
  duplicateDetectMode?: string;
  // Go 側が settings から読むので IPC 引数には無いが、変更時の再判定 (spec §8.1 設定変更行) の
  // ため effect の deps に載せる。
  duplicateThreshold?: number;
  toast: ToastFn;
};

// ダブり検出の kick / gate / report state を持つ子フック (#136, spec-duplicate-detection.md §8)。
// 同期モデル: 検出 kick は「entries の filename 集合 / contentGen / folder / mode / threshold が
// 変わった」effect に一本化し、各経路 (Load 成功 / watcher 反映 / 同名上書き / 削除 / 設定変更) が
// setLoadResult / notifyContentChanged / settings 更新を通ることで自然に再 kick される。
// in-flight の破棄は dupGenRef (bump = 条件変更) + folderRef + post-await mode check の 3 gate。
export function useDuplicateCheck(props: Props): UseDuplicateCheckReturn {
  const {
    folderPath,
    folderRef,
    loadResult,
    duplicateDetectMode,
    duplicateThreshold,
    toast,
  } = props;

  const [duplicatePairs, setDuplicatePairs] = useState<
    imghash.DuplicatePair[] | null
  >(null);

  // 検出世代。bump = 判定条件が変わった / report を捨てた。in-flight Check の commit を drop
  // する。Load 側の requestGenRef とは独立 (Load の世代管理を汚染しない, spec §8.2)。
  const dupGenRef = useRef(0);

  // post-await の mode 判定用 (render-time sync, AGENTS.md H-8「state ref の同期タイミング」)。
  const modeRef = useRef(duplicateDetectMode);
  modeRef.current = duplicateDetectMode;

  const resetDuplicates = useCallback(() => {
    dupGenRef.current++;
    setDuplicatePairs(null);
  }, []);

  // 同名上書き (内容変化・集合不変) の再判定トリガ。watcher handler が payload の
  // contentChanged で呼ぶ (spec §8.1 同名上書き行)。
  const [contentGen, setContentGen] = useState(0);
  const notifyContentChanged = useCallback(() => {
    setContentGen((g) => g + 1);
  }, []);

  // filename 集合。sort 済み配列 (IPC に渡す実体) と join キー (effect の deps 比較専用) を
  // 分離する — キー文字列の split 逆変換をすると、区切り文字を含む filename が偽の複数名に
  // 化ける (spec §8.1)。区切りは NUL (どの FS でも filename に現れない)。
  // メタデータ編集 (tags / note / confidence) では entries の identity が変わっても filename
  // 集合は不変 → 保存のたびに Check IPC を発火させない。追加 / 削除 / watcher 反映では
  // 変わるので再 kick される。
  const filenames = useMemo(() => {
    if (!loadResult) return null;
    return loadResult.entries.map((e) => e.filename).sort();
  }, [loadResult]);
  const filenamesKey = filenames === null ? null : filenames.join("\0");
  // effect がキー変化時に最新配列を読むための render-time sync (AGENTS.md H-8)。
  const filenamesRef = useRef(filenames);
  filenamesRef.current = filenames;

  // folder 切替直後は旧 folder の loadResult が残留する (openFolder は loadResult を null に
  // しない)。新 Load が commit するまで kick しない。
  const loadResultFolder = loadResult?.folderPath ?? null;

  useEffect(() => {
    if (duplicateDetectMode === undefined) return; // settings ロード中
    if (duplicateDetectMode !== DUPLICATE_DETECT_AUTO) {
      // off: バッジを消し、in-flight を stale 化 (mode entry check, spec §8.2)。
      dupGenRef.current++;
      setDuplicatePairs(null);
      return;
    }
    if (!folderPath || filenamesKey === null) return;
    if (loadResultFolder !== folderPath) return;
    const captured = folderPath;
    const myGen = ++dupGenRef.current;
    const filenames = filenamesRef.current ?? [];
    if (filenames.length < 2) {
      // ペアが成立し得ない。IPC を出さず空 report 扱い。
      setDuplicatePairs([]);
      return;
    }
    void (async () => {
      try {
        const res = await CheckDuplicates(captured, filenames);
        if (myGen !== dupGenRef.current) return;
        if (folderRef.current !== captured) return;
        if (modeRef.current !== DUPLICATE_DETECT_AUTO) return; // post-await mode check
        setDuplicatePairs(res.pairs);
      } catch (e) {
        if (myGen !== dupGenRef.current) return;
        if (folderRef.current !== captured) return;
        // 検出は補助機能なので toast は出さずログのみ。前回 report は保持 (spec §5.5 / D6)。
        logger.warn("classification", "duplicate check failed", {
          folder: captured,
          err: errorMessage(e),
        });
      }
    })();
  }, [
    folderPath,
    filenamesKey,
    contentGen,
    loadResultFolder,
    duplicateDetectMode,
    duplicateThreshold,
    folderRef,
  ]);

  const dismissDuplicatePair = useCallback(
    async (fileA: string, fileB: string) => {
      const captured = folderRef.current;
      try {
        await DismissDuplicatePair(captured, fileA, fileB);
      } catch (e) {
        if (folderRef.current === captured) {
          logger.error("classification", "dismiss duplicate failed", {
            folder: captured,
            fileA,
            fileB,
            err: errorMessage(e),
          });
          toast("ダブり除外の保存に失敗しました (詳細はログ)", "error");
        }
        return;
      }
      if (folderRef.current !== captured) return;
      // gen は bump しない: dismiss は判定条件を変えず、in-flight / 後続の Check は Go 側で
      // 永続除外済みの report を返すため矛盾しない (spec §8.2)。local patch のみ。
      setDuplicatePairs((cur) => (cur ? removePair(cur, fileA, fileB) : cur));
    },
    [folderRef, toast],
  );

  return {
    duplicatePairs,
    dismissDuplicatePair,
    resetDuplicates,
    notifyContentChanged,
  };
}
