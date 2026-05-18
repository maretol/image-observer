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
  // loadInternal is exposed so merge / delete hooks can reuse the same
  // generation-aware Load IPC wrapper instead of calling LoadClassification
  // raw (which would bypass requestGenRef / loadingTokenRef bookkeeping and
  // re-introduce the order-of-arrival hazards that PR #75 closed).
  loadInternal: (path: string) => Promise<classification.LoadResult | null>;
};

type Props = {
  initFolderPath: string;
  // shared refs (read & write)
  folderRef: React.MutableRefObject<string>;
  requestGenRef: React.MutableRefObject<number>;
  loadingTokenRef: React.MutableRefObject<number>;
  initialLoadInFlightRef: React.MutableRefObject<boolean>;
  // dispatchWatchIntentRef is owned by the watcher hook but read here so
  // reload() can kick a watcher reconciliation when the user manually
  // re-reads the folder (= a previously-vanished root coming back gets the
  // auto-watcher re-armed without the user toggling settings).
  dispatchWatchIntentRef: React.MutableRefObject<() => void>;
  // setters
  setFolderPath: (path: string) => void;
  setLoadResult: React.Dispatch<
    React.SetStateAction<classification.LoadResult | null>
  >;
  setLoading: (loading: boolean) => void;
  setError: (msg: string | null) => void;
  setMergePrompt: (state: MergePromptState) => void;
  // collaborators
  resetEntriesDependentState: () => void;
  confirm: ConfirmFn;
  toast: ToastFn;
};

// useClassificationLoad owns the path that fetches the sidecar from disk
// and the "what to do if there is no sidecar yet?" prompt chain. Wraps
// LoadClassification with the shared requestGenRef / loadingTokenRef
// generation tokens so out-of-order completions across watcher / replay /
// silent-recheck paths cannot roll back a newer result.
//
// See AGENTS.md §H-8 for the race variable matrix. This hook is the
// canonical home for the `loadingTokenRef` (only bumped here) and the
// `initialLoadInFlightRef` (used by watcher silent-recheck to defer until
// the initial load commits).
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
        // Stale → return null so callers (openFolder / autoLoad) skip
        // postLoadFlow against a now-superseded folder. Returning the
        // success result let the caller's downstream side-effects fire
        // against the wrong folder (PR #75 review thread #1).
        if (myGen !== requestGenRef.current) return null;
        setLoadResult(res);
        return res;
      } catch (e) {
        if (myGen !== requestGenRef.current) return null;
        const msg = errorMessage(e);
        setError(msg);
        setLoadResult(null);
        // Clear entries-dependent state so a stranded editing popover /
        // conflict draft / mergePrompt / pending replay doesn't survive
        // the load failure (PR #75 13th, thread A).
        resetEntriesDependentState();
        toast(`読み込みに失敗しました: ${msg}`, "error");
        return null;
      } finally {
        // Clear the in-flight flag before the spinner release so any
        // silent recheck scheduled while we were awaiting can proceed
        // on the next microtask without seeing a stale flag.
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

  // postLoadFlow runs after a successful Load when the parent has no sidecar.
  // It first looks for child sidecars to merge (one-time migration path) and
  // falls back to the "create empty sidecar?" confirm. Used by both the
  // explicit folder picker and the auto-load on mount, so a session-restored
  // folder also gets the merge prompt — without this, picking a folder once
  // and then restarting the app would silently bypass the migration.
  const postLoadFlow = useCallback(
    async (path: string, res: classification.LoadResult) => {
      if (res.hasSidecar) return;
      // Each await point below is a potential window for the user to
      // switch folders. Without these guards we'd surface the OLD
      // folder's merge prompt / "create sidecar?" confirm against the
      // NEW folder's UI (a real UX bug — the user sees a prompt they
      // never asked for) (PR #75 12th preemptive, postLoadFlow stale
      // check). The CreateEmptyClassification / loadInternal at the end
      // still run because they're disk-level operations the user
      // originally requested on `path` — only the user-facing surfacing
      // of state (setMergePrompt / confirm) needs the stale check.
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
      // Folder check before the trailing reload: even though loadInternal
      // is gen-aware and would mark itself stale via the new openFolder's
      // bump, we still issued an IPC for the OLD folder. Skipping it when
      // state has moved on saves a wasted Load and prevents any race with
      // the gen-bump timing (PR #75 14th, thread C).
      if (folderRef.current !== path) return;
      await loadInternal(path);
    },
    [confirm, folderRef, loadInternal, setMergePrompt, toast],
  );

  // Auto-load on mount if a folderPath was restored from session. Also runs
  // the same merge / create-empty decision tree so the user does not need to
  // re-pick the folder to see the migration prompt after an app restart.
  // The ref guards postLoadFlow (the user-facing prompt) at the side-effect
  // point so StrictMode's dev double-mount cannot queue confirm() twice.
  // Putting the guard at the effect entry instead would suppress *both* runs:
  // the first async would be killed by `cancelled` (set by the immediate
  // cleanup), and the second would early-return before starting any work.
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
    // Sync folderRef synchronously before triggering the state update so
    // any in-flight watcher event for the OLD folder is rejected by the
    // handler's "payload.folder === folderRef.current" check, instead of
    // sneaking through during the gap between setFolderPath() and the
    // next render (PR #75 review).
    folderRef.current = picked;
    setFolderPath(picked);
    // Folder change invalidates ALL entries-dependent state, not just
    // selection — editing pointing at an OLD-folder file would re-surface
    // its popover if the NEW folder happens to contain a same-named file,
    // conflict / mergePrompt / pendingResultRef likewise carry stale
    // folder pointers (PR #75 14th, thread A). resetEntriesDependentState
    // covers selection + anchor + all of the above in one call.
    resetEntriesDependentState();
    const res = await loadInternal(picked);
    // loadInternal returns null on stale (a newer Load superseded us) as
    // well as on error. In both cases the postLoadFlow's merge / create-
    // empty prompts must not run against an already-superseded folder
    // (PR #75 review thread #1).
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
    // Also kick the watcher reconciliation: if a previous root vanished
    // (the Go-side loop exited but Manager.state went zombie until the
    // next Start), the folder-watch effect won't re-fire on its own
    // because folderPath/watchMode didn't change. Dispatching here
    // bridges that gap so a user pressing "再読み込み" after recreating
    // the folder also restores auto-monitoring. Manager.Start's
    // goroutineExited zombie-detection then tears down the dead state
    // and builds a fresh watcher (PR #75 11th, thread B).
    dispatchWatchIntentRef.current();
  }, [dispatchWatchIntentRef, folderRef, loadInternal]);

  return { openFolder, reload, loadInternal };
}
