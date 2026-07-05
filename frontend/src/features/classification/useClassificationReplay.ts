import { useCallback, useEffect, useRef } from "react";
import { LoadClassification } from "../../../wailsjs/go/main/App";
import { classification } from "../../../wailsjs/go/models";
import type { ToastFn } from "../../shared/components/Toast";
import { errorMessage } from "../../shared/utils/error";
import { logger } from "../../shared/utils/logger";
import { WATCH_MODE_OFF } from "../settings/watchMode";
import type {
  ConflictPrompt,
  EditingState,
  MergePromptState,
  PendingResult,
} from "./useClassification";
import { decideAutoMerge } from "./watcherPolicy";

type Props = {
  // defer 元 state (下の open→close 検出 effect を駆動)。
  editing: EditingState;
  conflict: ConflictPrompt | null;
  mergePrompt: MergePromptState;

  // 共有 ref
  folderRef: React.MutableRefObject<string>;
  watchModeRef: React.MutableRefObject<string | undefined>;
  requestGenRef: React.MutableRefObject<number>;
  loadResultRef: React.MutableRefObject<classification.LoadResult | null>;
  editingRef: React.MutableRefObject<EditingState>;
  conflictRef: React.MutableRefObject<ConflictPrompt | null>;
  mergePromptOpenRef: React.MutableRefObject<boolean>;
  pendingResultRef: React.MutableRefObject<PendingResult | null>;

  // setter
  setLoadResult: React.Dispatch<
    React.SetStateAction<classification.LoadResult | null>
  >;
  setError: (msg: string | null) => void;
  setEditing: React.Dispatch<React.SetStateAction<EditingState>>;

  // 協調先
  commitFreshResult: (
    fresh: classification.LoadResult,
    fnames: ReadonlySet<string>,
  ) => void;
  resetEntriesDependentState: () => void;
  toast: ToastFn;
};

