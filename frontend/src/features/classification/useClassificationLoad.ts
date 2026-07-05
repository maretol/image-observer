import { useCallback, useEffect, useRef } from "react";
import {
  CreateEmptyClassification,
  LoadClassification,
  OpenFolderDialog,
  PreviewChildSidecars,
} from "../../../wailsjs/go/main/App";
import { classification } from "../../../wailsjs/go/models";
import type { ToastFn } from "../../shared/components/Toast";
import { errorMessage } from "../../shared/utils/error";
import type { ConfirmFn } from "../viewer-grid/useViewerSet";
import type { MergePromptState } from "./useClassification";

export type UseClassificationLoadReturn = {
  openFolder: () => Promise<void>;
  reload: () => Promise<void>;
  // merge / delete hook が同じ generation-aware な Load ラッパを再利用できるよう公開する
  // (raw LoadClassification は requestGenRef / loadingTokenRef を bypass し到着順 hazard を戻す)。
  loadInternal: (path: string) => Promise<classification.LoadResult | null>;
};

type Props = {
  initFolderPath: string;
  // 共有 ref (read & write)
  folderRef: React.MutableRefObject<string>;
  requestGenRef: React.MutableRefObject<number>;
  loadingTokenRef: React.MutableRefObject<number>;
  initialLoadInFlightRef: React.MutableRefObject<boolean>;
  // watcher hook が持つが、reload() が手動再読み時に watcher reconcile を蹴れるよう読む
  // (消えた root が戻ったとき設定を触らず auto-watcher を張り直せる)。
  dispatchWatchIntentRef: React.MutableRefObject<() => void>;
  // setter
  setFolderPath: (path: string) => void;
  setLoadResult: React.Dispatch<
    React.SetStateAction<classification.LoadResult | null>
  >;
  setLoading: (loading: boolean) => void;
  setError: (msg: string | null) => void;
  setMergePrompt: (state: MergePromptState) => void;
  // 協調先
  resetEntriesDependentState: () => void;
  confirm: ConfirmFn;
  toast: ToastFn;
};

