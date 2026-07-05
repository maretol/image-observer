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

// Go 側 SaveJSON が expectedMtime 不一致で返す sentinel (useClassificationEdit にも同じ)。
const CONFLICT_PREFIX = "CONFLICT:";

export type UseClassificationDeleteReturn = {
  // 1 枚をゴミ箱へ送り (dev は os.Remove, internal/imgfile.Trash) sidecar に反映。
  // ファイルがディスクから消えたら true (呼び出し側が該当 viewer タブも閉じられる)。
  // キャンセル / sidecar 前の失敗 (ファイル無傷) は false。
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

// 1 枚削除フロー: confirm → Trash IPC → sidecar 反映 (CONFLICT 1 回リトライ) →
// メモリ entries を patch + 選択から除外。IPC 前に filename を inFlightDeletesRef に
// 記録し、watcher の self-echo 経路が結果の Remove event を自分のものと認識して
// "外部削除" toast を出さないようにする。
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

      // DeleteImage の前に「削除中」と記録する。watcher の Remove event は IPC 往復の
      // 数 ms 後 (後続の SaveClassification + setLoadResult patch より前) に飛びうるので、
      // これを self-echo と認識させ、外部削除 toast + commit を防ぐ。sidecar の結果に
      // かかわらず下の finally で消す。cur で key するのは、その時 folderRef が変わっていても
      // 同じ bucket から cleanup できるように。
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
          // 失敗 toast はまだこの folder を見ているときだけ出す。
          if (folderRef.current === cur) {
            toast("削除に失敗しました (詳細はログ)", "error");
          }
          return false;
        }

        // ファイルはディスクから消えた。ここから先は sidecar は best-effort。
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
            // 外部編集を取り込んでから fresh mtime で削除を再適用。
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
              // fresh === null は本当の Load 失敗 (loadInternal が既に toast) か、
              // await 中に新しい watcher payload / manual reload が我々を上書きしたか。
              // 後者では local state は既に新しい真値を反映しているので、supersede 前の
              // entriesAfter で patch すると巻き戻り、gen bump は新結果を stale 化する。
              // local patch + gen bump を丸ごと skip — ファイルは既にディスクから消えて
              // いるので、次の watcher event (か勝った Load) が sidecar drift を整合させる。
              return true;
            }
          } else {
            sidecarErr = msg;
          }
        }

        // state commit 前に folder check — 旧 folder の entriesAfter (旧 folder の
        // 削除 filename が欠けている) で新 folder の loadResult を patch すると、新 folder
        // の同名 entry を誤って消す。旧 folder のファイルは既に消えており、新 folder では
        // 見た目の変化なしが正しい。
        if (folderRef.current !== cur) return true;
        // local state patch 前に gen bump し、delete + sidecar save 完了前に始まった
        // in-flight LoadClassification (watcher / replay / silent-recheck / manual reload) を
        // stale にして、setLoadResult で削除済み entry を復活させないようにする。
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