// 3 つの defer 元 (editing / conflict / mergePrompt) の open → closed で、保留 payload を
// commit する。performReplay は 4 つの corner case を集約する:
//   1) deferred 中に folder 切替 → pending を捨てる
//   2) mtime が進んだ (deferred 中に save → pending.fresh は save 前) → stale snapshot を
//      commit せず re-Load する。でないとユーザーの編集が見た目上巻き戻る
//   3) decideAutoMerge を再実行し、defer 中に生じた editing-target-removed 例外も発火させる
//   4) 片方の defer 元が閉じてももう片方が開いていれば re-park する
//
// replay reload (case 2) は requestGenRef を bump し、この reload の commit *後* に返る
// in-flight watcher Load を stale 破棄する (event 駆動と replay 駆動の順序前後を吸収)。
export function useClassificationReplay(props: Props): void {
  const {
    editing,
    conflict,
    mergePrompt,
    folderRef,
    watchModeRef,
    requestGenRef,
    loadResultRef,
    editingRef,
    conflictRef,
    mergePromptOpenRef,
    pendingResultRef,
    setLoadResult,
    setError,
    setEditing,
    commitFreshResult,
    resetEntriesDependentState,
    toast,
  } = props;

  const performReplay = useCallback(async () => {
    const pending = pendingResultRef.current;
    if (!pending) return;
    if (watchModeRef.current === WATCH_MODE_OFF) {
      // この保留 auto-merge 結果を持っている間にユーザーが監視を無効化した。
      // defer-close で commit するとオプトアウトした外部変更が反映され驚かせる。
      pendingResultRef.current = null;
      return;
    }
    if (pending.folder !== folderRef.current) {
      // park 中に folder 切替。保存結果は別タブ用なので捨てる (現 folder の watcher
      // event は自然に届く)。
      pendingResultRef.current = null;
      return;
    }
    if (pending.capturedGen !== requestGenRef.current) {
      // gen drift: park 後に manual reload / local mutation / 別 watcher payload が
      // commit (して requestGenRef を bump) した。画面は既に新しい真値なので、pending を
      // commit すると mtime が一致しても巻き戻りうる (entries だけの変更は sidecar mtime を
      // bump しないので下の mtime チェックでは拾えない)。
      pendingResultRef.current = null;
      return;
    }
    let fresh = pending.fresh;
    let reloadedFresh = false;
    const cur = loadResultRef.current;
    if (cur && cur.mtime !== fresh.mtime) {
      // mtime が park snapshot を超えた = deferred 中に sidecar を書いた。park した fresh は
      // save 前 state で、commit するとユーザー編集を巻き戻す。re-Load して最新
      // entries + mtime を取り、新 gen を取って out-of-order watcher Load に上書きされないように。
      pendingResultRef.current = null;
      const myGen = ++requestGenRef.current;
      try {
        fresh = await LoadClassification(folderRef.current);
        reloadedFresh = true;
      } catch (e) {
        // await 中に新しい request が上書きしたら drop (watcher handler の成功経路が commit する)。
        if (myGen !== requestGenRef.current) return;
        if (folderRef.current !== pending.folder) return;
        // watchMode を再チェック: 上の entry-gate は reload await の前に走った。await 中に
        // off にされたら、オプトアウトした監視に対して失敗を出すことになる。
        if (watchModeRef.current === WATCH_MODE_OFF) return;
        // それ以外はユーザーに出す (log だけだと auto-merge 失敗が見えないため)。manual-reload の
        // error 経路に合わせる。
        const msg = errorMessage(e);
        setError(msg);
        setLoadResult(null);
        // loadResult と一緒に entries 依存 state をクリア (loadInternal の catch と同じ)。
        resetEntriesDependentState();
        toast(`読み込みに失敗しました: ${msg}`, "error");
        logger.warn("classification", "replay reload failed", { err: msg });
        return;
      }
      // 成功経路も gen チェック: await 中に新しい watcher Load が commit していたら、
      // 巻き戻さないよう discard する。
      if (myGen !== requestGenRef.current) return;
      if (folderRef.current !== pending.folder) return;
      // 同じ off-during-await ガード — 監視無効化後に reload 結果を commit すると驚かせる。
      if (watchModeRef.current === WATCH_MODE_OFF) return;
    }
    // reload しなかった場合 (mtime 一致, fresh = pending.fresh) でも、defer-park と replay
    // トリガの間に監視が off にされた deferred commit がすり抜けないよう watchMode を再チェック。
    // entry-gate は「performReplay 開始時に off」を、上の await ガードは reload 中の flip を
    // 扱う。この最終ガードは「reload なし + auto 中に park → off にトグル → defer close」を拾う。
    if (watchModeRef.current === WATCH_MODE_OFF) {
      pendingResultRef.current = null;
      return;
    }
    if (reloadedFresh) {
      // 前回失敗した reload の残り error をクリア (replay 成功なので出し続けない)。
      setError(null);
    }
    const fnames = new Set(fresh.entries.map((e) => e.filename));
    const action = decideAutoMerge({
      editingOpen: editingRef.current.open,
      editingFilename: editingRef.current.filename,
      conflictOpen: conflictRef.current !== null,
      mergePromptOpen: mergePromptOpenRef.current,
      freshFilenames: fnames,
    });
    if (action.kind === "defer") {
      // より新しい snapshot と現 gen で re-park (reload で更新した snapshot が、今後の
      // gen drift 判定の新 baseline になる)。
      pendingResultRef.current = {
        fresh,
        folder: pending.folder,
        capturedGen: requestGenRef.current,
      };
      return;
    }
    pendingResultRef.current = null;
    if (action.kind === "commit-editing-removed") {
      toast(`${action.filename} は外部で削除されました`, "warn");
      setEditing({ open: false, filename: null });
    }
    commitFreshResult(fresh, fnames);
  }, [
    commitFreshResult,
    conflictRef,
    editingRef,
    folderRef,
    loadResultRef,
    mergePromptOpenRef,
    pendingResultRef,
    requestGenRef,
    resetEntriesDependentState,
    setEditing,
    setError,
    setLoadResult,
    toast,
    watchModeRef,
  ]);

  // replay トリガ: conflict / mergePrompt / editing のいずれかが open → closed。
  // 他の defer 元がまだ開いていれば performReplay は自ら drop する。
  const wasInDeferRef = useRef(false);
  useEffect(() => {
    const inDefer = mergePrompt.open || conflict !== null;
    const wasInDefer = wasInDeferRef.current;
    wasInDeferRef.current = inDefer;
    if (wasInDefer && !inDefer) {
      void performReplay();
    }
  }, [mergePrompt.open, conflict, performReplay]);

  const wasEditingOpenRef = useRef(editing.open);
  useEffect(() => {
    const wasOpen = wasEditingOpenRef.current;
    wasEditingOpenRef.current = editing.open;
    if (wasOpen && !editing.open) {
      void performReplay();
    }
  }, [editing.open, performReplay]);
}
