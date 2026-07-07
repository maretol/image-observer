import { useCallback } from "react";
import { UpdateClassificationEntry } from "../../../wailsjs/go/main/App";
import { classification } from "../../../wailsjs/go/models";
import type { ToastFn } from "../../shared/components/Toast";
import { errorMessage } from "../../shared/utils/error";
import { logger } from "../../shared/utils/logger";
import type { ConflictPrompt, EditingState } from "./useClassification";

// Go 側 SaveJSON が expectedMtime 不一致で返す sentinel (internal/classification/
// service.go の ErrConflict)。startsWith で比較し、suffix に実 mtime 詳細を載せる。
const CONFLICT_PREFIX = "CONFLICT:";

// save を capture した folder を運ぶ (#110 C)。saveEdit は live folderRef でなく
// ctx.folder で gate するので、folder 切替後に発火する save-on-unmount cleanup
// (snapshot は旧 folder のもの) が skip される。mtime はあえて運ばない — saveEdit が
// loadResultRef から都度読むので queue replay は進んだ値を使う
// (spec-edit-autosave-testing.md §4.2 / §11 D-2 a)。
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
  // render 時同期される loadResult のミラー (useClassification.ts)。saveEdit は
  // useCallback closure でキャプチャせず *呼び出し時* に .current.mtime を読むので、
  // unmount 済み SampleEditPane が持つ stale saveEdit (in-flight save の setLoadResult
  // commit 後に queue auto-save が replay) でも最新 mtime を拾う。これが無いと queue
  // save が save 前 mtime で replay して Go の expectedMtime CONFLICT を踏む。
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

// per-entry の edit / save / conflict 解決チェーン。saveEdit と resolveConflictForce は
// どちらも「ディスク書き込み直後に requestGenRef を bump し、mutation 前に始まった
// in-flight Load を setLoadResult 到達前に stale 破棄する」パターンに従う (AGENTS.md §H-8)。
// await 後の各 commit で folder check (folderRef.current !== cur) し、await 中に folder を
// 切り替えても旧 folder の mutation が新 folder state を壊さないようにする。
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
      // IPC 前の folder gate (#110 C)。save の対象は ctx.folder (snapshot capture 時に
      // active だった folder を明示的に運ぶ)。以降に folder を切り替えていたら (旧 folder
      // の snapshot を持つ save-on-unmount cleanup) ディスクに触れず skip。先頭の
      // !ctx.folder は旧 if (!cur) ガードを兼ねた防御。
      if (!ctx.folder || folderRef.current !== ctx.folder) return;
      // live mtime を ref から読み、unmount 済み SampleEditPane が持つ saveEdit closure
      // (in-flight 成功後の queue auto-save replay) でも最新 mtime を送る。これが無いと
      // queue IPC が save 前 mtime を運んで Go の expectedMtime CONFLICT を踏む。gate を
      // 通ったので loadResultRef は ctx.folder を追う。
      const lr = loadResultRef.current;
      if (!lr) return;
      try {
        const out = await UpdateClassificationEntry(
          ctx.folder,
          entry,
          lr.mtime,
        );
        // state commit 前に folder check — UpdateEntry のディスク書き込みは ctx.folder
        // に対して完走してよいが、旧 folder の mtime / entry で新 folder の loadResult を
        // patch すると壊れる。await 中に folder 切替なら local commit を丸ごと skip
        // (旧 folder の save はディスク上成功しており、次に開けば通常経路で Load される)。
        if (folderRef.current !== ctx.folder) return;
        // local state を patch する前に共有 generation を bump し、save 完了前に始まった
        // watcher / replay / silent-recheck / manual reload の Load を stale にして
        // setLoadResult を skip させる。これが無いと save 前 Load の out-of-order 返却が
        // ユーザーの編集を見た目上巻き戻す。
        ++requestGenRef.current;
        // full reload 無しで grid を更新するため loadResult を local patch。
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
          // LoadResult の prototype を保ち method を使えるように。
          const updated = classification.LoadResult.createFrom({
            ...prev,
            entries: newEntries,
            mtime: out.mtime,
          });
          return updated;
        });
        setEditing({ open: false, filename: null });
      } catch (e) {
        // 成功経路と同じ folder check — 新 folder にいるのに旧 folder の conflict /
        // error toast を出すのは紛らわしいため。
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
      // state commit 前に folder check — 旧 folder の mutation 結果で新 folder state を
      // patch するのは saveEdit と同じ UX バグ。
      if (folderRef.current !== cur) return;
      // ディスク書き込み直後に gen bump し、強制上書き前に始まった in-flight watcher /
      // replay / silent-recheck Load を stale にする — これが無いと
      // UpdateClassificationEntry 返却と reload() の bump の間に flicker 窓ができ、
      // 書き込み前 Load が上書き前 state を一瞬 commit しうる (saveEdit / deleteOne と同じ)。
      ++requestGenRef.current;
      setConflict(null);
      setEditing({ open: false, filename: null });
      // ディスクの真値で refresh し、他の外部変更も拾う。
      await reload();
      // out.mtime は reload が捕捉するのでここでは何もしなくてよい。
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
    // draft をコピーできるよう編集 popover は開いたままにする。
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