// disk から sidecar を取得する経路と「まだ sidecar が無いとき何をするか」の prompt チェーンを
// 持つ。LoadClassification を requestGenRef / loadingTokenRef で包み、watcher / replay /
// silent-recheck の out-of-order 完了が新結果を巻き戻さないようにする。
//
// race 変数マトリクスは AGENTS.md §H-8。loadingTokenRef (ここだけで bump) と
// initialLoadInFlightRef (watcher silent-recheck が初期 load commit まで defer に使う) の正の置き場。
export function useClassificationLoad(props: Props): UseClassificationLoadReturn {
  const {
    initFolderPath,
    folderRef,
    requestGenRef,
    loadingTokenRef,
    initialLoadInFlightRef,
    dispatchWatchIntentRef,
    setFolderPath,
    setLoadResult,
    setLoading,
    setError,
    setMergePrompt,
    resetEntriesDependentState,
    confirm,
    toast,
  } = props;

  const loadInternal = useCallback(
    async (
      path: string,
    ): Promise<classification.LoadResult | null> => {
      const myGen = ++requestGenRef.current;
      const myLoadToken = ++loadingTokenRef.current;
      initialLoadInFlightRef.current = true;
      setLoading(true);
      setError(null);
      try {
        const res = await LoadClassification(path);
        // stale → null を返し、caller (openFolder / autoLoad) が supersede 済み folder に対して
        // postLoadFlow を走らせないように (success を返すと下流の副作用が誤 folder に発火する)。
        if (myGen !== requestGenRef.current) return null;
        setLoadResult(res);
        return res;
      } catch (e) {
        if (myGen !== requestGenRef.current) return null;
        const msg = errorMessage(e);
        setError(msg);
        setLoadResult(null);
        // entries 依存 state をクリアし、load 失敗後に取り残された editing popover / conflict draft /
        // mergePrompt / pending replay が残らないように。
        resetEntriesDependentState();
        toast(`読み込みに失敗しました: ${msg}`, "error");
        return null;
      } finally {
        // spinner 解放の前に in-flight フラグをクリアし、await 中に scheduled された silent recheck が
        // 次の microtask で stale フラグを見ずに進めるように。
        if (myLoadToken === loadingTokenRef.current) {
          initialLoadInFlightRef.current = false;
          setLoading(false);
        }
      }
    },
    [
      requestGenRef,
      loadingTokenRef,
      initialLoadInFlightRef,
      setLoading,
      setError,
      setLoadResult,
      resetEntriesDependentState,
      toast,
    ],
  );

  // 親に sidecar が無いとき成功 Load 後に走る。まず子 sidecar のマージ (一度きりの移行) を探し、
  // 無ければ「空 sidecar を作る?」confirm。folder picker と mount auto-load 両方が使うので、
  // session 復元 folder も merge prompt を得る (でないと再起動で移行を silent に飛ばす)。
  const postLoadFlow = useCallback(
    async (path: string, res: classification.LoadResult) => {
      if (res.hasSidecar) return;
      // 下の各 await 点は user が folder を切り替える窓。guard が無いと旧 folder の merge prompt /
      // "create sidecar?" confirm を新 folder の UI に出してしまう (頼んでいない prompt = UX バグ)。
      // 末尾の CreateEmptyClassification / loadInternal は user が path に対して元々頼んだ disk 操作
      // なので走らせてよい — stale check が要るのは state を UI に出す部分 (setMergePrompt / confirm) だけ。
      let preview: classification.MergePreview | null = null;
      try {
        preview = await PreviewChildSidecars(path);
      } catch {
        preview = null;
      }
      if (folderRef.current !== path) return;
      if (preview && preview.hasNonTrivial) {
        setMergePrompt({ open: true, preview, folderPath: path });
        return;
      }
      const create = await confirm(
        "サイドカー (_classification.json) がありません。\n新規作成しますか?",
      );
      if (folderRef.current !== path) return;
      if (!create) return;
      try {
        await CreateEmptyClassification(path);
      } catch (e) {
        if (folderRef.current === path) {
          toast(`サイドカー作成に失敗しました: ${errorMessage(e)}`, "error");
        }
        return;
      }
      // 末尾 reload の前に folder check: loadInternal は gen-aware で新 openFolder の bump により
      // 自身を stale にするが、旧 folder に対して IPC を出してはいる。state が動いていれば skip して
      // 無駄な Load を省き gen-bump タイミングとの race も防ぐ。
      if (folderRef.current !== path) return;
      await loadInternal(path);
    },
    [confirm, folderRef, loadInternal, setMergePrompt, toast],
  );

  // session から folderPath が復元されたら mount で auto-load。同じ merge / create-empty 判定も
  // 走らせ、再起動後に folder を選び直さず移行 prompt を出す。ref は postLoadFlow (user-facing prompt) を
  // 副作用点で guard し、StrictMode の dev 二重 mount が confirm() を 2 度 queue しないように。
  // effect 入口に guard を置くと *両方* の run が抑止される (1 本目は cancelled で殺され、2 本目は
  // 作業前に early-return する)。
  const autoLoadFlowedRef = useRef(false);
  useEffect(() => {
    if (!initFolderPath) return;
    let cancelled = false;
    (async () => {
      const res = await loadInternal(initFolderPath);
      if (cancelled || !res) return;
      if (autoLoadFlowedRef.current) return;
      autoLoadFlowedRef.current = true;
      await postLoadFlow(initFolderPath, res);
    })();
    return () => {
      cancelled = true;
    };
    // mount 時のみ実行する意図。initFolderPath は hook 構築時に捕捉した定数。
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
    if (!picked) return; // ユーザーがキャンセル
    // state 更新の前に folderRef を同期更新し、旧 folder の in-flight watcher event が handler の
    // "payload.folder === folderRef.current" で弾かれるように (setFolderPath() と次 render の隙間で
    // すり抜けないように)。
    folderRef.current = picked;
    setFolderPath(picked);
    // folder 変更は選択だけでなく entries 依存 state を全て無効化する — 旧 folder のファイルを
    // 指す editing は新 folder に同名があれば popover を復活させ、conflict / mergePrompt /
    // pendingResultRef も stale な folder pointer を持つ。resetEntriesDependentState が一括処理する。
    resetEntriesDependentState();
    const res = await loadInternal(picked);
    // loadInternal は error だけでなく stale (新 Load が supersede) でも null。どちらでも
    // postLoadFlow の merge / create-empty prompt を supersede 済み folder に走らせない。
    if (!res) return;
    await postLoadFlow(picked, res);
  }, [
    folderRef,
    loadInternal,
    postLoadFlow,
    resetEntriesDependentState,
    setFolderPath,
    toast,
  ]);

  const reload = useCallback(async () => {
    const cur = folderRef.current;
    if (!cur) return;
    await loadInternal(cur);
    // watcher reconcile も蹴る: 前の root が消えた (Go 側 loop は抜けたが次の Start まで
    // Manager.state が zombie) 場合、folderPath/watchMode が変わらないので folder-watch effect は
    // 自発的に再発火しない。ここで dispatch すると、folder を作り直して "再読み込み" を押した user が
    // auto-monitoring も復旧できる。Manager.Start の zombie 検出が dead state を tear down し新 watcher を建てる。
    dispatchWatchIntentRef.current();
  }, [dispatchWatchIntentRef, folderRef, loadInternal]);

  return { openFolder, reload, loadInternal };
}
